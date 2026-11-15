import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  type ConnectOutcome,
  connectOutcomeSchema,
  connectResponseSchema,
  connectReturnPath,
  disconnectResponseSchema,
  type Row,
  sandboxMastodonDomain,
} from "@pigy/core";
import { answerConsent } from "@pigy/simulators/world";
import { expect } from "vitest";
import {
  type Browser,
  locationOf,
  realMastodonDomain,
  type TestSetup,
} from "./helpers.ts";
import { objectOf, SyncClient } from "./sync-client.ts";

/**
 * What the tests of connecting and disconnecting share: the steps that a
 * person and their browser take, and ways to look at what the app stored.
 */

/** Asks the app to begin a connection, and returns its answer as it is. */
export function startConnect(
  browser: Browser,
  workspaceId: string,
  body: unknown,
): Promise<Response> {
  return browser.fetch(`/api/workspaces/${workspaceId}/connect`, {
    method: "POST",
    json: body,
  });
}

/** Begins a connection, and returns where the app sends the browser. */
export async function consentUrl(
  browser: Browser,
  workspaceId: string,
  identifier: string,
): Promise<string> {
  const response = await startConnect(browser, workspaceId, {
    network: "mastodon",
    identifier,
  });
  expect(response.status).toBe(200);
  return connectResponseSchema.parse(await response.json()).url;
}

/** How a connection ended, from where the callback sends the browser. */
export function outcomeOf(response: Response): ConnectOutcome {
  const url = new URL(locationOf(response), "https://pigy.test");
  // The address of a page of the app, and no other.
  expect(url.origin + url.pathname).toBe(
    `https://pigy.test${connectReturnPath}`,
  );
  return connectOutcomeSchema.parse(Object.fromEntries(url.searchParams));
}

/** An address of the app as the path that `Browser.fetch` takes. */
export function pathOf(url: string | URL): string {
  const { pathname, search } = new URL(url);
  return pathname + search;
}

/**
 * The accounts that the consent page of a sandbox offers: the ID that its
 * form sends for each, by the handle that the page shows.
 */
export async function offeredAccounts(
  page: Response,
): Promise<Map<string, string>> {
  expect(page.status).toBe(200);
  const html = await page.text();
  return new Map(
    Array.from(
      html.matchAll(/name="account" value="([^"]+)">[^<]*<span>([^<]+)</g),
      ([, id = "", handle = ""]) => [handle, id],
    ),
  );
}

/**
 * Goes to the consent page of a connection in a sandbox, as the browser
 * would, and answers it: chooses the account with `handle`, or declines.
 * Returns the address that the simulated network sends the browser back to.
 */
export async function consentInSandbox(
  browser: Browser,
  url: string,
  answer: { handle: string } | "deny",
): Promise<string> {
  const accounts = await offeredAccounts(await browser.fetch(pathOf(url)));
  const account = answer === "deny" ? undefined : accounts.get(answer.handle);
  if (answer !== "deny" && !account) {
    throw new Error(`The consent page does not offer ${answer.handle}`);
  }
  const submitted = await browser.fetch(pathOf(url), {
    form: account ? { account } : { action: "deny" },
  });
  return locationOf(submitted);
}

/**
 * Connects the account `handle` of the simulated Mastodon to a sandbox
 * workspace, all the way, and returns how the app says it ended.
 */
export async function connectInSandbox(
  browser: Browser,
  workspaceId: string,
  handle = `@ada@${sandboxMastodonDomain}`,
): Promise<ConnectOutcome> {
  const url = await consentUrl(browser, workspaceId, sandboxMastodonDomain);
  const callback = await consentInSandbox(browser, url, { handle });
  return outcomeOf(await browser.fetch(pathOf(callback)));
}

/**
 * Answers the consent page of the Mastodon server that stands for a real
 * one, as its account or by declining, and returns the address that it
 * sends the browser back to. In production the browser is at the network
 * for this, and the app sees nothing of it.
 */
export async function consentAtNetwork(
  { network }: Pick<TestSetup, "network">,
  url: string,
  answer: "allow" | "deny" = "allow",
): Promise<string> {
  const callback = await answerConsent(
    network.mastodon.fetch,
    url,
    answer === "allow" ? { account: network.account.id } : "deny",
  );
  return callback.href;
}

/**
 * Connects the account of the Mastodon server that stands for a real one
 * to a live workspace, all the way, and returns how the app says it ended.
 */
export async function connectLive(
  test: Pick<TestSetup, "network">,
  browser: Browser,
  workspaceId: string,
): Promise<ConnectOutcome> {
  const url = await consentUrl(browser, workspaceId, realMastodonDomain);
  const callback = await consentAtNetwork(test, url);
  return outcomeOf(await browser.fetch(pathOf(callback)));
}

/** Disconnects a channel, and returns the answer as it is. */
export function disconnect(
  browser: Browser,
  workspaceId: string,
  channelId: string,
): Promise<Response> {
  return browser.fetch(`/api/workspaces/${workspaceId}/channels/${channelId}`, {
    method: "DELETE",
  });
}

/** Disconnects a channel, and returns whether its access was given back. */
export async function disconnected(
  browser: Browser,
  workspaceId: string,
  channelId: string,
): Promise<boolean> {
  const response = await disconnect(browser, workspaceId, channelId);
  expect(response.status).toBe(200);
  return disconnectResponseSchema.parse(await response.json()).revoked;
}

/** The channels of a workspace, as a client that has just connected sees them. */
export async function channelsOf(
  browser: Browser,
  workspaceId: string,
): Promise<Row<"channel">[]> {
  const client = new SyncClient();
  await client.connect(browser, workspaceId);
  client.disconnect();
  return client.table("channel");
}

/** What a workspace keeps for its channels that clients never see. */
export function storedAccess(
  workspaceId: string,
): Promise<{ id: string; credentials: string | null }[]> {
  return runInDurableObject(objectOf(workspaceId), (_, state) =>
    state.storage.sql
      .exec<{ id: string; credentials: string | null }>(
        "select id, credentials from channel order by id",
      )
      .toArray(),
  );
}

/** A token that the simulated world of a sandbox has issued. */
export type SandboxToken = {
  token: string;
  accountId: string | null;
  revoked: boolean;
};

/**
 * What the simulated world of a sandbox workspace holds under the keys that
 * begin with `prefix`. A test reads the world with it: its tokens are under
 * "token/mastodon/", what pigy registered with it under "mastodon/app/".
 */
export function worldEntries<Entry>(
  workspaceId: string,
  prefix: string,
): Promise<Entry[]> {
  return runInDurableObject(env.SIM_WORLD.getByName(workspaceId), (_, state) =>
    Array.from(state.storage.kv.list<Entry>({ prefix }), ([, entry]) => entry),
  );
}
