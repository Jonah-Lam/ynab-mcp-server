import { describe, expect, test } from "bun:test";
import { fromMilli, normalizeMonth, toMilli } from "../src/ynab/format";
import {
  escapeHtml,
  getCookie,
  isRedirectAllowed,
  parseAllowedHosts,
  passwordFingerprint,
  randomToken,
  safeEqual,
} from "../src/security";

const DEFAULT_HOSTS = parseAllowedHosts("claude.ai,claude.com,chatgpt.com,chat.openai.com,localhost,127.0.0.1");

describe("isRedirectAllowed", () => {
  test.each([
    ["https://claude.ai/api/mcp/auth_callback", true],
    ["https://claude.com/api/mcp/auth_callback", true],
    ["https://chatgpt.com/connector_platform_oauth_redirect", true],
    ["http://localhost:6274/oauth/callback", true],
    ["http://127.0.0.1:33418/callback", true],
    ["https://evil.example/cb", false],
    ["https://claude.ai.evil.example/cb", false],
    ["https://evilclaude.ai/cb", false],
    ["http://claude.ai/cb", false], // plain http only for loopback
    ["javascript:alert(1)", false],
    ["not a url", false],
  ])("%s -> %p", (uri, expected) => {
    expect(isRedirectAllowed(uri, DEFAULT_HOSTS)).toBe(expected);
  });

  test("wildcard allows any https or loopback but never javascript:", () => {
    expect(isRedirectAllowed("https://anything.example/cb", "*")).toBe(true);
    expect(isRedirectAllowed("javascript:alert(1)", "*")).toBe(false);
  });

  test("subdomains of allowed hosts are allowed", () => {
    expect(isRedirectAllowed("https://www.claude.ai/cb", DEFAULT_HOSTS)).toBe(true);
  });
});

describe("helpers", () => {
  test("safeEqual", async () => {
    expect(await safeEqual("correct horse battery", "correct horse battery")).toBe(true);
    expect(await safeEqual("correct horse battery", "correct horse batterx")).toBe(false);
    expect(await safeEqual("short", "a much longer string")).toBe(false);
    expect(await safeEqual("", "")).toBe(true);
  });

  test("passwordFingerprint is stable and password-specific", async () => {
    expect(await passwordFingerprint("a")).toBe(await passwordFingerprint("a"));
    expect(await passwordFingerprint("a")).not.toBe(await passwordFingerprint("b"));
  });

  test("randomToken is url-safe and unique", () => {
    const a = randomToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a).not.toBe(randomToken());
  });

  test("escapeHtml", () => {
    expect(escapeHtml(`<script>"x"&'y'</script>`)).toBe("&lt;script&gt;&quot;x&quot;&amp;&#39;y&#39;&lt;/script&gt;");
  });

  test("getCookie", () => {
    const req = new Request("https://x", { headers: { Cookie: "a=1; __Host-ynab_mcp_csrf=tok=en; b=2" } });
    expect(getCookie(req, "__Host-ynab_mcp_csrf")).toBe("tok=en");
    expect(getCookie(req, "missing")).toBeUndefined();
  });
});

describe("amount and month formatting", () => {
  test("milliunit conversion", () => {
    expect(toMilli(-12.34)).toBe(-12340);
    expect(toMilli(0.1 + 0.2)).toBe(300);
    expect(fromMilli(-12340)).toBe(-12.34);
  });

  test("normalizeMonth", () => {
    expect(normalizeMonth(undefined)).toBe("current");
    expect(normalizeMonth("2026-09")).toBe("2026-09-01");
    expect(normalizeMonth("2026-09-17")).toBe("2026-09-01");
    expect(() => normalizeMonth("Sept")).toThrow();
  });
});
