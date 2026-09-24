# YNAB MCP

Cloudflare Worker serving a YNAB MCP server behind OAuth 2.1. Bun is the package manager and test runner; the Worker itself runs on workerd.

- `bun run check` runs the typecheck, unit tests and a dry-run build. Run it before committing.
- `bun run dev` serves at http://localhost:8787 using `.dev.vars` (see `.dev.vars.example`).
- `bun scripts/e2e-local.ts` runs the full OAuth + MCP flow against `bun run dev`.

Conventions:
- Tool inputs and outputs use currency units. Convert with `toMilli` / `fromMilli` in `src/ynab/format.ts`; never expose milliunits.
- Validate every ID with the schemas in `src/mcp/common.ts` and build API paths with `seg()`.
- Read tools go in `src/mcp/read-tools.ts` with `READ_ONLY` annotations. Anything that changes data goes in `src/mcp/write-tools.ts`, which is only registered for read/write grants.
- YNAB API reference: https://api.ynab.com/papi/open_api_spec.yaml (uses "plans", formerly "budgets").
- Don't import `cloudflare:workers` in modules that tests import; pass `env` explicitly.
