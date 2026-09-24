#!/usr/bin/env bun
/**
 * Interactive deploy helper.
 *
 *   bun run setup             Deploy the Worker and set both secrets
 *   bun run rotate-password   Generate a new owner password (disconnects every client)
 *   bun run set-ynab-token    Replace the YNAB personal access token
 *
 * Secrets are sent to Wrangler over stdin and never written to disk.
 */
import { $ } from "bun";

const MIN_PASSWORD_LENGTH = 16;
const mode = process.argv[2] ?? "setup";

const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;

function fail(message: string): never {
  console.error(red(`\n✖ ${message}`));
  process.exit(1);
}

/** Reads a line from the terminal without echoing it. */
async function promptHidden(question: string): Promise<string> {
  process.stdout.write(question);
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    for await (const line of console) return line.trim();
    return "";
  }
  stdin.setRawMode(true);
  stdin.resume();
  let value = "";
  return new Promise((resolve) => {
    const onData = (chunk: Uint8Array) => {
      for (const char of new TextDecoder().decode(chunk)) {
        if (char === "\r" || char === "\n") {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off("data", onData);
          process.stdout.write("\n");
          resolve(value.trim());
          return;
        }
        if (char === "\u0003") process.exit(130); // Ctrl+C
        if (char === "\u007f" || char === "\b") value = value.slice(0, -1);
        else value += char;
      }
    };
    stdin.on("data", onData);
  });
}

function ask(question: string, fallback = ""): string {
  const answer = prompt(question);
  return (answer ?? fallback).trim() || fallback;
}

function generatePassword(): string {
  // 24 chars from an unambiguous alphabet ≈ 138 bits of entropy.
  const alphabet = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  // Rejection sampling: only bytes below the largest multiple of the alphabet size are
  // used, so every character is equally likely.
  const limit = 256 - (256 % alphabet.length);
  const chars: string[] = [];
  while (chars.length < 24) {
    for (const b of crypto.getRandomValues(new Uint8Array(32))) {
      if (b < limit && chars.length < 24) chars.push(alphabet[b % alphabet.length]!);
    }
  }
  return `${chars.slice(0, 8).join("")}-${chars.slice(8, 16).join("")}-${chars.slice(16).join("")}`;
}

async function ensureLoggedIn() {
  const whoami = await $`bunx wrangler whoami`.quiet().nothrow();
  if (whoami.exitCode !== 0 || whoami.stdout.toString().includes("not authenticated")) {
    console.log("You need to log in to Cloudflare first.");
    await $`bunx wrangler login`;
  }
}

async function readYnabToken(): Promise<string> {
  console.log(`\nCreate a YNAB personal access token at ${bold("https://app.ynab.com/settings/developer")}`);
  const token = await promptHidden("Paste your YNAB personal access token (input hidden): ");
  if (!token) fail("No token entered.");
  const res = await fetch("https://api.ynab.com/v1/user", { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) fail(`YNAB rejected that token (HTTP ${res.status}).`);
  console.log(green("✔ YNAB token works."));
  return token;
}

async function choosePassword(): Promise<string> {
  const custom = ask(`\nUse a generated owner password? [Y/n] `, "y").toLowerCase().startsWith("n");
  if (!custom) return generatePassword();
  const password = await promptHidden(`Owner password (min ${MIN_PASSWORD_LENGTH} characters, input hidden): `);
  if (password.length < MIN_PASSWORD_LENGTH) fail(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  const confirm = await promptHidden("Repeat password: ");
  if (confirm !== password) fail("Passwords do not match.");
  return password;
}

async function putSecrets(secrets: Record<string, string>) {
  const input = new Response(JSON.stringify(secrets));
  const result = await $`bunx wrangler secret bulk < ${input}`.nothrow();
  if (result.exitCode !== 0) fail("Uploading secrets failed. See the Wrangler output above.");
}

async function deploy(): Promise<string | undefined> {
  console.log(bold("\nDeploying the Worker…"));
  const result = await $`bunx wrangler deploy`.nothrow();
  if (result.exitCode !== 0) fail("Deploy failed. See the Wrangler output above.");
  return /https:\/\/[^\s]+\.workers\.dev/.exec(result.stdout.toString())?.[0];
}

function printPassword(password: string) {
  console.log(`\n${bold("Owner password:")} ${password}`);
  console.log(dim("Save it in your password manager. You type it once each time you connect a new app."));
}

async function main() {
  if (mode === "rotate-password") {
    await ensureLoggedIn();
    const password = await choosePassword();
    await putSecrets({ OWNER_PASSWORD: password });
    printPassword(password);
    console.log(green("\n✔ Password rotated. Every connected app has been signed out and must reconnect."));
    return;
  }

  if (mode === "set-ynab-token") {
    await ensureLoggedIn();
    await putSecrets({ YNAB_ACCESS_TOKEN: await readYnabToken() });
    console.log(green("\n✔ YNAB token updated."));
    return;
  }

  if (mode !== "setup") fail(`Unknown command "${mode}".`);

  console.log(bold("YNAB MCP server setup"));
  await ensureLoggedIn();
  const ynabToken = await readYnabToken();
  const password = await choosePassword();

  const url = await deploy();
  await putSecrets({ YNAB_ACCESS_TOKEN: ynabToken, OWNER_PASSWORD: password });

  const mcpUrl = url ? `${url}/mcp` : "https://<your-worker>.workers.dev/mcp";
  console.log(green("\n✔ Deployed."));
  console.log(`\n${bold("MCP server URL:")} ${mcpUrl}`);
  printPassword(password);
  console.log(`
${bold("Connect it")}
  Claude:  Settings → Connectors → Add custom connector → paste the URL
  ChatGPT: Settings → Apps & Connectors → Advanced → Developer mode, then Create → paste the URL (OAuth)
When the login page opens, enter the owner password and choose whether to allow changes.
`);
}

await main();
