# YNAB MCP Server

A self-hosted [Model Context Protocol](https://modelcontextprotocol.io) server that connects **Claude** and **ChatGPT** to your [YNAB](https://www.ynab.com) budget. It runs on your own Cloudflare account, on the free Workers plan, and only you can sign in to it.

Ask things like:

- "How much is left in Groceries this month?"
- "Categorize my unapproved transactions and approve them."
- "Move $50 from Dining Out to Groceries."
- "What did I spend on Amazon in the last 3 months?"
- "Add a $12.50 coffee at Blue Bottle on my credit card."

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Jonah-Lam/ynab-mcp-server)

## How it works

```
Claude / ChatGPT ──OAuth 2.1──▶ Your Cloudflare Worker ──YNAB token──▶ api.ynab.com
                                 │
                                 └─ login page: your owner password
```

- The Worker is an OAuth 2.1 authorization server and an MCP server (Streamable HTTP at `/mcp`).
- When you add it as a connector, Claude or ChatGPT sends you to the Worker's login page. You enter **your owner password** and choose whether that app may make changes.
- Your YNAB personal access token stays in a Cloudflare secret. It is never sent to Claude or ChatGPT.

## Deploy

You need a free [Cloudflare account](https://dash.cloudflare.com/sign-up) and a YNAB account.

### Option A: one command (recommended)

Requires [Bun](https://bun.sh).

```bash
git clone https://github.com/Jonah-Lam/ynab-mcp-server.git
cd ynab-mcp-server
bun install
bun run setup
```

`setup` logs you in to Cloudflare if needed, checks your YNAB token, generates an owner password, deploys the Worker, and prints your server URL. Save the password in your password manager.

### Option B: Deploy button

Click **Deploy to Cloudflare** above. When asked for secrets, enter:

| Secret | Value |
| --- | --- |
| `YNAB_ACCESS_TOKEN` | A personal access token from [YNAB → Settings → Developer Settings](https://app.ynab.com/settings/developer) |
| `OWNER_PASSWORD` | A random password of at least 16 characters. Generate it with a password manager. |

### Option C: manually

```bash
bun install
bunx wrangler login
bunx wrangler deploy
bunx wrangler secret put YNAB_ACCESS_TOKEN
bunx wrangler secret put OWNER_PASSWORD
```

## Connect

Your server URL is `https://ynab-mcp.<your-subdomain>.workers.dev/mcp`.

**Claude** (claude.ai, Desktop, mobile): Settings → Connectors → **Add custom connector** → paste the URL → Connect. Custom connectors are available on paid Claude plans.

**Claude Code**:

```bash
claude mcp add --transport http ynab https://ynab-mcp.<your-subdomain>.workers.dev/mcp
```

Then run `/mcp` in Claude Code to sign in.

**ChatGPT**: Settings → Apps & Connectors → Advanced settings → turn on **Developer mode**, then create a connector with the URL and OAuth authentication. Menu names change often; see OpenAI's guide to [connecting from ChatGPT](https://developers.openai.com/apps-sdk/deploy/connect-chatgpt) if they differ.

When the login page opens, check that the app name and the "Sends you back to" address are what you expect, enter your owner password, and choose whether to **allow changes**.

## Tools

All amounts are in your plan's currency (e.g. `-42.50`), not YNAB milliunits. Negative means money going out. Every tool takes an optional `plan_id` and defaults to your last-used plan.

| Tool | What it does |
| --- | --- |
| `list_plans` | Your plans (budgets) and their currencies |
| `list_accounts` | Accounts and balances |
| `get_budget_month` | Ready to Assign, and every category's assigned, activity, available and target for a month |
| `list_months` | Month-by-month income, spending and Ready to Assign |
| `list_payees` | Payees, optionally filtered by name |
| `list_transactions` | Transactions filtered by account, category, payee, month, dates, text, or unapproved/uncategorized |
| `get_transaction` | One transaction, including splits |
| `list_scheduled_transactions` | Upcoming and recurring transactions |
| `list_money_movements` | Money moved between categories in a month |
| `search`, `fetch` | Search across accounts, categories, payees and recent transactions (the shape ChatGPT deep research uses) |

These tools are only available when you allowed changes at login and the server isn't in read-only mode:

| Tool | What it does |
| --- | --- |
| `create_transactions` | Add transactions, including splits and transfers |
| `update_transactions` | Categorize, approve, or edit transactions in bulk |
| `delete_transaction` | Delete a transaction |
| `set_category_assigned` | Set a category's assigned amount for a month |
| `move_money` | Move assigned money between categories or to/from Ready to Assign |
| `update_category`, `create_category` | Rename, add notes, set targets, create categories |
| `rename_payee` | Rename a payee |
| `create_scheduled_transaction`, `delete_scheduled_transaction` | Manage scheduled transactions |

Tools carry MCP annotations (`readOnlyHint`, `destructiveHint`), so Claude and ChatGPT can ask before running anything that changes your budget.

## Configuration

Set these in `wrangler.jsonc` under `vars`, or in the Cloudflare dashboard under your Worker's **Settings → Variables**.

| Variable | Default | Purpose |
| --- | --- | --- |
| `YNAB_READ_ONLY` | `false` | `true` hides every write tool, whatever was chosen at login |
| `YNAB_DEFAULT_PLAN_ID` | `last-used` | Plan used when a tool call does not name one |
| `ALLOWED_REDIRECT_HOSTS` | Claude, ChatGPT, localhost | Hostnames that may receive a login code. Add a host to use another MCP client, or `*` to allow any |
| `PUBLIC_URL` | request origin | Set when serving from a custom domain, e.g. `https://ynab.example.com` |

## Security

Only someone who knows your owner password can connect an app.

- **OAuth 2.1 with PKCE**, using Cloudflare's [`workers-oauth-provider`](https://github.com/cloudflare/workers-oauth-provider). Access tokens last one hour. Refresh tokens expire after 30 days without use. Tokens are stored only as hashes.
- **Login page**: CSRF-protected, constant-time password comparison, a limit of 5 attempts per minute per IP, and a lockout after 20 failed attempts in 15 minutes across all IPs. Strict CSP, no JavaScript, and it cannot be framed.
- **Redirect allowlist**: login codes are only sent to Claude, ChatGPT, or localhost by default. A phishing link that registers its own app with some other redirect gets refused before the password prompt.
- **Least privilege**: at login you choose read-only or read/write access for that app. `YNAB_READ_ONLY=true` enforces read-only for the whole server.
- **Revoke everything**: `bun run rotate-password` sets a new owner password and signs out every connected app immediately.
- **Input validation**: every ID and date is checked before any call to YNAB.

See [SECURITY.md](SECURITY.md) for the threat model and how to report a vulnerability.

### Limits to know about

- YNAB allows 200 API requests per hour per token.
- A YNAB personal access token gives full access to every plan in your account. Anyone who knows your owner password can use it through this server, so treat the password like a bank password.

## Development

```bash
cp .dev.vars.example .dev.vars   # fill in a token and a test password
bun run dev                      # http://localhost:8787/mcp
bun test                         # unit tests (YNAB API is faked)
bun run check                    # typecheck + tests + build
```

Try it with the [MCP Inspector](https://github.com/modelcontextprotocol/inspector): `bunx @modelcontextprotocol/inspector`, then connect to `http://localhost:8787/mcp`.

Project layout:

```
src/index.ts          Worker entry: OAuth provider + MCP handler
src/auth.ts           Login and consent page logic
src/pages.ts          HTML for the login page
src/security.ts       CSRF, constant-time compare, redirect allowlist
src/mcp/              MCP server and tools
src/ynab/             YNAB API client, types, formatting
scripts/setup.ts      Interactive deploy helper
```

## License

[MIT](LICENSE). Not affiliated with or endorsed by YNAB.
