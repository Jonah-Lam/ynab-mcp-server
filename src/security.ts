const encoder = new TextEncoder();

function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(input: string): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", encoder.encode(input)));
}

/**
 * Constant-time string comparison. Both inputs are HMAC'd with a random
 * per-call key so the comparison runs over fixed-length digests and leaks
 * neither content nor length through timing.
 */
export async function safeEqual(a: string, b: string): Promise<boolean> {
  const key = (await crypto.subtle.generateKey({ name: "HMAC", hash: "SHA-256" }, false, ["sign"])) as CryptoKey;
  const [da, db] = await Promise.all([
    crypto.subtle.sign("HMAC", key, encoder.encode(a)),
    crypto.subtle.sign("HMAC", key, encoder.encode(b)),
  ]);
  const x = new Uint8Array(da);
  const y = new Uint8Array(db);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i]! ^ y[i]!;
  return diff === 0;
}

/** Identifies the current owner password without storing it. Used to revoke grants on rotation. */
export function passwordFingerprint(password: string): Promise<string> {
  return sha256Hex(`ynab-mcp:owner-password:v1:${password}`);
}

export function randomToken(bytes = 32): string {
  const buf = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...buf)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function getCookie(request: Request, name: string): string | undefined {
  const header = request.headers.get("Cookie");
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) return part.slice(idx + 1).trim();
  }
  return undefined;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function parseAllowedHosts(value: string | undefined): string[] | "*" {
  const raw = (value ?? "").trim();
  if (raw === "*") return "*";
  return raw
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Whether an OAuth redirect URI may receive an authorization code.
 * An entry matches its exact hostname and any subdomain of it.
 * Plain http is only accepted for loopback hosts.
 */
export function isRedirectAllowed(redirectUri: string, allowed: string[] | "*"): boolean {
  let url: URL;
  try {
    url = new URL(redirectUri);
  } catch {
    return false;
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const loopback = host === "localhost" || host === "127.0.0.1" || host === "::1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    // Custom schemes (e.g. native apps) are only allowed when everything is allowed.
    return allowed === "*" && url.protocol !== "javascript:" && url.protocol !== "data:";
  }
  if (allowed === "*") return true;
  return allowed.some((entry) => host === entry || host.endsWith(`.${entry}`));
}
