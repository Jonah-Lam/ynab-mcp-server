const YNAB_API = "https://api.ynab.com/v1";

export class YnabError extends Error {
  constructor(
    readonly status: number,
    readonly errorName: string,
    readonly detail: string,
  ) {
    super(`YNAB API error ${status} (${errorName}): ${detail}`);
  }
}

type Query = Record<string, string | number | boolean | undefined>;

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export class YnabClient {
  constructor(
    private readonly token: string,
    // Wrapped so the global is never invoked with a foreign `this` (Workers rejects that).
    private readonly fetchImpl: FetchFn = (input, init) => fetch(input, init),
  ) {}

  async request<T>(method: string, path: string, options: { query?: Query; body?: unknown } = {}): Promise<T> {
    const url = new URL(`${YNAB_API}${path}`);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    const res = await this.fetchImpl(url.toString(), {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/json",
        ...(options.body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    });

    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = undefined;
    }

    if (!res.ok) {
      const err = (json as { error?: { name?: string; detail?: string } } | undefined)?.error;
      const detail =
        res.status === 429
          ? "Rate limit reached (YNAB allows 200 requests per hour). Try again later."
          : (err?.detail ?? res.statusText ?? "Unknown error");
      throw new YnabError(res.status, err?.name ?? "error", detail);
    }
    return (json as { data: T }).data;
  }

  get<T>(path: string, query?: Query) {
    return this.request<T>("GET", path, { query });
  }
  post<T>(path: string, body: unknown) {
    return this.request<T>("POST", path, { body });
  }
  put<T>(path: string, body: unknown) {
    return this.request<T>("PUT", path, { body });
  }
  patch<T>(path: string, body: unknown) {
    return this.request<T>("PATCH", path, { body });
  }
  delete<T>(path: string) {
    return this.request<T>("DELETE", path);
  }
}

/** Encodes one path segment (IDs, dates) so user input can never alter the path. */
export function seg(value: string): string {
  if (value === "" || value === "." || value === "..") throw new YnabError(400, "bad_request", `Invalid identifier "${value}"`);
  return encodeURIComponent(value);
}
