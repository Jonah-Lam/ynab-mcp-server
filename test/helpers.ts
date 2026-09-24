import { createMcpHandler } from "@modelcontextprotocol/server";
import { createServer } from "../src/mcp/server";
import type { FetchFn } from "../src/ynab/client";

export interface RecordedCall {
  method: string;
  path: string;
  query: Record<string, string>;
  body?: any;
}

type Route = (call: RecordedCall) => unknown;

/** A fake YNAB API: routes are keyed by "METHOD /path" (path after /v1). */
export function fakeYnab(routes: Record<string, Route | object>) {
  const calls: RecordedCall[] = [];
  const fetchImpl: FetchFn = async (input, init) => {
    const url = new URL(String(input));
    const call: RecordedCall = {
      method: init?.method ?? "GET",
      path: url.pathname.replace(/^\/v1/, ""),
      query: Object.fromEntries(url.searchParams),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    const route = routes[`${call.method} ${call.path}`];
    if (!route) {
      return Response.json({ error: { id: "404", name: "not_found", detail: `No fake for ${call.method} ${call.path}` } }, { status: 404 });
    }
    const data = typeof route === "function" ? (route as Route)(call) : route;
    return Response.json({ data });
  };
  return { fetchImpl, calls };
}

export function mcpClient(fetchImpl: FetchFn, canWrite = true) {
  const handler = createMcpHandler(() => createServer({ ynabToken: "test", canWrite, fetchImpl }));
  let id = 0;
  async function rpc(method: string, params: unknown = {}) {
    const res = await handler.fetch(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "MCP-Protocol-Version": "2025-06-18",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
      }),
    );
    const text = await res.text();
    const payload = text.trimStart().startsWith("{")
      ? text
      : text
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5))
          .join("");
    return JSON.parse(payload);
  }
  return {
    rpc,
    async listTools(): Promise<string[]> {
      const r = await rpc("tools/list");
      return r.result.tools.map((t: { name: string }) => t.name);
    },
    async call(name: string, args: Record<string, unknown> = {}) {
      const r = await rpc("tools/call", { name, arguments: args });
      const result = r.result;
      const text = result.content?.[0]?.text ?? "";
      let json: any;
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
      return { isError: result.isError === true, text, json };
    },
  };
}
