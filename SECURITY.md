# Security

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub: **Security → Report a vulnerability** on this repository. Do not open a public issue. I aim to respond within a week.

## Threat model

Each deployment serves exactly one owner. It holds a YNAB personal access token with full read/write access to the owner's YNAB account, so the goal is that nobody but the owner can use the server.

| Threat | Mitigation |
| --- | --- |
| Someone finds the server URL | Every `/mcp` request needs an OAuth access token. Tokens are only issued after the owner password is entered on the login page. |
| Password guessing | Minimum length of 16 characters, enforced at runtime. Attempts are limited to 5 per minute per IP (Workers Rate Limiting) and 20 per 15 minutes across all IPs (a KV counter), with constant-time comparison. `bun run setup` generates a password of about 140 bits. |
| Phishing: a link that registers its own OAuth client | Codes are only issued to redirect hosts in `ALLOWED_REDIRECT_HOSTS` (Claude, ChatGPT, localhost by default). The login page shows the app name and the redirect origin. |
| CSRF or clickjacking on the login page | Double-submit CSRF token in a `__Host-` cookie, `SameSite=Lax`. `frame-ancestors 'none'`, `X-Frame-Options: DENY`. |
| XSS from client-supplied metadata | All client metadata is HTML-escaped. The CSP allows no scripts. |
| Stolen access or refresh token | Access tokens expire after 1 hour. Refresh tokens rotate on use and expire after 30 days idle. Tokens are bound to this server's `/mcp` resource (RFC 8707) and stored only as hashes. `bun run rotate-password` revokes every grant immediately. |
| A connected app doing more than intended | The owner picks read-only or read/write per app at login. `YNAB_READ_ONLY=true` enforces read-only globally. Destructive tools are annotated so clients can ask for confirmation. |
| Injection into YNAB API paths | IDs, dates and months are validated with strict patterns and path segments are URL-encoded. |
| Leaked secrets | The YNAB token and owner password are Cloudflare secrets. Neither is logged, returned by any tool, or committed to the repository (`.dev.vars` is git-ignored). |

## Out of scope

- A compromised Cloudflare account, or a compromised device where the owner is signed in to Claude or ChatGPT.
- Prompt injection through data already in the owner's YNAB account, such as a malicious payee name or memo. MCP clients are responsible for confirming actions. Using read-only access where possible limits the impact.
- YNAB's own API rate limit of 200 requests per hour.

## Operating it securely

- Keep the owner password in a password manager and don't reuse it anywhere.
- Rotate it with `bun run rotate-password` if you think it leaked. Every connected app has to reconnect.
- If the YNAB token leaks, revoke it in YNAB's Developer Settings and run `bun run set-ynab-token`.
- Keep dependencies current. Dependabot is configured for this repository.
