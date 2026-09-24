import { AuthorizationError, type AuthRequest } from "@cloudflare/workers-oauth-provider";
import { type AuthProps, type Env, MIN_PASSWORD_LENGTH } from "./env";
import { consentPage, messagePage } from "./pages";
import {
  getCookie,
  isRedirectAllowed,
  parseAllowedHosts,
  passwordFingerprint,
  randomToken,
  safeEqual,
} from "./security";

const CSRF_COOKIE = "__Host-ynab_mcp_csrf";
const CSRF_TTL_SECONDS = 600;

/** Failed password attempts allowed across all IPs per window before login is locked. */
const GLOBAL_FAILURE_LIMIT = 20;
const GLOBAL_WINDOW_SECONDS = 15 * 60;

export function isReadOnly(env: Env): boolean {
  return (env.YNAB_READ_ONLY ?? "").trim().toLowerCase() === "true";
}

function csrfCookie(token: string, maxAge = CSRF_TTL_SECONDS): string {
  return `${CSRF_COOKIE}=${token}; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=${maxAge}`;
}

function errorRedirect(redirectUri: string, code: string, description: string, oauthReq: { state?: string; issuer?: string }) {
  const url = new URL(redirectUri);
  url.searchParams.set("error", code);
  url.searchParams.set("error_description", description);
  if (oauthReq.state) url.searchParams.set("state", oauthReq.state);
  if (oauthReq.issuer) url.searchParams.set("iss", oauthReq.issuer);
  return Response.redirect(url.toString(), 302);
}

function globalFailureKey(): string {
  return `login-failures:${Math.floor(Date.now() / 1000 / GLOBAL_WINDOW_SECONDS)}`;
}

async function isGloballyLocked(env: Env): Promise<boolean> {
  const count = Number((await env.OAUTH_KV.get(globalFailureKey())) ?? "0");
  return count >= GLOBAL_FAILURE_LIMIT;
}

async function recordFailure(env: Env): Promise<void> {
  const key = globalFailureKey();
  const count = Number((await env.OAUTH_KV.get(key)) ?? "0");
  await env.OAUTH_KV.put(key, String(count + 1), { expirationTtl: GLOBAL_WINDOW_SECONDS * 2 });
}

/** Handles GET/POST /authorize: owner password check and consent. */
export async function handleAuthorize(request: Request, env: Env): Promise<Response> {
  if (request.method !== "GET" && request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET, POST" } });
  }

  if (!env.OWNER_PASSWORD || env.OWNER_PASSWORD.length < MIN_PASSWORD_LENGTH) {
    return messagePage(
      "Server not configured",
      `The OWNER_PASSWORD secret is missing or shorter than ${MIN_PASSWORD_LENGTH} characters. Set it with "bunx wrangler secret put OWNER_PASSWORD".`,
      500,
    );
  }
  if (!env.YNAB_ACCESS_TOKEN) {
    return messagePage("Server not configured", 'The YNAB_ACCESS_TOKEN secret is missing. Set it with "bunx wrangler secret put YNAB_ACCESS_TOKEN".', 500);
  }

  let oauthReq: AuthRequest;
  try {
    oauthReq = await env.OAUTH_PROVIDER.parseAuthRequest(request);
  } catch (error) {
    if (!(error instanceof AuthorizationError)) throw error;
    if (!error.redirectUri) return messagePage("Invalid request", error.description, 400);
    return errorRedirect(error.redirectUri, error.code, error.description, error);
  }

  const client = await env.OAUTH_PROVIDER.lookupClient(oauthReq.clientId);
  if (!client) return messagePage("Unknown app", "This app is not registered with the server.", 400);

  // Refuse to hand a code to anywhere outside the allowlist. This protects the
  // owner from phishing links that register a client with an attacker's redirect.
  if (!isRedirectAllowed(oauthReq.redirectUri, parseAllowedHosts(env.ALLOWED_REDIRECT_HOSTS))) {
    return messagePage(
      "Redirect not allowed",
      `This app wants to redirect to ${new URL(oauthReq.redirectUri).origin}, which is not in ALLOWED_REDIRECT_HOSTS.`,
      400,
    );
  }

  const url = new URL(request.url);
  const actionUrl = `${url.pathname}${url.search}`;
  const clientName = client.clientName || client.clientUri || oauthReq.clientId;
  const allowWriteOption = !isReadOnly(env);

  const renderForm = (error?: string, status?: number) => {
    const csrfToken = randomToken();
    return consentPage({
      clientName,
      redirectUri: oauthReq.redirectUri,
      actionUrl,
      csrfToken,
      csrfCookie: csrfCookie(csrfToken),
      allowWriteOption,
      error,
      status,
    });
  };

  if (request.method === "GET") return renderForm();

  // POST: validate CSRF token (double-submit cookie).
  const form = await request.formData();
  const formToken = String(form.get("csrf_token") ?? "");
  const cookieToken = getCookie(request, CSRF_COOKIE) ?? "";
  if (!formToken || !cookieToken || !(await safeEqual(formToken, cookieToken))) {
    return renderForm("Your session expired. Please try again.", 400);
  }

  if (form.get("decision") !== "approve") {
    return errorRedirect(oauthReq.redirectUri, "access_denied", "The owner denied the request.", oauthReq);
  }

  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  if (env.LOGIN_LIMITER) {
    const { success } = await env.LOGIN_LIMITER.limit({ key: `login:${ip}` });
    if (!success) return renderForm("Too many attempts. Wait a minute and try again.", 429);
  }
  if (await isGloballyLocked(env)) {
    return renderForm("Login is temporarily locked after too many failed attempts. Try again in 15 minutes.", 429);
  }

  const password = String(form.get("password") ?? "");
  if (!(await safeEqual(password, env.OWNER_PASSWORD))) {
    await recordFailure(env);
    return renderForm("Incorrect password.", 401);
  }

  const canWrite = allowWriteOption && form.get("allow_write") === "1";
  const props: AuthProps = {
    userId: "owner",
    canWrite,
    passwordFingerprint: await passwordFingerprint(env.OWNER_PASSWORD),
  };

  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
    request: oauthReq,
    userId: "owner",
    scope: canWrite ? ["ynab:read", "ynab:write"] : ["ynab:read"],
    metadata: { clientName, grantedAt: new Date().toISOString() },
    props,
  });

  const res = Response.redirect(redirectTo, 302);
  const headers = new Headers(res.headers);
  headers.append("Set-Cookie", csrfCookie("", 0));
  headers.set("Cache-Control", "no-store");
  return new Response(null, { status: 302, headers });
}
