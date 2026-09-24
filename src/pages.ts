import { escapeHtml } from "./security";

const STYLE = `
:root { color-scheme: light dark; --bg:#f6f7f9; --card:#fff; --fg:#1b1f24; --muted:#5b6470; --border:#d9dde3; --accent:#2f5bea; --on-accent:#fff; --danger:#b42318; }
@media (prefers-color-scheme: dark) { :root { --bg:#0f1115; --card:#181b21; --fg:#e8eaed; --muted:#9aa3ad; --border:#2c313a; --accent:#7c9cff; --on-accent:#0f1115; --danger:#ff8a80; } }
* { box-sizing: border-box; }
body { margin:0; min-height:100vh; display:grid; place-items:center; padding:16px; background:var(--bg); color:var(--fg); font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif; }
main { width:100%; max-width:420px; background:var(--card); border:1px solid var(--border); border-radius:12px; padding:28px; }
h1 { font-size:20px; margin:0 0 4px; }
p { margin:0 0 16px; color:var(--muted); }
dl { margin:0 0 20px; padding:12px 14px; border:1px solid var(--border); border-radius:8px; font-size:14px; }
dt { color:var(--muted); font-size:12px; text-transform:uppercase; letter-spacing:.04em; }
dd { margin:0 0 8px; word-break:break-all; }
dd:last-child { margin-bottom:0; }
label { display:block; font-weight:600; margin-bottom:6px; }
input[type=password] { width:100%; padding:10px 12px; font:inherit; color:inherit; background:transparent; border:1px solid var(--border); border-radius:8px; margin-bottom:16px; }
.check { display:flex; gap:10px; align-items:flex-start; font-weight:400; margin-bottom:20px; }
.check input { margin-top:4px; }
.actions { display:flex; flex-direction:row-reverse; gap:10px; }
button { flex:1; padding:10px 14px; font:inherit; font-weight:600; border-radius:8px; cursor:pointer; border:1px solid var(--border); background:transparent; color:inherit; }
button.primary { background:var(--accent); border-color:var(--accent); color:var(--on-accent); }
.error { color:var(--danger); font-weight:600; }
`;

function securityHeaders(extraFormAction: string[] = []): Record<string, string> {
  // form-action must also allow the OAuth redirect target: browsers apply it to
  // the redirect that follows a form submission.
  const formAction = ["'self'", ...extraFormAction].join(" ");
  return {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Security-Policy": `default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; form-action ${formAction}; frame-ancestors 'none'; base-uri 'none'`,
    "X-Frame-Options": "DENY",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-store",
  };
}

function layout(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body><main>${body}</main></body>
</html>`;
}

export interface ConsentPageOptions {
  clientName: string;
  redirectUri: string;
  actionUrl: string;
  csrfToken: string;
  csrfCookie: string;
  allowWriteOption: boolean;
  error?: string;
  status?: number;
}

export function consentPage(opts: ConsentPageOptions): Response {
  const redirect = new URL(opts.redirectUri);
  const error = opts.error ? `<p class="error" role="alert">${escapeHtml(opts.error)}</p>` : "";
  const writeOption = opts.allowWriteOption
    ? `<label class="check"><input type="checkbox" name="allow_write" value="1" checked>
       <span>Allow changes: create, edit and delete transactions, assign money, rename payees and categories.</span></label>`
    : `<p>This server is running in read-only mode.</p>`;

  const body = `
<h1>Connect to your YNAB</h1>
<p>An app is asking for access to your YNAB data through this server. Only continue if you started this connection yourself.</p>
<dl>
  <dt>App</dt><dd>${escapeHtml(opts.clientName)}</dd>
  <dt>Sends you back to</dt><dd>${escapeHtml(redirect.origin)}</dd>
</dl>
${error}
<form method="post" action="${escapeHtml(opts.actionUrl)}">
  <input type="hidden" name="csrf_token" value="${escapeHtml(opts.csrfToken)}">
  <label for="password">Owner password</label>
  <input id="password" name="password" type="password" autocomplete="current-password" autofocus>
  ${writeOption}
  <div class="actions">
    <!-- Allow comes first so pressing Enter approves; row-reverse keeps it on the right. -->
    <button type="submit" name="decision" value="approve" class="primary">Allow</button>
    <button type="submit" name="decision" value="deny">Deny</button>
  </div>
</form>`;

  const headers = securityHeaders([redirect.origin]);
  const res = new Response(layout("Connect to YNAB", body), { status: opts.status ?? 200, headers });
  res.headers.append("Set-Cookie", opts.csrfCookie);
  return res;
}

export function messagePage(title: string, message: string, status: number): Response {
  const body = `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>`;
  return new Response(layout(title, body), { status, headers: securityHeaders() });
}
