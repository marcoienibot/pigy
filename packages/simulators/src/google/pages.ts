import type { GoogleSimulatorAccount } from "./index.ts";

/**
 * The text that marks every page of the simulated Google. The check on the
 * production build looks for it, see apps/web/scripts/check-build.mjs.
 */
export const simulationNotice =
  "This page stands in for Google in development and tests.";

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light dark; font: 14px/1.5 system-ui, sans-serif; }
  body { margin: 0; padding: 16px; }
  main { margin: 0 auto; max-width: 400px; }
  h1 { font-size: 18px; margin: 24px 0 4px; }
  p { margin: 0 0 16px; }
  .notice { border: 2px dashed #d97706; border-radius: 6px; padding: 8px 12px; }
  .notice strong { color: #d97706; text-transform: uppercase; letter-spacing: 0.05em; }
  label { display: block; margin: 12px 0 0; }
  input:not([type=checkbox]) { box-sizing: border-box; display: block; font: inherit; margin-top: 4px; padding: 6px 8px; width: 100%; }
  button { cursor: pointer; font: inherit; padding: 6px 12px; }
  .account { display: block; margin: 0 0 8px; text-align: left; width: 100%; }
  .account span { display: block; opacity: 0.7; }
  .actions { display: flex; gap: 8px; margin-top: 16px; }
  details { margin-top: 12px; }
  summary { cursor: pointer; }
  small { display: block; margin-top: 4px; opacity: 0.7; }
</style>
</head>
<body>
<main>
<p class="notice"><strong>Simulation</strong><br>${simulationNotice} It asks for no password and reaches no Google server.</p>
${body}
</main>
</body>
</html>`;
}

/**
 * Where the person says who they are. Both forms post back to the address the
 * page was loaded from, whatever it is, so the authorization request in its
 * query string travels along.
 */
export function consentPage(accounts: readonly GoogleSimulatorAccount[]) {
  const accountForms = accounts
    .map(
      ({ email, name }) => `<form method="post">
<input type="hidden" name="email" value="${escapeHtml(email)}">
<input type="hidden" name="name" value="${escapeHtml(name)}">
<input type="hidden" name="email_verified" value="on">
<button class="account" name="action" value="continue">${escapeHtml(name)}<span>${escapeHtml(email)}</span></button>
</form>`,
    )
    .join("\n");

  return page(
    "Simulated Google sign-in",
    `<h1>Sign in with Google</h1>
<p>Choose who to sign in as. Any email address works.</p>
${accountForms}
<form method="post">
<label>Email
<input type="email" name="email" required autocomplete="off">
</label>
<label>Name
<input type="text" name="name" autocomplete="off" aria-describedby="name-hint">
</label>
<small id="name-hint">Taken from the email address if left empty.</small>
<label><input type="checkbox" name="email_verified" checked> Google has verified this email address</label>
<details>
<summary>More</summary>
<label>Account ID
<input type="text" name="sub" inputmode="numeric" pattern="[0-9]{1,255}" autocomplete="off" aria-describedby="sub-hint">
</label>
<small id="sub-hint">Google's permanent ID for the account, the "sub" claim. Derived from the email address if left empty.</small>
</details>
<div class="actions">
<button name="action" value="continue">Continue</button>
<button name="action" value="cancel" formnovalidate>Cancel</button>
</div>
</form>`,
  );
}

/**
 * What Google shows instead of redirecting when it cannot trust the redirect
 * address or the request makes no sense.
 */
export function errorPage(status: number, error: string, description: string) {
  return page(
    `Error ${status}: ${error}`,
    `<h1>Access blocked: the request is invalid</h1>
<p>${escapeHtml(description)}</p>
<p>Error ${status}: ${escapeHtml(error)}</p>`,
  );
}
