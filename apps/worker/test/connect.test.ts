import { runInDurableObject } from "cloudflare:test";
import {
  errorResponseSchema,
  maxConnectIdentifierLength,
  sandboxMastodonDomain,
} from "@pigy/core";
import { describe, expect, it } from "vitest";
import { pendingLifetimeMs } from "../src/channels/pending.ts";
import { oauthStates } from "../src/db/schema.ts";
import {
  channelsOf,
  connectInSandbox,
  connectLive,
  consentAtNetwork,
  consentInSandbox,
  consentUrl,
  outcomeOf,
  pathOf,
  startConnect,
  storedAccess,
} from "./channels.ts";
import {
  adminEmail,
  type Browser,
  breakDatabase,
  expectErrors,
  expectWarnings,
  invite,
  realMastodonDomain,
  setup,
  signedIn,
  urlOf,
} from "./helpers.ts";
import { objectOf, SyncClient, workspaceIds } from "./sync-client.ts";

const memberEmail = "member@example.com";

/** A signed-in admin and their workspaces. */
async function start(options: Parameters<typeof setup>[0] = {}) {
  const test = setup(options);
  const browser = await signedIn(test, { email: adminEmail });
  return { test, browser, workspaces: await workspaceIds(browser) };
}

it("connects a simulated account to a sandbox without leaving the Worker", async () => {
  const { test, browser, workspaces } = await start();

  const url = await consentUrl(
    browser,
    workspaces.sandbox,
    sandboxMastodonDomain,
  );
  // The consent page is one of the app itself: the simulated server has no
  // address that a browser could open.
  expect(new URL(url).origin).toBe("https://pigy.test");
  expect(new URL(url).pathname).toBe(
    `/sim/network/${sandboxMastodonDomain}/oauth/authorize`,
  );
  const callback = await consentInSandbox(browser, url, {
    handle: `@grace@${sandboxMastodonDomain}`,
  });
  const outcome = outcomeOf(await browser.fetch(pathOf(callback)));

  const channels = await channelsOf(browser, workspaces.sandbox);
  expect(outcome).toEqual({
    connect: "connected",
    network: "mastodon",
    workspace: workspaces.sandbox,
    channel: channels[0]?.id,
  });
  expect(channels).toEqual([
    {
      id: expect.any(String),
      network: "mastodon",
      accountId: expect.stringMatching(/^\d+@mastodon\.example$/),
      handle: "@grace@mastodon.example",
      name: "Grace Hopper",
      // The simulated server has a picture and a page for the account, at
      // addresses that no browser can open. A channel has none of them: a
      // link to one would lead nowhere.
      avatarUrl: null,
      profileUrl: null,
      status: "connected",
      connectedAt: test.clock.time.getTime(),
      // A token of Mastodon's does not run out.
      expiresAt: null,
    },
  ]);
  // Everything was answered by the simulated world of the sandbox: nothing
  // went to where the real networks are.
  expect(test.network.requests).toEqual([]);
});

it("connects a real account to a live workspace through the fetch of the app", async () => {
  const { test, browser, workspaces } = await start();

  const url = await consentUrl(browser, workspaces.live, realMastodonDomain);
  // The browser goes to the server itself.
  expect(new URL(url).origin).toBe(`https://${realMastodonDomain}`);
  const outcome = await connectLive(test, browser, workspaces.live);

  const channels = await channelsOf(browser, workspaces.live);
  expect(outcome).toMatchObject({
    connect: "connected",
    workspace: workspaces.live,
    channel: channels[0]?.id,
  });
  expect(channels).toMatchObject([
    {
      network: "mastodon",
      accountId: `${test.network.account.id}@${realMastodonDomain}`,
      handle: `@rosalind@${realMastodonDomain}`,
      name: "Rosalind Franklin",
      // Where the server says the picture and the page of the account are.
      avatarUrl: `https://${realMastodonDomain}/avatars/original/missing.png`,
      profileUrl: `https://${realMastodonDomain}/@rosalind`,
      status: "connected",
    },
  ]);
  // The server was asked, where a sandbox asks nobody.
  expect(test.network.requests).toContain(
    `GET https://${realMastodonDomain}/api/v2/instance`,
  );
});

it("sends a channel to the clients that are connected when its account is connected", async () => {
  const { browser, workspaces } = await start();
  const client = new SyncClient();
  await client.connect(browser, workspaces.sandbox);

  const outcome = await connectInSandbox(browser, workspaces.sandbox);

  // The page that the browser comes back to has the channel by then: the
  // change went out before the callback was answered.
  expect(client.unread).toBe(1);
  await client.patch();
  expect(client.table("channel").map(({ id }) => id)).toEqual([
    outcome.channel,
  ]);
});

describe("starting a connection", () => {
  /** What the app refuses to begin a connection with, and that it kept nothing. */
  async function refused(
    test: ReturnType<typeof setup>,
    browser: Browser,
    workspaceId: string,
    body: unknown,
  ) {
    const response = await startConnect(browser, workspaceId, body);
    const { error, message } = errorResponseSchema.parse(await response.json());
    // Nothing is kept of a connection that did not begin.
    expect(await test.db.select().from(oauthStates)).toEqual([]);
    return { status: response.status, error, message };
  }

  it.each([
    ["nothing", undefined],
    ["an empty text", "  "],
    ["an address with a path", `https://${realMastodonDomain}/@rosalind`],
    // Names that lead into the network of whoever runs pigy.
    ["an IP address", "192.168.1.1"],
    ["this machine", "localhost"],
    ["a name of a local network", "printer.local"],
  ])(
    "asks for the address of a server when the person entered %s",
    async (_name, identifier) => {
      const { test, browser, workspaces } = await start();

      const refusal = await refused(test, browser, workspaces.live, {
        network: "mastodon",
        ...(identifier !== undefined && { identifier }),
      });

      // The message goes next to the field.
      expect(refusal).toEqual({
        status: 400,
        error: "InvalidInputError",
        message:
          "Enter the address of your Mastodon server, such as mastodon.social.",
      });
      // What a person types decides where pigy sends requests. Nothing was
      // sent anywhere for these.
      expect(test.network.requests).toEqual([]);
    },
  );

  it("says that a server cannot be reached", async () => {
    const { test, browser, workspaces } = await start();
    const errors = expectErrors();

    const refusal = await refused(test, browser, workspaces.live, {
      network: "mastodon",
      // A name that nothing answers for.
      identifier: "nowhere.test",
    });

    // Not the fault of what was entered, as far as pigy can tell: the
    // server may be back later.
    expect(refusal).toEqual({
      status: 502,
      error: "UnexpectedError",
      message: "nowhere.test could not be reached.",
    });
    // The operator hears of it.
    expect(errors).toHaveBeenCalledOnce();
  });

  it.each([
    // What a server answers that is not Mastodon, and what a Mastodon
    // before 4.0 answers, which has no such address.
    [
      "is not Mastodon, or is too old",
      () => new Response("Not found", { status: 404 }),
      "mastodon.test is not a Mastodon server that pigy can post to. It takes Mastodon 4.0 or later.",
    ],
    [
      "answers with something else than Mastodon does",
      () => Response.json({ name: "Some other software" }),
      "mastodon.test did not answer the way a Mastodon server does.",
    ],
    [
      "sends pigy on to another address",
      () =>
        new Response(null, {
          status: 301,
          headers: { Location: "https://elsewhere.test/api/v2/instance" },
        }),
      "mastodon.test sends pigy on to another address. Enter the address of the server itself.",
    ],
  ])("says that a server %s", async (_name, answer, message) => {
    const { test, browser, workspaces } = await start({
      interceptNetwork: (network) => async (input, init) =>
        urlOf(input).endsWith("/api/v2/instance")
          ? answer()
          : network(input, init),
    });

    const refusal = await refused(test, browser, workspaces.live, {
      network: "mastodon",
      identifier: realMastodonDomain,
    });

    expect(refusal).toEqual({
      status: 400,
      error: "InvalidInputError",
      message,
    });
    // pigy did not go where the server pointed, and registered nothing.
    expect(test.network.requests).toEqual([
      `GET https://${realMastodonDomain}/api/v2/instance`,
    ]);
  });

  it.each([
    [
      "is failing",
      "server-error",
      "mastodon.test is having trouble (HTTP 503).",
    ],
    [
      "has been asked too often",
      "rate-limit",
      "mastodon.test is limiting how often pigy may ask.",
    ],
  ] as const)("says that a server %s", async (_name, kind, message) => {
    const { test, browser, workspaces } = await start();
    expectErrors();
    test.network.mastodon.arm({ kind, operation: "instance" });

    const refusal = await refused(test, browser, workspaces.live, {
      network: "mastodon",
      identifier: realMastodonDomain,
    });

    expect(refusal).toEqual({ status: 502, error: "UnexpectedError", message });
  });

  it("says so when pigy cannot connect a network yet", async () => {
    const { test, browser, workspaces } = await start();

    const refusal = await refused(test, browser, workspaces.live, {
      network: "bluesky",
      identifier: "ada.bsky.social",
    });

    expect(refusal).toMatchObject({ status: 400, error: "InvalidInputError" });
    expect(refusal.message).toContain("bluesky");
  });

  it.each([
    ["a network that pigy does not know", { network: "myspace" }],
    ["no network", { identifier: realMastodonDomain }],
    [
      "a field that the request does not have",
      { network: "mastodon", identifier: realMastodonDomain, workspace: "x" },
    ],
    [
      "an identifier that is too long",
      {
        network: "mastodon",
        identifier: "a".repeat(maxConnectIdentifierLength + 1),
      },
    ],
    ["an identifier that is not text", { network: "mastodon", identifier: 5 }],
  ])("refuses a request with %s", async (_name, body) => {
    const { test, browser, workspaces } = await start();

    const refusal = await refused(test, browser, workspaces.live, body);

    expect(refusal).toMatchObject({ status: 400, error: "InvalidInputError" });
    expect(test.network.requests).toEqual([]);
  });

  it("begins no connection for somebody who is not signed in", async () => {
    const { test, workspaces } = await start();

    const refusal = await refused(test, test.browser(), workspaces.live, {
      network: "mastodon",
      identifier: realMastodonDomain,
    });

    expect(refusal.status).toBe(401);
    expect(test.network.requests).toEqual([]);
  });

  it.each([
    ["no Origin", null],
    ["the Origin of another site", "https://evil.example"],
  ])("begins no connection for a request with %s", async (_name, origin) => {
    const { test, browser, workspaces } = await start();

    // With the session of the admin: the cookie is what a browser adds to
    // a request that another site makes.
    const response = await browser.fetch(
      `/api/workspaces/${workspaces.live}/connect`,
      {
        method: "POST",
        json: { network: "mastodon", identifier: realMastodonDomain },
        headers: { Origin: origin },
      },
    );

    expect(response.status).toBe(403);
    expect(test.network.requests).toEqual([]);
  });

  it("answers for the workspace of somebody else as for one that does not exist", async () => {
    const { test, workspaces } = await start();
    await invite(test, memberEmail);
    const member = await signedIn(test, { email: memberEmail });
    const body = { network: "mastodon", identifier: realMastodonDomain };

    const foreign = await refused(test, member, workspaces.live, body);
    const unknown = await refused(test, member, crypto.randomUUID(), body);

    expect(foreign).toEqual({
      status: 404,
      error: "NotFoundError",
      message: "There is no such workspace",
    });
    expect(unknown).toEqual(foreign);
    expect(test.network.requests).toEqual([]);
  });
});

describe("the answer of a network", () => {
  /**
   * A connection in the sandbox of the admin that has got as far as the
   * simulated server sending the browser back, and the address it sends it
   * to. `answer` is what the person said there.
   */
  async function answered(
    answer: Parameters<typeof consentInSandbox>[2] = {
      handle: `@ada@${sandboxMastodonDomain}`,
    },
  ) {
    const context = await start();
    const url = await consentUrl(
      context.browser,
      context.workspaces.sandbox,
      sandboxMastodonDomain,
    );
    const callback = pathOf(
      await consentInSandbox(context.browser, url, answer),
    );
    return { ...context, callback };
  }

  it("is good once", async () => {
    const { browser, workspaces, callback } = await answered();

    const first = outcomeOf(await browser.fetch(callback));
    // What a person does who goes back in their browser, and what somebody
    // does who has found the address in a log.
    const second = outcomeOf(await browser.fetch(callback));

    expect(first.connect).toBe("connected");
    expect(second).toEqual({ connect: "expired", network: "mastodon" });
    expect(await channelsOf(browser, workspaces.sandbox)).toHaveLength(1);
  });

  it("is not taken from another person, who would get the account of the first", async () => {
    const { test, browser, workspaces, callback } = await answered();
    await invite(test, memberEmail);
    const member = await signedIn(test, { email: memberEmail });
    const ofMember = await workspaceIds(member);

    // What an attacker is after who connects an account of their own and
    // gets somebody else to open the address of the answer: that person
    // would then post to the attacker's account without knowing.
    const outcome = outcomeOf(await member.fetch(callback));

    // The same answer as for an address that was made up. It names no
    // workspace: the connection was not for one of this person's.
    expect(outcome).toEqual({ connect: "expired", network: "mastodon" });
    expect(await channelsOf(member, ofMember.sandbox)).toEqual([]);
    expect(await channelsOf(member, ofMember.live)).toEqual([]);
    expect(await channelsOf(browser, workspaces.sandbox)).toEqual([]);
    // It was not used up either: whoever began can still finish.
    expect(outcomeOf(await browser.fetch(callback)).connect).toBe("connected");
  });

  it("is taken only in the browser that began", async () => {
    const { test, browser, callback } = await answered();
    // The same person, signed in on another device.
    const elsewhere = await signedIn(test, { email: adminEmail });

    const outcome = outcomeOf(await elsewhere.fetch(callback));

    expect(outcome).toEqual({ connect: "expired", network: "mastodon" });
    expect(outcomeOf(await browser.fetch(callback)).connect).toBe("connected");
  });

  it("is not taken from somebody who is not signed in", async () => {
    const { test, browser, workspaces, callback } = await answered();

    const outcome = outcomeOf(await test.browser().fetch(callback));

    expect(outcome).toEqual({ connect: "expired", network: "mastodon" });
    expect(await channelsOf(browser, workspaces.sandbox)).toEqual([]);
  });

  it("is too late once the person has signed out", async () => {
    const { test, browser, callback } = await answered();
    await browser.fetch("/api/auth/sign-out", { method: "POST" });

    const outcome = outcomeOf(await browser.fetch(callback));

    expect(outcome).toEqual({ connect: "expired", network: "mastodon" });
    // What was kept of the connection, with its secrets, went with the
    // session.
    expect(await test.db.select().from(oauthStates)).toEqual([]);
  });

  it("is taken for as long as a connection may take, and no longer", async () => {
    const { test, browser, workspaces, callback } = await answered();
    test.advance(pendingLifetimeMs);

    const late = outcomeOf(await browser.fetch(callback));

    expect(late).toEqual({ connect: "expired", network: "mastodon" });
    expect(await channelsOf(browser, workspaces.sandbox)).toEqual([]);
    expect(await test.db.select().from(oauthStates)).toEqual([]);

    // One moment less is in time. The simulated server gives a code the
    // same ten minutes.
    const url = await consentUrl(
      browser,
      workspaces.sandbox,
      sandboxMastodonDomain,
    );
    const again = pathOf(
      await consentInSandbox(browser, url, {
        handle: `@ada@${sandboxMastodonDomain}`,
      }),
    );
    test.advance(pendingLifetimeMs - 1);
    expect(outcomeOf(await browser.fetch(again)).connect).toBe("connected");
  });

  it("drops what is left of the connections that nobody came back for", async () => {
    const { test, browser, workspaces } = await answered();
    test.advance(pendingLifetimeMs);

    // Most connections that are given up never see a callback. The next
    // one to begin, anybody's, clears them out.
    await consentUrl(browser, workspaces.sandbox, sandboxMastodonDomain);

    expect(await test.db.select().from(oauthStates)).toHaveLength(1);
  });

  it.each([
    ["a state that pigy never made", "?code=some-code&state=made-up"],
    ["no state", "?code=some-code"],
    ["nothing at all", ""],
  ])("is not taken with %s", async (_name, query) => {
    const { browser, workspaces } = await answered();

    const outcome = outcomeOf(
      await browser.fetch(`/connect/mastodon/callback${query}`),
    );

    expect(outcome).toEqual({ connect: "expired", network: "mastodon" });
    expect(await channelsOf(browser, workspaces.sandbox)).toEqual([]);
  });

  it("is not taken at the address of another network", async () => {
    const { browser, workspaces, callback } = await answered();

    // The adapter of one network must never be handed what was kept for
    // another.
    const outcome = outcomeOf(
      await browser.fetch(callback.replace("/mastodon/", "/bluesky/")),
    );

    expect(outcome).toEqual({ connect: "expired", network: "bluesky" });
    expect(await channelsOf(browser, workspaces.sandbox)).toEqual([]);
  });

  it("is not taken at the address of a network that pigy does not know", async () => {
    const { browser, callback } = await answered();

    const outcome = outcomeOf(
      await browser.fetch(callback.replace("/mastodon/", "/myspace/")),
    );

    // Only the name of a network that pigy knows is passed on to the page.
    expect(outcome).toEqual({ connect: "failed" });
  });

  it.each([
    ["who is signed in is looked up", 'from "session"'],
    [
      "what was kept of the connection is taken out",
      'delete from "oauth_state"',
    ],
    ["the workspace of the connection is looked up", 'from "workspace"'],
  ])(
    "leads back into the app when the database fails while %s",
    async (_name, statement) => {
      const { browser, workspaces, callback } = await answered();
      const errors = expectErrors();
      let failed = 0;
      const mend = breakDatabase((sql) => {
        if (!sql.includes(statement)) return false;
        failed += 1;
        return true;
      });

      const response = await browser.fetch(callback);
      mend();

      // The statement is one that the callback makes, so this is a failure
      // at the point that the test is about.
      expect(failed).toBe(1);
      // A person is looking at the answer. It is a page of the app that
      // says the connection failed, not an error in JSON.
      expect(outcomeOf(response)).toMatchObject({
        connect: "failed",
        network: "mastodon",
      });
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      // Why, the operator reads in the log: the statement and the reason.
      expect(errors).toHaveBeenCalledOnce();
      const logged = errors.mock.calls
        .flat()
        .map((entry) =>
          entry instanceof Error
            ? `${entry.stack} ${String(entry.cause)}`
            : String(entry),
        )
        .join("\n");
      expect(logged).toContain("A connection could not be finished");
      expect(logged).toContain(statement);
      expect(logged).toContain("The database is in trouble");
      // Not the values that the statement was run with, which Drizzle puts
      // into its error. The state of this callback is one of them, and it
      // was not used up: the statement that takes it out is the one that
      // failed.
      const state = new URL(callback, "https://pigy.test").searchParams.get(
        "state",
      );
      expect(state).toBeTruthy();
      expect(logged).not.toContain(state);
      expect(await channelsOf(browser, workspaces.sandbox)).toEqual([]);
    },
  );

  it("says so when the person declined", async () => {
    const { browser, workspaces, callback } = await answered("deny");

    const outcome = outcomeOf(await browser.fetch(callback));

    // Not a failure: the person changed their mind.
    expect(outcome).toEqual({
      connect: "cancelled",
      network: "mastodon",
      workspace: workspaces.sandbox,
    });
    expect(await channelsOf(browser, workspaces.sandbox)).toEqual([]);
  });

  it("reports a failure when the network does not hand over the access", async () => {
    const { test, browser, workspaces } = await start();
    const warnings = expectWarnings();
    const url = await consentUrl(browser, workspaces.live, realMastodonDomain);
    const callback = pathOf(await consentAtNetwork(test, url));
    // The server takes the code and then fails, when pigy asks whose
    // account it has been given.
    test.network.mastodon.arm({ kind: "server-error", operation: "account" });

    const outcome = outcomeOf(await browser.fetch(callback));

    expect(outcome).toEqual({
      connect: "failed",
      network: "mastodon",
      workspace: workspaces.live,
    });
    expect(await channelsOf(browser, workspaces.live)).toEqual([]);
    // Why, the address does not say: the log does.
    expect(warnings).toHaveBeenCalledExactlyOnceWith(
      "A connection could not be finished: mastodon.test is having trouble (HTTP 503). Connect the account again.",
    );
    // The code is spent, so the same answer cannot be tried again.
    expect(outcomeOf(await browser.fetch(callback)).connect).toBe("expired");
  });
});

describe("an account that is connected again", () => {
  it("keeps its channel, which is good to use again", async () => {
    const { test, browser, workspaces } = await start();
    const first = await connectInSandbox(browser, workspaces.sandbox);
    const [before] = await storedAccess(workspaces.sandbox);
    // What the publishing of a later phase does when the network refuses
    // the access of a channel. Nothing does it yet.
    await runInDurableObject(objectOf(workspaces.sandbox), (_, state) => {
      state.storage.sql.exec("update channel set status = 'needs_reconnect'");
    });
    test.advance(60_000);

    const second = await connectInSandbox(browser, workspaces.sandbox);

    // The same channel: posts refer to it by its ID.
    expect(second.channel).toBe(first.channel);
    expect(await channelsOf(browser, workspaces.sandbox)).toMatchObject([
      {
        id: first.channel,
        status: "connected",
        connectedAt: test.clock.time.getTime(),
      },
    ]);
    // It has the access of the second connection.
    const [after] = await storedAccess(workspaces.sandbox);
    expect(after?.credentials).not.toBe(before?.credentials);
  });

  it("is told from another account of the same server", async () => {
    const { browser, workspaces } = await start();

    await connectInSandbox(browser, workspaces.sandbox);
    await connectInSandbox(
      browser,
      workspaces.sandbox,
      `@alan@${sandboxMastodonDomain}`,
    );

    const channels = await channelsOf(browser, workspaces.sandbox);
    expect(channels.map(({ handle }) => handle).sort()).toEqual([
      "@ada@mastodon.example",
      "@alan@mastodon.example",
    ]);
  });
});
