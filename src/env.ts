import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

export interface Env {
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: OAuthHelpers;
  LOGIN_LIMITER?: RateLimit;

  YNAB_ACCESS_TOKEN: string;
  OWNER_PASSWORD: string;

  YNAB_READ_ONLY?: string;
  YNAB_DEFAULT_PLAN_ID?: string;
  ALLOWED_REDIRECT_HOSTS?: string;
  /** Optional canonical public URL (e.g. https://ynab.example.com). Defaults to the request origin. */
  PUBLIC_URL?: string;
}

/** Stored (encrypted) with every grant; available to the MCP handler as ctx.props. */
export interface AuthProps {
  userId: "owner";
  /** Whether the owner allowed write tools for this client at login. */
  canWrite: boolean;
  /** Fingerprint of OWNER_PASSWORD at login time. Rotating the password invalidates old grants. */
  passwordFingerprint: string;
  [key: string]: unknown;
}

export const MIN_PASSWORD_LENGTH = 16;
