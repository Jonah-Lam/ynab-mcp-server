# Changelog

All notable changes to this project are documented here. Versions follow [Semantic Versioning](https://semver.org).

## [1.0.2] - 2026-09-24

### Security

- With `ALLOWED_REDIRECT_HOSTS="*"`, custom redirect schemes must now be reverse-domain app schemes (e.g. `com.example.app:`). Previously `vbscript:` and `file:` were not rejected. The default configuration was not affected.
- Generated owner passwords now use unbiased random sampling.

## [1.0.1] - 2026-09-24

### Changed

- Settings are now managed in the Cloudflare dashboard and kept across deploys (`keep_vars`). Defaults moved from `wrangler.jsonc` into the code, so updating no longer resets settings or causes merge conflicts in `wrangler.jsonc`.
- An unset or empty `ALLOWED_REDIRECT_HOSTS` now means the default list (Claude, ChatGPT, localhost).

### Added

- README section on updating a deployment.

## [1.0.0] - 2026-09-24

First release.

### Added

- Remote MCP server for YNAB on Cloudflare Workers, compatible with Claude and ChatGPT (Streamable HTTP at `/mcp`).
- Read tools: `list_plans`, `list_accounts`, `get_budget_month`, `list_months`, `list_payees`, `list_transactions`, `get_transaction`, `list_scheduled_transactions`, `list_money_movements`, plus ChatGPT-style `search` and `fetch`.
- Write tools: `create_transactions`, `update_transactions`, `delete_transaction`, `set_category_assigned`, `move_money`, `update_category`, `create_category`, `rename_payee`, `create_scheduled_transaction`, `delete_scheduled_transaction`.
- OAuth 2.1 authorization with an owner-password login page: PKCE, dynamic client registration and client ID metadata documents, CSRF protection, rate limiting, redirect allowlist, and read-only or read/write access chosen per app.
- Rotating the owner password revokes every connected app.
- `YNAB_READ_ONLY`, `YNAB_DEFAULT_PLAN_ID`, `ALLOWED_REDIRECT_HOSTS` and `PUBLIC_URL` configuration.
- `bun run setup`, `rotate-password` and `set-ynab-token` helper scripts, and Deploy to Cloudflare support.
- Plain HTTP requests redirect to HTTPS.

[1.0.2]: https://github.com/Jonah-Lam/ynab-mcp-server/releases/tag/v1.0.2
[1.0.1]: https://github.com/Jonah-Lam/ynab-mcp-server/releases/tag/v1.0.1
[1.0.0]: https://github.com/Jonah-Lam/ynab-mcp-server/releases/tag/v1.0.0
