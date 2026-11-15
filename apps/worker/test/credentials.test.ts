import { sandboxMastodonDomain } from "@pigy/core";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { mastodonApps, oauthStates, sessions } from "../src/db/schema.ts";
import { createVault } from "../src/vault.ts";
import {
  channelsOf,
  connectInSandbox,
  connectLive,
  consentAtNetwork,
  consentUrl,
  disconnected,
  outcomeOf,
  pathOf,
  type SandboxToken,
  startConnect,
  storedAccess,
  worldEntries,
} from "./channels.ts";
import {
  adminEmail,
  Browser,
  credentialKey,
  credentialKeys,
  expectErrors,
  expectWarnings,
  invite,
  realMastodonDomain,
  setup,
  signedIn,
  signIn,
  signInThroughPages,
  type TestSetup,
  urlOf,
} from "./helpers.ts";
import { SyncClient, workspaceIds } from "./sync-client.ts";

const memberEmail = "member@example.com";

/** A signed-in admin and their workspaces. */
async function start(options: Parameters<typeof setup>[0] = {}) {
  const test = setup(options);
  const browser = await signedIn(test, { email: adminEmail });
  return { test, browser, workspaces: await workspaceIds(browser) };
}

/** The secrets that the Mastodon server of the tests has given to pigy. */
function networkSecrets({ network }: Pick<TestSetup, "network">): string[] {
  return [
    ...network.world.tokens("mastodon").map(({ token }) => token),
    ...network.world
      .table<{ clientSecret: string }>("mastodon", "app")
      .all()
      .map(({ clientSecret }) => clientSecret),
  ];
}

/** The same for the simulated world of a sandbox. */
async function sandboxSecrets(workspaceId: string): Promise<string[]> {
  const tokens = await worldEntries<SandboxToken>(
    workspaceId,
    "token/mastodon/",
  );
  const apps = await worldEntries<{ clientSecret: string }>(
    workspaceId,
    "mastodon/app/",
  );
  return [
    ...tokens.map(({ token }) => token),
    ...apps.map(({ clientSecret }) => clientSecret),
  ];
}

/** Everything that the tables of the app hold for connections, as text. */
async function storedText(test: TestSetup, workspaceId: string) {
  return JSON.stringify([
    await test.db.select().from(mastodonApps),
    await test.db.select().from(oauthStates),
    await storedAccess(workspaceId),
  ]);
}

it("stores the secrets of a connection sealed, and nowhere in the clear", async () => {
  const { test, browser, workspaces } = await start();

  // A connection that is finished, and one that has only begun.
  await connectLive(test, browser, workspaces.live);
  await consentUrl(browser, workspaces.live, realMastodonDomain);

  const secrets = networkSecrets(test);
  // The token of the account, the token that pigy checked its registration
  // with, and the secret of that registration.
  expect(secrets).toHaveLength(3);
  const stored = await storedText(test, workspaces.live);
  for (const secret of secrets) expect(stored).not.toContain(secret);

  // What is stored in their place is sealed with the key of the
  // deployment, whose version leads.
  const [registration] = await test.db.select().from(mastodonApps);
  const [pending] = await test.db.select().from(oauthStates);
  const [channel] = await storedAccess(workspaces.live);
  for (const sealed of [
    registration?.registration,
    pending?.pending,
    channel?.credentials,
  ]) {
    expect(sealed).toMatch(/^1\.[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+$/);
  }

  // The same vault opens them, each in its place and in no other: this is
  // what the adapter gets back.
  const vault = createVault(credentialKeys);
  if (typeof vault === "string") throw new Error(vault);
  const [connected] = await channelsOf(browser, workspaces.live);
  const credentials = await vault.open(
    ["channel", workspaces.live, "mastodon", connected?.accountId ?? ""],
    channel?.credentials ?? "",
  );
  expect(credentials).toMatchObject({ domain: realMastodonDomain });
  expect(secrets).toContain(
    (credentials as { accessToken: string }).accessToken,
  );
  // A connection that has begun keeps what proves to the server that the
  // one who finishes is the one who began.
  expect(
    await vault.open(
      [
        "oauth_state",
        pending?.state ?? "",
        pending?.sessionId ?? "",
        workspaces.live,
        "mastodon",
      ],
      pending?.pending ?? "",
    ),
  ).toMatchObject({ codeVerifier: expect.any(String) });
});

describe("a connection that has begun", () => {
  /**
   * The admin and a member, and a connection that the admin has begun in
   * their live workspace and that the server has answered.
   */
  async function begun() {
    const context = await start();
    await invite(context.test, memberEmail);
    const member = await signedIn(context.test, { email: memberEmail });
    const url = await consentUrl(
      context.browser,
      context.workspaces.live,
      realMastodonDomain,
    );
    const callback = pathOf(await consentAtNetwork(context.test, url));
    const [row] = await context.test.db.select().from(oauthStates);
    if (!row) throw new Error("Nothing was kept of the connection");
    return { ...context, member, callback, row };
  }

  type Begun = Awaited<ReturnType<typeof begun>>;

  // What somebody can do who writes to the database and has no key: a row
  // says whose connection it is, and they change what it says.
  it.each([
    [
      "another session",
      async ({ test, member, callback, row }: Begun) => {
        const all = await test.db.select({ id: sessions.id }).from(sessions);
        // The admin and the member have a session each.
        const other = all.find(({ id }) => id !== row.sessionId);
        await test.db.update(oauthStates).set({ sessionId: other?.id ?? "" });
        return member.fetch(callback);
      },
    ],
    [
      "another workspace",
      async ({ test, browser, workspaces, callback }: Begun) => {
        await test.db
          .update(oauthStates)
          .set({ workspaceId: workspaces.sandbox });
        return browser.fetch(callback);
      },
    ],
    [
      "another network",
      async ({ test, browser, callback }: Begun) => {
        await test.db.update(oauthStates).set({ network: "bluesky" });
        return browser.fetch(callback.replace("/mastodon/", "/bluesky/"));
      },
    ],
  ])("does not open for %s than it was sealed for", async (_name, tamper) => {
    const context = await begun();
    const { test, browser, member, workspaces } = context;
    const warnings = expectWarnings();
    const asked = test.network.requests.length;

    const outcome = outcomeOf(await tamper(context));

    // It was found, since the row says that it is this one's, and it did
    // not open. So it names no workspace: nothing in the row is believed.
    expect(outcome.connect).toBe("failed");
    expect(outcome.workspace).toBeUndefined();
    expect(warnings).toHaveBeenCalledExactlyOnceWith(
      "A connection could not be finished: The value was not sealed with this key and for this place",
    );
    // No adapter was handed what was kept, so no server was asked, and
    // nobody has a channel.
    expect(test.network.requests).toHaveLength(asked);
    const ofMember = await workspaceIds(member);
    for (const [who, workspace] of [
      [browser, workspaces.live],
      [browser, workspaces.sandbox],
      [member, ofMember.live],
      [member, ofMember.sandbox],
    ] as const) {
      expect(await channelsOf(who, workspace)).toEqual([]);
    }
  });
});

describe("what leaves the app", () => {
  /**
   * A browser that keeps every answer it gets, a client of the sync
   * protocol that keeps every message, and the lines that the app logs
   * meanwhile.
   */
  function recording(test: TestSetup) {
    const answers: string[] = [];
    const inner = test.browser();
    const browser = new Browser(async (request) => {
      const response = await inner.send(request);
      answers.push(JSON.stringify([...response.headers]));
      // The answer to the handshake of a socket has no body. What is said
      // over the socket, the client keeps.
      if (!response.webSocket) answers.push(await response.clone().text());
      return response;
    }, "https://pigy.test");
    const client = new SyncClient();
    const logged = (["debug", "log", "info", "warn", "error"] as const).map(
      (level) => {
        const spy = vi.spyOn(console, level).mockImplementation(() => {});
        onTestFinished(() => spy.mockRestore());
        return spy;
      },
    );
    return {
      browser,
      client,
      /** Everything that was answered, synced and logged, as one text. */
      text: () =>
        [
          ...answers,
          ...client.received,
          ...logged.flatMap((spy) =>
            spy.mock.calls
              .flat()
              .map((entry) =>
                entry instanceof Error
                  ? `${entry.stack} ${String(entry.cause)}`
                  : String(entry),
              ),
          ),
        ].join("\\n"),
    };
  }

  it("holds no secret of a real account, whatever happens to its connection", async () => {
    const test = setup({
      // The server fails when it is asked to take a token back.
      interceptNetwork: (network) => async (input, init) =>
        urlOf(input).endsWith("/oauth/revoke")
          ? new Response("Service unavailable", { status: 503 })
          : network(input, init),
    });
    const { browser, client, text } = recording(test);
    await signIn(test, browser, { email: adminEmail });
    const workspaces = await workspaceIds(browser);
    await client.connect(browser, workspaces.live);

    // A connection that fails after the server has given out a token.
    const url = await consentUrl(browser, workspaces.live, realMastodonDomain);
    const callback = pathOf(await consentAtNetwork(test, url));
    test.network.mastodon.arm({ kind: "server-error", operation: "account" });
    expect(outcomeOf(await browser.fetch(callback)).connect).toBe("failed");
    // One that works, one that begins and is refused, and a disconnect that
    // the server does not go along with. The client hears of the channel
    // when it comes and when it goes.
    const { channel = "" } = await connectLive(test, browser, workspaces.live);
    await client.patch();
    test.network.mastodon.arm({ kind: "server-error", operation: "instance" });
    await startConnect(browser, workspaces.live, {
      network: "mastodon",
      identifier: realMastodonDomain,
    });
    expect(await disconnected(browser, workspaces.live, channel)).toBe(false);
    await client.patch();

    const secrets = networkSecrets(test);
    expect(secrets.length).toBeGreaterThanOrEqual(3);
    const left = text();
    // The log did get the failures and the client did get the channel, so
    // there was something to leak into.
    expect(left).toContain("A connection could not be finished");
    expect(left).toContain("The access of a channel was not given back");
    expect(left).toContain(`@rosalind@${realMastodonDomain}`);
    for (const secret of secrets) expect(left).not.toContain(secret);
  });

  it("holds no secret of a simulated account either", async () => {
    const test = setup();
    const { browser, client, text } = recording(test);
    await signIn(test, browser, { email: adminEmail });
    const workspaces = await workspaceIds(browser);
    await client.connect(browser, workspaces.sandbox);

    const { channel = "" } = await connectInSandbox(
      browser,
      workspaces.sandbox,
    );
    await client.patch();
    const secrets = await sandboxSecrets(workspaces.sandbox);
    await disconnected(browser, workspaces.sandbox, channel);
    await client.patch();

    expect(secrets).toHaveLength(3);
    const left = text();
    for (const secret of secrets) expect(left).not.toContain(secret);
    // The simulated server did hand the browser something on the way: the
    // code, which is spent, and which is not among the secrets it keeps.
    expect(left).toContain("code=pigy-sim-");
  });
});

describe("the keys of a deployment", () => {
  it("refuses to connect anything in a deployment without keys", async () => {
    const { test, browser, workspaces } = await start({
      env: { CREDENTIAL_KEYS: undefined },
    });
    const errors = expectErrors();

    const live = await startConnect(browser, workspaces.live, {
      network: "mastodon",
      identifier: realMastodonDomain,
    });
    const sandbox = await startConnect(browser, workspaces.sandbox, {
      network: "mastodon",
      identifier: sandboxMastodonDomain,
    });

    for (const response of [live, sandbox]) {
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        error: "UnexpectedError",
        message: "This pigy is not set up to connect accounts.",
      });
    }
    // Refused before anything was done: nothing was asked of a server, no
    // registration was made, and nothing was stored, sealed or not.
    expect(test.network.requests).toEqual([]);
    expect(await worldEntries(workspaces.sandbox, "")).toEqual([]);
    expect(await test.db.select().from(mastodonApps)).toEqual([]);
    expect(await test.db.select().from(oauthStates)).toEqual([]);
    // The operator is told what is missing.
    expect(errors.mock.calls.flat().join("\\n")).toContain(
      "CREDENTIAL_KEYS is not set",
    );
  });

  it("refuses to connect with keys that are not valid, and keeps them out of the log", async () => {
    const mistyped = `1:${credentialKey(1).slice(0, -6)}`;
    const { test, browser, workspaces } = await start({
      env: { CREDENTIAL_KEYS: mistyped },
    });
    const errors = expectErrors();

    const response = await startConnect(browser, workspaces.live, {
      network: "mastodon",
      identifier: realMastodonDomain,
    });

    expect(response.status).toBe(503);
    expect(test.network.requests).toEqual([]);
    const logged = errors.mock.calls.flat().join("\\n");
    expect(logged).toContain("CREDENTIAL_KEYS is not valid");
    expect(logged).not.toContain(mistyped.slice(2));
  });

  it("still removes a channel when its keys are gone", async () => {
    const { test, browser, workspaces } = await start();
    const { channel = "" } = await connectLive(test, browser, workspaces.live);
    expectErrors();
    test.redeploy({ CREDENTIAL_KEYS: undefined });

    const revoked = await disconnected(browser, workspaces.live, channel);

    // The access could not be given back: nothing opens the credentials.
    expect(revoked).toBe(false);
    expect(await channelsOf(browser, workspaces.live)).toEqual([]);
  });

  it("does not finish under other keys what was begun", async () => {
    const { test, browser, workspaces } = await start();
    const url = await consentUrl(browser, workspaces.live, realMastodonDomain);
    const callback = pathOf(await consentAtNetwork(test, url));
    const warnings = expectWarnings();
    // The same version, another key.
    test.redeploy({ CREDENTIAL_KEYS: `1:${credentialKey(2)}` });

    const outcome = outcomeOf(await browser.fetch(callback));

    expect(outcome).toEqual({ connect: "failed", network: "mastodon" });
    expect(warnings).toHaveBeenCalledOnce();
    expect(await channelsOf(browser, workspaces.live)).toEqual([]);
  });

  it("works on with other keys, without what the old ones sealed", async () => {
    const { test, browser, workspaces } = await start();
    const first = await connectLive(test, browser, workspaces.live);
    expectWarnings();
    test.redeploy({ CREDENTIAL_KEYS: `1:${credentialKey(2)}` });
    const registrations = () =>
      test.network.world.table("mastodon", "app").all();
    expect(registrations()).toHaveLength(1);

    // The registration with the server is one of the things that no longer
    // open. It is a cache: pigy registers again.
    const second = await connectLive(test, browser, workspaces.live);

    expect(second).toMatchObject({
      connect: "connected",
      channel: first.channel,
    });
    expect(registrations()).toHaveLength(2);
    // The channel has credentials under the new key now, which open.
    expect(
      await disconnected(browser, workspaces.live, second.channel ?? ""),
    ).toBe(true);
  });

  it("goes on opening what an older key sealed once a newer one is added", async () => {
    const { test, browser, workspaces } = await start();
    const { channel = "" } = await connectLive(test, browser, workspaces.live);
    const [before] = await storedAccess(workspaces.live);
    expect(before?.credentials?.startsWith("1.")).toBe(true);
    // How a key is replaced: a new one with a higher version, next to the
    // old one.
    test.redeploy({
      CREDENTIAL_KEYS: `2:${credentialKey(2)},${credentialKeys}`,
    });

    // The registration from before still opens, so pigy does not register
    // again, and what is sealed from now on is sealed with the new key.
    await connectLive(test, browser, workspaces.live);
    const [after] = await storedAccess(workspaces.live);
    expect(test.network.world.table("mastodon", "app").all()).toHaveLength(1);
    expect(after?.credentials?.startsWith("2.")).toBe(true);

    expect(await disconnected(browser, workspaces.live, channel)).toBe(true);
  });

  it("opens the credentials of a channel with the older key that sealed them", async () => {
    const { test, browser, workspaces } = await start();
    const { channel = "" } = await connectLive(test, browser, workspaces.live);
    test.redeploy({
      CREDENTIAL_KEYS: `2:${credentialKey(2)},${credentialKeys}`,
    });

    // Nothing has sealed the credentials again since: the old key opens
    // them, and the access is given back.
    expect(await disconnected(browser, workspaces.live, channel)).toBe(true);
    expect(
      test.network.world
        .tokens("mastodon")
        .filter(({ accountId }) => accountId !== null),
    ).toMatchObject([{ revoked: true }]);
  });
});

describe("a build for development", () => {
  // Where `pnpm dev` serves the app.
  const local = "http://localhost:5173";

  /** The app as `pnpm dev` runs it after a fresh clone: nothing configured. */
  function setupDevelopment() {
    return setup({
      simulatedGoogle: true,
      developmentCredentialKeys: true,
      env: {
        GOOGLE_CLIENT_ID: undefined,
        GOOGLE_CLIENT_SECRET: undefined,
        ADMIN_EMAILS: undefined,
        CREDENTIAL_KEYS: undefined,
      },
    });
  }

  it("connects accounts without any configuration", async () => {
    const test = setupDevelopment();
    const browser = test.browser(local);
    await signInThroughPages(browser, adminEmail);
    const workspaces = await workspaceIds(browser);

    const response = await startConnect(browser, workspaces.sandbox, {
      network: "mastodon",
      identifier: sandboxMastodonDomain,
    });

    expect(response.status).toBe(200);
    // The consent page is at the address that the app is reached at.
    expect(new URL((await response.json<{ url: string }>()).url).origin).toBe(
      local,
    );
    // Sealed with the key from the repository, which version 0 marks.
    const [pending] = await test.db.select().from(oauthStates);
    expect(pending?.pending.startsWith("0.")).toBe(true);
  });

  it("refuses to connect where it is not reached locally", async () => {
    // A build with the development key that was deployed by mistake, with
    // Google credentials and without keys.
    const { browser, workspaces } = await start({
      developmentCredentialKeys: true,
      env: { CREDENTIAL_KEYS: undefined },
    });
    expectErrors();

    const response = await startConnect(browser, workspaces.sandbox, {
      network: "mastodon",
      identifier: sandboxMastodonDomain,
    });

    // The key in the repository seals nothing that anybody else can reach.
    expect(response.status).toBe(503);
  });
});
