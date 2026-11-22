import { runInDurableObject } from "cloudflare:test";
import {
  connectErrorSchema,
  defaultMediaLimits,
  maxConnectIdentifierLength,
  sandboxMastodonDomain,
} from "@pigy/core";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { pendingLifetimeMs } from "../src/channels/pending.ts";
import { oauthStates } from "../src/db/schema.ts";
import { WorkspaceStore } from "../src/workspace/store.ts";
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
  entriesOf,
  expectErrors,
  expectWarnings,
  invite,
  logged,
  realMastodonDomain,
  saidBy,
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
      // What the simulated server lets its accounts post, read from it.
      limits: {
        network: "mastodon",
        maxCharacters: 500,
        charactersPerUrl: 23,
        // What the instance takes of images, which it says too.
        media: defaultMediaLimits.mastodon,
      },
      limitsCheckedAt: test.clock.time.getTime(),
    },
  ]);
  // Everything was answered by the simulated world of the sandbox: nothing
  // went to where the real networks are.
  expect(test.network.requests).toEqual([]);
});

it("connects an account whose limits cannot be read, without them", async () => {
  const { test, browser, workspaces } = await start();
  const warnings = expectWarnings();
  const url = await consentUrl(browser, workspaces.live, realMastodonDomain);
  const callback = await consentAtNetwork(test, url);
  // The server fails the next time it is asked about itself, which is when
  // the app asks what the account may post: it has handed over the access
  // by then.
  test.network.mastodon.arm({ kind: "server-error", operation: "instance" });

  const outcome = outcomeOf(await browser.fetch(pathOf(callback)));

  // The access was given, and is not thrown away for a question that can
  // be asked again later.
  expect(outcome.connect).toBe("connected");
  expect(await channelsOf(browser, workspaces.live)).toMatchObject([
    { status: "connected", limits: null, limitsCheckedAt: null },
  ]);
  expect(saidBy(warnings)).toContain(
    `The limits of an account were not read: ${realMastodonDomain} is having trouble (HTTP 503).`,
  );
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
    // As a form reads it: with the field that the message belongs to, if
    // the answer names one.
    const refusal = connectErrorSchema.parse(await response.json());
    // Nothing is kept of a connection that did not begin.
    expect(await test.db.select().from(oauthStates)).toEqual([]);
    return { status: response.status, ...refusal };
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

      // The message goes next to the field, which the answer names.
      expect(refusal).toEqual({
        status: 400,
        error: "InvalidInputError",
        message:
          "Enter the address of your Mastodon server, such as mastodon.social.",
        field: "identifier",
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
    // server may be back later. So the answer names no field.
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

    // About the server that the person named, so about what they entered.
    expect(refusal).toEqual({
      status: 400,
      error: "InvalidInputError",
      message,
      field: "identifier",
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

  it("tells a person in a sandbox which server the sandbox has", async () => {
    const { test, browser, workspaces } = await start();

    const refusal = await refused(test, browser, workspaces.sandbox, {
      network: "mastodon",
      // A real server, which a person may well enter. The world of a
      // sandbox does not have it, and never will.
      identifier: "mastodon.social",
    });

    // Not the 502 of a server that may be back later: entering the same
    // again will not work. The message says what will.
    expect(refusal).toEqual({
      status: 400,
      error: "InvalidInputError",
      message: `The sandbox has no server mastodon.social. Enter ${sandboxMastodonDomain}, its simulated server.`,
      field: "identifier",
    });
    expect(test.network.requests).toEqual([]);
  });

  it.each([
    ["a network that pigy does not know", { network: "myspace" }, "network"],
    ["no network", { identifier: realMastodonDomain }, "network"],
    [
      // Not a field of a form, so the answer names none.
      "a field that the request does not have",
      { network: "mastodon", identifier: realMastodonDomain, workspace: "x" },
      undefined,
    ],
    [
      "an identifier that is too long",
      {
        network: "mastodon",
        identifier: "a".repeat(maxConnectIdentifierLength + 1),
      },
      "identifier",
    ],
    [
      "an identifier that is not text",
      { network: "mastodon", identifier: 5 },
      "identifier",
    ],
  ])("refuses a request with %s", async (_name, body, field) => {
    const { test, browser, workspaces } = await start();

    const refusal = await refused(test, browser, workspaces.live, body);

    expect(refusal).toMatchObject({ status: 400, error: "InvalidInputError" });
    expect(refusal.field).toBe(field);
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
      const log = errors.mock.calls.flat().map(logged).join("\n");
      expect(log).toContain("A connection could not be finished");
      expect(log).toContain(statement);
      expect(log).toContain("The database is in trouble");
      // Not the values that the statement was run with, which Drizzle puts
      // into its error. The state of this callback is one of them, and it
      // was not used up: the statement that takes it out is the one that
      // failed.
      const state = new URL(callback, "https://pigy.test").searchParams.get(
        "state",
      );
      expect(state).toBeTruthy();
      expect(log).not.toContain(state);
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
    expect(entriesOf(warnings)).toEqual([
      {
        level: "warn",
        kind: "connection",
        message:
          "A connection could not be finished: mastodon.test is having trouble (HTTP 503). Connect the account again.",
        // Where it happened, to search by. The route and not the address:
        // the query of a callback holds its code.
        route: "GET /connect/:network/callback",
        network: "mastodon",
        workspaceId: workspaces.live,
      },
    ]);
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

  it("does not give the access of the connection before back, which on Mastodon is its own", async () => {
    const { test, browser, workspaces } = await start();
    await connectLive(test, browser, workspaces.live);

    const second = await connectLive(test, browser, workspaces.live);
    // Whatever the app has left to do for the connection.
    await Promise.all(test.keptAlive);

    expect(second.connect).toBe("connected");
    // Mastodon gave the second connection the token of the first. A
    // connection that ended the access that it replaced, as one to
    // Bluesky does, would have ended its own.
    const tokens = test.network.world
      .tokens("mastodon")
      .filter(({ accountId }) => accountId !== null);
    expect(
      tokens.map((token) => test.network.world.tokenStatus(token)),
    ).toEqual(["valid"]);
    expect(
      test.network.requests.filter((request) =>
        request.endsWith("/oauth/revoke"),
      ),
    ).toEqual([]);
  });

  it("keeps the access of its channel when the second connection is not stored", async () => {
    const { test, browser, workspaces } = await start();
    const first = await connectLive(test, browser, workspaces.live);
    expect(first.connect).toBe("connected");
    // The workspace fails the next time that it is to store a channel.
    const stores = vi
      .spyOn(WorkspaceStore.prototype, "connectChannel")
      .mockImplementation(() => {
        throw new Error("The database of the workspace is in trouble");
      });
    onTestFinished(() => stores.mockRestore());
    expectErrors();

    const second = await connectLive(test, browser, workspaces.live);
    // Whatever the app has left to do for a connection that failed.
    await Promise.all(test.keptAlive);

    // Asked twice: the answer of the first call could have been lost.
    expect(stores).toHaveBeenCalledTimes(2);
    expect(second).toMatchObject({ connect: "failed", network: "mastodon" });
    // Mastodon gave the second connection the token that the account had
    // with pigy already, which is the one that the channel posts with. A
    // connection that gave its access back when it is not stored, as one
    // to Bluesky does, would have taken the access of that channel away.
    const tokens = test.network.world
      .tokens("mastodon")
      .filter(({ accountId }) => accountId !== null);
    expect(
      tokens.map((token) => test.network.world.tokenStatus(token)),
    ).toEqual(["valid"]);
    expect(
      test.network.requests.filter((request) =>
        request.endsWith("/oauth/revoke"),
      ),
    ).toEqual([]);
    expect(await channelsOf(browser, workspaces.live)).toMatchObject([
      { id: first.channel, status: "connected" },
    ]);
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
