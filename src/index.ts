import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { createMcpHandler } from "agents/mcp/server";
import { handleAuthorize, isReadOnly } from "./auth";
import type { AuthProps, Env } from "./env";
import { createServer, SERVER_VERSION } from "./mcp/server";
import { passwordFingerprint, safeEqual } from "./security";

const MCP_ROUTE = "/mcp";
const DAY = 86_400;

function unauthorized(description: string): Response {
  return new Response(JSON.stringify({ error: "invalid_token", error_description: description }), {
    status: 401,
    headers: {
      "Content-Type": "application/json",
      "WWW-Authenticate": `Bearer error="invalid_token", error_description="${description}"`,
    },
  });
}

/** Protected MCP endpoint. Only reached with a valid access token; ctx.props holds the grant's AuthProps. */
const apiHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext & { props: AuthProps }): Promise<Response> {
    const props = ctx.props;
    // Grants issued under a previous OWNER_PASSWORD are rejected, so rotating
    // the password signs out every connected client.
    const current = await passwordFingerprint(env.OWNER_PASSWORD ?? "");
    if (!props?.passwordFingerprint || !(await safeEqual(props.passwordFingerprint, current))) {
      return unauthorized("Authorization was revoked. Please reconnect.");
    }
    if (!env.YNAB_ACCESS_TOKEN) {
      return new Response("Server is missing the YNAB_ACCESS_TOKEN secret.", { status: 500 });
    }

    const canWrite = props.canWrite === true && !isReadOnly(env);
    const handler = createMcpHandler(
      () =>
        createServer({
          ynabToken: env.YNAB_ACCESS_TOKEN,
          defaultPlanId: env.YNAB_DEFAULT_PLAN_ID,
          canWrite,
        }),
      { route: MCP_ROUTE },
    );
    return handler(request, env, ctx);
  },
};

/** Unauthenticated routes: the login/consent page and a small landing page. */
const defaultHandler = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/authorize") return handleAuthorize(request, env);
    if (url.pathname === "/") {
      return new Response(
        `YNAB MCP server v${SERVER_VERSION}\n\nAdd ${url.origin}${MCP_ROUTE} as a custom connector in Claude or ChatGPT.\n`,
        { headers: { "Content-Type": "text/plain; charset=utf-8", "X-Robots-Tag": "noindex" } },
      );
    }
    if (url.pathname === "/robots.txt") return new Response("User-agent: *\nDisallow: /\n");
    return new Response("Not found", { status: 404 });
  },
};

const providers = new Map<string, OAuthProvider<Env>>();

/**
 * The OAuth provider binds tokens to one canonical resource URL. Deployments
 * live at different hostnames, so the provider is built per origin: PUBLIC_URL
 * when set, otherwise the origin the request arrived on.
 */
function getProvider(origin: string): OAuthProvider<Env> {
  let provider = providers.get(origin);
  if (!provider) {
    provider = new OAuthProvider<Env>({
      apiRoute: MCP_ROUTE,
      apiHandler: apiHandler as never,
      defaultHandler: defaultHandler as never,
      authorizeEndpoint: "/authorize",
      tokenEndpoint: "/oauth/token",
      clientRegistrationEndpoint: "/oauth/register",
      clientIdMetadataDocumentEnabled: true,
      scopesSupported: ["ynab:read", "ynab:write"],
      resourceMetadata: {
        resource: `${origin}${MCP_ROUTE}`,
        authorization_servers: [origin],
        scopes_supported: ["ynab:read"],
        bearer_methods_supported: ["header"],
        resource_name: "YNAB MCP",
      },
      accessTokenTTL: 3600,
      refreshTokenTTL: 30 * DAY,
      // Stay signed in while the client keeps using the connection.
      refreshTokenIdleTTL: 30 * DAY,
    });
    providers.set(origin, provider);
  }
  return provider;
}

function canonicalOrigin(env: Env, request?: Request): string {
  if (env.PUBLIC_URL) return new URL(env.PUBLIC_URL).origin.toLowerCase();
  if (request) return new URL(request.url).origin.toLowerCase();
  return "https://ynab-mcp.invalid";
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    // OAuth resources must be HTTPS (plain http is only allowed on loopback for `wrangler dev`).
    if (url.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
      url.protocol = "https:";
      return Response.redirect(url.toString(), 301);
    }
    return getProvider(canonicalOrigin(env, request)).fetch(request, env, ctx);
  },
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    await getProvider(canonicalOrigin(env)).purgeExpiredData(env, { batchSize: 100 });
  },
} satisfies ExportedHandler<Env>;
