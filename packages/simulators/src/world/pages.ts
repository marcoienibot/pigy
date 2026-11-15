/**
 * The pages of the simulated networks: what a person sees where the real
 * network would ask them to sign in and to consent. They are plain HTML
 * without scripts, and every one says that it is a simulation.
 *
 * This is not the page of the simulated Google, which is not part of a
 * production build. These pages are: the sandbox shows them.
 */

/** The text that marks every page of a simulated network. */
export const simulationNotice =
  "This page stands in for a social network. Nothing you do here reaches the real one.";

export function escapeHtml(text: string): string {
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
  p, ul { margin: 0 0 16px; }
  .notice { border: 2px dashed #d97706; border-radius: 6px; padding: 8px 12px; }
  .notice strong { color: #d97706; text-transform: uppercase; letter-spacing: 0.05em; }
  button { cursor: pointer; font: inherit; padding: 6px 12px; }
  .account { display: block; margin: 0 0 8px; text-align: left; width: 100%; }
  .account span { display: block; opacity: 0.7; }
</style>
</head>
<body>
<main>
<p class="notice"><strong>Simulation</strong><br>${simulationNotice}</p>
${body}
</main>
</body>
</html>`;
}

/** An account that the consent page offers. */
export type ConsentAccount = { id: string; handle: string; name: string };

export type ConsentPageOptions = {
  /** Who asks, such as "Mastodon at mastodon.example". */
  service: string;
  /** The name of the app that wants access. */
  client: string;
  /** What the app wants to do, in the network's words. */
  scopes: readonly string[];
  /** The accounts of the world that can be signed in as. */
  accounts: readonly ConsentAccount[];
};

/**
 * Where the person chooses which simulated account to connect, or declines.
 * It stands for two pages of a real network: signing in and consenting.
 *
 * The form posts back to the address the page was loaded from, so the
 * authorization request in its query string travels along. It sends
 * `account` with the ID of the chosen account, or `action=deny`. The pages
 * of all simulated networks use these two fields, which is what lets
 * `answerConsent` answer any of them.
 */
export function consentPage({
  service,
  client,
  scopes,
  accounts,
}: ConsentPageOptions): string {
  const buttons = accounts
    .map(
      ({ id, handle, name }) =>
        `<button class="account" name="account" value="${escapeHtml(id)}">${escapeHtml(name)}<span>${escapeHtml(handle)}</span></button>`,
    )
    .join("\n");
  return page(
    `Simulated ${service}`,
    `<h1>${escapeHtml(client)} wants to use your account</h1>
<p>${escapeHtml(service)}. It asks for:</p>
<ul>
${scopes.map((scope) => `<li>${escapeHtml(scope)}</li>`).join("\n")}
</ul>
<form method="post">
${accounts.length > 0 ? "<p>Choose the account to connect.</p>" : "<p>There is no simulated account here to connect.</p>"}
${buttons}
<button name="action" value="deny">Cancel</button>
</form>`,
  );
}

/** What a network shows when it will not send the browser back. */
export function errorPage(service: string, description: string): string {
  return page(
    `Simulated ${service}`,
    `<h1>${escapeHtml(service)} cannot continue</h1>
<p>${escapeHtml(description)}</p>`,
  );
}
