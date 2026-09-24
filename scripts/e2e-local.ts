#!/usr/bin/env bun
/**
 * End-to-end check of the OAuth + MCP flow against a running dev server.
 *
 *   bun run dev                       # in another terminal, with .dev.vars filled in
 *   PW=<OWNER_PASSWORD> bun scripts/e2e-local.ts
 *
 * Registers throwaway clients, logs in (read/write and read-only), lists tools,
 * and checks CSRF, wrong-password, deny and redirect-allowlist handling.
 */
const BASE = process.env.BASE ?? "http://localhost:8787";
const PASSWORD = process.env.PW ?? "";
if (!PASSWORD) throw new Error("Set PW to the OWNER_PASSWORD from .dev.vars");

function b64url(buf: ArrayBuffer | Uint8Array) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function register(redirect: string) {
  const r = await fetch(`${BASE}/oauth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ redirect_uris: [redirect], client_name: "E2E <b>Test</b>", token_endpoint_auth_method: "none" }),
  });
  const j: any = await r.json();
  console.log("register", r.status, j.client_id ? "ok" : j);
  return j.client_id as string;
}

async function authorizeUrl(clientId: string, redirect: string) {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  const u = new URL(`${BASE}/authorize`);
  u.search = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirect,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "st123",
    resource: `${BASE}/mcp`,
  }).toString();
  return { url: u.toString(), verifier };
}

async function getForm(url: string) {
  const r = await fetch(url, { redirect: "manual" });
  const html = await r.text();
  const cookie = (r.headers.get("set-cookie") ?? "").split(";")[0]!;
  const csrf = /name="csrf_token" value="([^"]+)"/.exec(html)?.[1];
  return { status: r.status, html, cookie, csrf, csp: r.headers.get("content-security-policy") };
}

async function post(url: string, cookie: string, fields: Record<string, string>) {
  return fetch(url, {
    method: "POST",
    redirect: "manual",
    headers: { Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded", "CF-Connecting-IP": `203.0.113.${Math.floor(Math.random() * 250)}` },
    body: new URLSearchParams(fields).toString(),
  });
}

async function login(canWrite: boolean) {
  const redirect = "http://localhost:9999/callback";
  const clientId = await register(redirect);
  const { url, verifier } = await authorizeUrl(clientId, redirect);
  const form = await getForm(url);
  console.log("GET authorize", form.status, "csrf?", !!form.csrf, "escaped name?", form.html.includes("E2E &lt;b&gt;Test"), "csp:", form.csp);

  const bad = await post(url, form.cookie, { csrf_token: form.csrf!, password: "wrong", decision: "approve" });
  console.log("wrong password ->", bad.status);
  const noCsrf = await post(url, form.cookie, { csrf_token: "nope", password: PASSWORD, decision: "approve" });
  console.log("bad csrf ->", noCsrf.status);

  const form2 = await getForm(url);
  const fields: Record<string, string> = { csrf_token: form2.csrf!, password: PASSWORD, decision: "approve" };
  if (canWrite) fields.allow_write = "1";
  const ok = await post(url, form2.cookie, fields);
  const loc = new URL(ok.headers.get("location")!);
  console.log("approve ->", ok.status, loc.origin + loc.pathname, "state", loc.searchParams.get("state"), "iss", loc.searchParams.get("iss"));
  const code = loc.searchParams.get("code")!;

  const tok = await fetch(`${BASE}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirect,
      client_id: clientId,
      code_verifier: verifier,
      resource: `${BASE}/mcp`,
    }).toString(),
  });
  const tj: any = await tok.json();
  console.log("token", tok.status, tj.token_type, "scope:", tj.scope, "refresh?", !!tj.refresh_token);
  return tj.access_token as string;
}

async function rpc(token: string, method: string, params: unknown, id = 1) {
  const r = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2025-06-18",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  const text = await r.text();
  const data = text.startsWith("{") ? text : (text.split("\n").find((l) => l.startsWith("data:"))?.slice(5) ?? text);
  try {
    return { status: r.status, body: JSON.parse(data) };
  } catch {
    return { status: r.status, body: text };
  }
}

for (const canWrite of [true, false]) {
  console.log(`\n=== canWrite=${canWrite} ===`);
  const token = await login(canWrite);
  const init = await rpc(token, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "e2e", version: "1" },
  });
  console.log("initialize", init.status, init.body?.result?.serverInfo, "instructions?", !!init.body?.result?.instructions);
  const list = await rpc(token, "tools/list", {}, 2);
  const names = list.body?.result?.tools?.map((t: any) => t.name);
  console.log("tools", list.status, names?.length, names?.join(","));
  const call = await rpc(token, "tools/call", { name: "list_accounts", arguments: {} }, 3);
  console.log("call list_accounts", call.status, JSON.stringify(call.body?.result ?? call.body).slice(0, 200));
  const badArgs = await rpc(token, "tools/call", { name: "get_transaction", arguments: { transaction_id: "../../user" } }, 4);
  console.log("path traversal attempt", JSON.stringify(badArgs.body?.result ?? badArgs.body).slice(0, 200));
}

// Deny + disallowed redirect
const evil = "https://evil.example/cb";
const evilClient = await register(evil);
const { url: evilUrl } = await authorizeUrl(evilClient, evil);
const evilForm = await getForm(evilUrl);
console.log("\ndisallowed redirect ->", evilForm.status, evilForm.html.includes("not in ALLOWED_REDIRECT_HOSTS"));

const redirect = "http://127.0.0.1:5555/cb";
const c = await register(redirect);
const { url } = await authorizeUrl(c, redirect);
const f = await getForm(url);
const deny = await post(url, f.cookie, { csrf_token: f.csrf!, decision: "deny" });
console.log("deny ->", deny.status, deny.headers.get("location"));

const noAuth = await fetch(`${BASE}/mcp`, { method: "POST" });
console.log("no token ->", noAuth.status);
const badTok = await rpc("garbage", "tools/list", {});
console.log("bad token ->", badTok.status);
