import { escapeHtml, simulationPage } from "../world/pages.ts";
import type { GoogleSimulatorAccount } from "./index.ts";

/**
 * The text that marks every page of the simulated Google. The check on the
 * production build looks for it, see apps/web/scripts/check-build.mjs.
 */
export const simulationNotice =
  "This page stands in for Google in development and tests.";

// What the simulated Google adds to the notice on its pages.
const notice = `${simulationNotice} It asks for no password and reaches no Google server.`;

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

  return simulationPage({
    title: "Simulated Google sign-in",
    notice,
    body: `<h1>Sign in with Google</h1>
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
  });
}

/**
 * What Google shows instead of redirecting when it cannot trust the redirect
 * address or the request makes no sense.
 */
export function errorPage(status: number, error: string, description: string) {
  return simulationPage({
    title: `Error ${status}: ${error}`,
    notice,
    body: `<h1>Access blocked: the request is invalid</h1>
<p>${escapeHtml(description)}</p>
<p>Error ${status}: ${escapeHtml(error)}</p>`,
  });
}
