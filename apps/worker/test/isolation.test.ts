import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { errorResponseSchema, sandboxMastodonDomain } from "@pigy/core";
import { createWorld, simulationNotice } from "@pigy/simulators/world";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { mastodonApps } from "../src/db/schema.ts";
import { WorldHostMissing, worldFetch } from "../src/sim/world.ts";
import {
  channelsOf,
  connectInSandbox,
  connectLive,
  consentInSandbox,
  consentUrl,
  disconnected,
  offeredAccounts,
  pathOf,
  type SandboxToken,
  startConnect,
  worldEntries,
} from "./channels.ts";
import {
  adminEmail,
  entriesOf,
  expectErrors,
  invite,
  realMastodonDomain,
  setup,
  signedIn,
  type TestSetup,
} from "./helpers.ts";
import { identityOf, workspaceIds } from "./sync-client.ts";

const memberEmail = "member@example.com";
const ada = `@ada@${sandboxMastodonDomain}`;

/** The admin and a member, both signed in, and their workspaces. */
async function start() {
  const test = setup();
  await invite(test, memberEmail);
  const admin = await signedIn(test, { email: adminEmail });
  const member = await signedIn(test, { email: memberEmail });
  return {
    test,
    admin,
    member,
    ofAdmin: await workspaceIds(admin),
    ofMember: await workspaceIds(member),
  };
}

/** The tokens that a simulated world has given out for accounts. */
async function accountTokens(workspaceId: string) {
  const tokens = await worldEntries<SandboxToken>(
    workspaceId,
    "token/mastodon/",
  );
  return tokens.filter(({ accountId }) => accountId !== null);
}

it("keeps what is connected in a sandbox out of the live workspace, and the other way round", async () => {
  const { test, admin, ofAdmin } = await start();

  await connectInSandbox(admin, ofAdmin.sandbox);
  await connectLive(test, admin, ofAdmin.live);

  expect(
    (await channelsOf(admin, ofAdmin.sandbox)).map(({ handle }) => handle),
  ).toEqual([ada]);
  expect(
    (await channelsOf(admin, ofAdmin.live)).map(({ handle }) => handle),
  ).toEqual([`@rosalind@${realMastodonDomain}`]);
});

it("gives everybody a simulated world of their own", async () => {
  const { admin, member, ofAdmin, ofMember } = await start();

  // The same simulated account, as far as its name goes.
  const first = await connectInSandbox(admin, ofAdmin.sandbox);
  await connectInSandbox(member, ofMember.sandbox);

  // Two accounts in two worlds, each with a token that the other world has
  // never seen.
  const [ofFirst] = await accountTokens(ofAdmin.sandbox);
  const [ofSecond] = await accountTokens(ofMember.sandbox);
  expect(ofFirst?.token).not.toBe(ofSecond?.token);
  expect(await channelsOf(member, ofMember.sandbox)).toHaveLength(1);

  // What one person does in their world leaves the other's alone.
  await disconnected(admin, ofAdmin.sandbox, first.channel ?? "");
  expect(await accountTokens(ofAdmin.sandbox)).toMatchObject([
    { revoked: true },
  ]);
  expect(await accountTokens(ofMember.sandbox)).toMatchObject([
    { revoked: false },
  ]);
  expect(await channelsOf(member, ofMember.sandbox)).toHaveLength(1);
});

it("registers pigy once with a real server, and once in every simulated world", async () => {
  const { test, admin, member, ofAdmin, ofMember } = await start();

  await connectInSandbox(admin, ofAdmin.sandbox);
  await connectInSandbox(member, ofMember.sandbox);
  await connectLive(test, admin, ofAdmin.live);
  await connectLive(test, member, ofMember.live);

  // The simulated server of one world is not that of another, though they
  // have the same name: a registration with one is unknown to the other.
  const registrations = await test.db
    .select({ scope: mastodonApps.scope, domain: mastodonApps.domain })
    .from(mastodonApps);
  expect(registrations.sort((a, b) => a.scope.localeCompare(b.scope))).toEqual(
    [
      { scope: "live", domain: realMastodonDomain },
      { scope: ofAdmin.sandbox, domain: sandboxMastodonDomain },
      { scope: ofMember.sandbox, domain: sandboxMastodonDomain },
    ].sort((a, b) => a.scope.localeCompare(b.scope)),
  );
  // The real server was asked to register pigy once, for both people.
  expect(test.network.world.table("mastodon", "app").all()).toHaveLength(1);
});

it("lets one real account be connected to two workspaces, which then share its access", async () => {
  const { test, admin, member, ofAdmin, ofMember } = await start();
  const first = await connectLive(test, admin, ofAdmin.live);
  await connectLive(test, member, ofMember.live);
  const accountTokens = () =>
    test.network.world
      .tokens("mastodon")
      .filter(({ accountId }) => accountId !== null);
  // Mastodon gives out the token that exists for an account and a
  // registration, and the registration is the same for everybody.
  expect(accountTokens()).toHaveLength(1);

  const revoked = await disconnected(admin, ofAdmin.live, first.channel ?? "");

  // Decided in PLAN.md section 19: whoever disconnects ends pigy's access
  // to the account, also for the other workspace. Its channel stays as it
  // is, and turns out to need connecting again when it is next used.
  expect(revoked).toBe(true);
  expect(accountTokens()).toMatchObject([{ revoked: true }]);
  expect(await channelsOf(member, ofMember.live)).toMatchObject([
    { handle: `@rosalind@${realMastodonDomain}`, status: "connected" },
  ]);
});

describe("where a workspace reaches the networks", () => {
  // What an adapter asks a Mastodon server first, as it goes into the
  // object of a simulated world.
  const instanceRequest = {
    url: `https://${sandboxMastodonDomain}/api/v2/instance`,
    method: "GET",
    headers: [],
    body: null,
  };

  it("cannot reach a real server from a sandbox", async () => {
    const { test, admin, ofAdmin } = await start();

    // The name of a server that is there, where the real networks are.
    const response = await startConnect(admin, ofAdmin.sandbox, {
      network: "mastodon",
      identifier: realMastodonDomain,
    });

    // The simulated world has no such server, and the request went nowhere
    // else. The answer is about what was entered, not about a server that
    // may be back later: it never will be, in a sandbox.
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "InvalidInputError",
      message: `The sandbox has no server ${realMastodonDomain}. Enter ${sandboxMastodonDomain}, its simulated server.`,
      field: "identifier",
    });
    expect(test.network.requests).toEqual([]);
  });

  it("cannot reach a simulated server from a live workspace", async () => {
    const { test, admin, ofAdmin } = await start();
    expectErrors();

    const response = await startConnect(admin, ofAdmin.live, {
      network: "mastodon",
      identifier: sandboxMastodonDomain,
    });

    // The request went where the real networks are, which have no server
    // of that name. No simulated world was asked: neither the one of this
    // person's sandbox nor one under the name of the live workspace holds
    // anything, not even whose it is.
    expect(response.status).toBe(502);
    expect(test.network.requests).toEqual([
      `GET https://${sandboxMastodonDomain}/api/v2/instance`,
    ]);
    expect(await worldEntries(ofAdmin.sandbox, "")).toEqual([]);
    expect(await worldEntries(ofAdmin.live, "")).toEqual([]);
  });

  it("has no simulated world for a live workspace", async () => {
    const { test, ofAdmin } = await start();
    const live = await identityOf(test, ofAdmin.live);

    // The Worker's own way into a world refuses.
    expect(() => worldFetch(env.SIM_WORLD, live)).toThrow(
      "The live workspace has no simulation",
    );
    // So does the object, if the Worker ever asked it all the same.
    const answer = await env.SIM_WORLD.getByName(live.id).request(
      live,
      instanceRequest,
    );
    expect(answer).toBeUndefined();
  });

  it("does not answer for another workspace than the one a world belongs to", async () => {
    const { test, admin, ofAdmin, ofMember } = await start();
    await connectInSandbox(admin, ofAdmin.sandbox);
    const ofSomebodyElse = await identityOf(test, ofMember.sandbox);

    // What a mistake in the Worker's routing would do: ask the world of one
    // person for another.
    const answer = await env.SIM_WORLD.getByName(ofAdmin.sandbox).request(
      ofSomebodyElse,
      instanceRequest,
    );
    expect(answer).toBeUndefined();
    // The Worker's way in turns that into a failure, not into an answer.
    await expect(
      worldFetch(env.SIM_WORLD, {
        ...ofSomebodyElse,
        id: ofAdmin.sandbox,
      })(`https://${sandboxMastodonDomain}/api/v2/instance`),
    ).rejects.toThrow("is another workspace's");
  });
});

/**
 * Arms the fault that a person arms in their sandbox to see what pigy does
 * when a connection breaks: the simulated Mastodon server of the world
 * loses its answer to the next request for its description.
 */
function armLostAnswer(
  { clock }: Pick<TestSetup, "clock">,
  workspaceId: string,
) {
  return runInDurableObject(
    env.SIM_WORLD.getByName(workspaceId),
    (_, state) => {
      createWorld({
        storage: state.storage.kv,
        now: () => clock.time,
      }).faults.arm("mastodon", {
        kind: "lost-response",
        operation: "instance",
      });
    },
  );
}

/**
 * Makes every call into a simulated world fail with `failure`, in the
 * place of the runtime: the Worker gets a stub that fails, and no object is
 * asked.
 */
function failWorlds(failure: Error) {
  const stub = { request: () => Promise.reject(failure) };
  const failing = vi
    .spyOn(env.SIM_WORLD, "getByName")
    .mockReturnValue(
      stub as unknown as ReturnType<typeof env.SIM_WORLD.getByName>,
    );
  onTestFinished(() => failing.mockRestore());
}

describe("what goes wrong inside a simulated world", () => {
  it.each([
    ["was lost on the way, or reset by a deploy", "retryable"],
    ["has more to do than it can take", "overloaded"],
  ] as const)(
    "is a server out of reach when the world %s",
    async (_name, mark) => {
      const { test, admin, ofAdmin } = await start();
      expectErrors();
      // What the runtime fails a call into an object with when the trouble is
      // its own, between the Worker and the object. A test cannot break the
      // runtime, so the error is made here, with the mark that the runtime
      // puts on such a one: "Error handling" in the documentation of Durable
      // Objects.
      failWorlds(
        Object.assign(new Error("Network connection lost."), { [mark]: true }),
      );

      const response = await startConnect(admin, ofAdmin.sandbox, {
        network: "mastodon",
        identifier: sandboxMastodonDomain,
      });

      // As for a live workspace whose server does not answer: nothing is
      // wrong with what was entered, and trying again later can work.
      expect(response.status).toBe(502);
      expect(errorResponseSchema.parse(await response.json()).message).toBe(
        `${sandboxMastodonDomain} could not be reached.`,
      );
      // To an adapter it is a `fetch` that got no answer, and not for good
      // like a host that the world does not have. What the runtime said is
      // kept, for whoever reads the log.
      const sandbox = await identityOf(test, ofAdmin.sandbox);
      const error = await worldFetch(
        env.SIM_WORLD,
        sandbox,
      )(`https://${sandboxMastodonDomain}/api/v2/instance`).catch(
        (thrown: unknown) => thrown,
      );
      expect(error).toBeInstanceOf(TypeError);
      expect(error).not.toBeInstanceOf(WorldHostMissing);
      expect(error).toMatchObject({
        cause: { message: "Network connection lost.", [mark]: true },
      });
    },
  );

  it("is not taken for a server that is out of reach when the object of the world fails", async () => {
    const { admin, ofAdmin } = await start();
    const errors = expectErrors();
    // A bug in a simulator or in the object, as it comes out of an object:
    // the runtime says that it was thrown over there, which is no mark of
    // trouble of its own.
    failWorlds(
      Object.assign(new Error("A simulator has a bug"), { remote: true }),
    );

    const response = await startConnect(admin, ofAdmin.sandbox, {
      network: "mastodon",
      identifier: sandboxMastodonDomain,
    });

    // A failure of pigy, to be heard of, and not a server to try again
    // later.
    expect(response.status).toBe(500);
    expect(entriesOf(errors)).toEqual([
      expect.objectContaining({
        kind: "request",
        error: expect.objectContaining({ message: "A simulator has a bug" }),
      }),
    ]);
  });

  it("is not taken for a server that is out of reach when the world is somebody else's", async () => {
    const { admin, ofAdmin } = await start();
    const errors = expectErrors();
    // What a mistake in the Worker, or in its data, would lead to: the
    // world under the name of the admin's sandbox belongs to another
    // person.
    await runInDurableObject(
      env.SIM_WORLD.getByName(ofAdmin.sandbox),
      (_, state) => {
        state.storage.kv.put("object/workspace", {
          id: ofAdmin.sandbox,
          ownerId: "somebody-else",
        });
      },
    );

    const response = await startConnect(admin, ofAdmin.sandbox, {
      network: "mastodon",
      identifier: sandboxMastodonDomain,
    });

    // A failure of pigy, and not the 502 of a server to try again later:
    // the check is there to be heard of.
    expect(response.status).toBe(500);
    expect(errorResponseSchema.parse(await response.json())).toEqual({
      error: "UnexpectedError",
      message: "Something went wrong",
    });
    expect(entriesOf(errors)).toEqual([
      expect.objectContaining({
        kind: "request",
        error: expect.objectContaining({
          message: `The simulated world of workspace ${ofAdmin.sandbox} is another workspace's`,
        }),
      }),
    ]);
  });

  it("tells a host that the world does not have from an answer that got lost", async () => {
    const { test, ofAdmin } = await start();
    const sandbox = await identityOf(test, ofAdmin.sandbox);
    const fetch = worldFetch(env.SIM_WORLD, sandbox);
    const failure = (host: string) =>
      fetch(`https://${host}/api/v2/instance`).then(
        () => undefined,
        (error: unknown) => error,
      );
    // A world with its server, and a fault that waits for the next request
    // to that server.
    expect(await failure(sandboxMastodonDomain)).toBeUndefined();
    await armLostAnswer(test, ofAdmin.sandbox);

    const missing = await failure(realMastodonDomain);
    const lost = await failure(sandboxMastodonDomain);

    // Both fail the way a `fetch` does, and only the first is for good.
    expect(missing).toBeInstanceOf(WorldHostMissing);
    expect(missing).toMatchObject({ host: realMastodonDomain });
    expect(lost).toBeInstanceOf(TypeError);
    expect(lost).not.toBeInstanceOf(WorldHostMissing);
    // The request for the host that no network of the world has went to
    // none of them: the fault was still there for the request after it.
    expect(lost).toMatchObject({
      message: "The simulated Mastodon lost its answer on the way back",
    });
  });

  it("is a server out of reach when a simulated server loses its answer", async () => {
    const { test, admin, ofAdmin } = await start();
    expectErrors();
    await armLostAnswer(test, ofAdmin.sandbox);

    const response = await startConnect(admin, ofAdmin.sandbox, {
      network: "mastodon",
      identifier: sandboxMastodonDomain,
    });

    // That is what it is to the adapter, as it would be on the internet.
    expect(response.status).toBe(502);
    expect(errorResponseSchema.parse(await response.json()).message).toBe(
      `${sandboxMastodonDomain} could not be reached.`,
    );
    // The fault has struck, and the same request works the next time.
    expect(
      (
        await startConnect(admin, ofAdmin.sandbox, {
          network: "mastodon",
          identifier: sandboxMastodonDomain,
        })
      ).status,
    ).toBe(200);
  });
});

describe("the pages of a simulated network", () => {
  it("say that they are a simulation, and offer the accounts of a new world", async () => {
    const { admin, ofAdmin } = await start();
    const url = await consentUrl(admin, ofAdmin.sandbox, sandboxMastodonDomain);

    const page = await admin.fetch(pathOf(url));

    expect(page.headers.get("Content-Type")).toContain("text/html");
    // Not to be kept by a browser or a proxy: it is one person's.
    expect(page.headers.get("Cache-Control")).toBe("no-store");
    const html = await page.clone().text();
    expect(html).toContain("Simulation");
    expect(html).toContain(simulationNotice);
    expect([...(await offeredAccounts(page)).keys()]).toEqual([
      "@ada@mastodon.example",
      "@grace@mastodon.example",
      "@alan@mastodon.example",
    ]);
  });

  it("are shown to nobody who is not signed in", async () => {
    const { test, admin, ofAdmin } = await start();
    const url = await consentUrl(admin, ofAdmin.sandbox, sandboxMastodonDomain);

    const page = await test.browser().fetch(pathOf(url));

    expect(page.status).toBe(401);
    expect(await page.text()).not.toContain("@ada");
    // The address is the same for everybody, and what it shows is not: no
    // answer to it is one to keep, also not this one.
    expect(page.headers.get("Cache-Control")).toBe("no-store");
  });

  it("show everybody their own world, whatever the address", async () => {
    const { admin, member, ofAdmin } = await start();
    const url = await consentUrl(admin, ofAdmin.sandbox, sandboxMastodonDomain);

    // The address of the admin's consent page, opened by the member, and
    // then answered in their place.
    const page = await member.fetch(pathOf(url));
    const answer = await member.fetch(pathOf(url), {
      form: { action: "deny" },
    });

    // The address names no world, so the member is in their own, where the
    // connection of the admin is unknown: pigy never registered there. The
    // page is the simulated server's own refusal.
    expect(page.status).toBe(401);
    expect(await page.text()).toContain("Client authentication failed");
    expect(answer.status).toBe(401);
    // The admin's connection is untouched, and still theirs to finish.
    const callback = await consentInSandbox(admin, url, { handle: ada });
    expect(new URL(callback).searchParams.get("code")).toBeTruthy();
  });

  it.each([
    ["no Origin", null],
    ["the Origin of another site", "https://evil.example"],
  ])("take no answer that comes with %s", async (_name, origin) => {
    const { admin, ofAdmin } = await start();
    const url = await consentUrl(admin, ofAdmin.sandbox, sandboxMastodonDomain);
    const accounts = await offeredAccounts(await admin.fetch(pathOf(url)));

    // A form on another site, posted with the cookie of the admin.
    const answer = await admin.fetch(pathOf(url), {
      form: { account: accounts.get(ada) ?? "" },
      headers: { Origin: origin },
    });

    expect(answer.status).toBe(403);
    expect(answer.headers.get("Location")).toBeNull();
  });

  it("do not send the browser to another site, whatever the simulated network answers", async () => {
    const { test, admin, ofAdmin } = await start();
    // The world exists and has the server.
    await connectInSandbox(admin, ofAdmin.sandbox);
    // An application of the simulated server whose redirect address is at
    // another site. Nobody can register one from outside: the API of a
    // world is the Worker's alone, which is how the test does it. It
    // stands for whatever a simulator might one day take for an address
    // to send a browser to.
    const elsewhere = "https://evil.example/connect/mastodon/callback";
    const world = worldFetch(
      env.SIM_WORLD,
      await identityOf(test, ofAdmin.sandbox),
    );
    const registered = await world(
      `https://${sandboxMastodonDomain}/api/v1/apps`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_name: "Elsewhere",
          redirect_uris: elsewhere,
          scopes: "read",
        }),
      },
    );
    const { client_id: clientId } = (await registered.json()) as {
      client_id: string;
    };
    const page = `/sim/network/${sandboxMastodonDomain}/oauth/authorize?${new URLSearchParams(
      {
        client_id: clientId,
        redirect_uri: elsewhere,
        response_type: "code",
        scope: "read",
      },
    )}`;
    // The simulated server has the application and would send the browser
    // to its address: without this, the test would show nothing.
    const [account = ""] = (
      await offeredAccounts(await admin.fetch(page))
    ).values();
    expect(account).not.toBe("");

    const answered = await admin.fetch(page, { form: { account } });

    expect(answered.status).toBe(400);
    expect(answered.headers.get("Location")).toBeNull();
    expect(errorResponseSchema.parse(await answered.json()).message).toBe(
      "The simulated network would send the browser to another site",
    );
  });

  it.each([
    // The API of the simulated server, which is for the adapter alone.
    ["GET", "/api/v2/instance"],
    ["POST", "/api/v1/apps"],
    ["POST", "/oauth/token"],
    ["POST", "/oauth/revoke"],
    ["GET", "/api/v1/accounts/verify_credentials"],
    // Not an address of a server at all.
    ["GET", ""],
  ])("do not include %s %s of a simulated server", async (method, path) => {
    const { admin, ofAdmin } = await start();
    // The world exists and has the server.
    await connectInSandbox(admin, ofAdmin.sandbox);

    const response = await admin.fetch(
      `/sim/network/${sandboxMastodonDomain}${path}`,
      { method, ...(method === "POST" && { form: { client_name: "x" } }) },
    );

    expect(response.status).toBe(404);
    expect(errorResponseSchema.parse(await response.json()).error).toBe(
      "NotFoundError",
    );
  });

  it.each([
    ["a server that the world does not have", realMastodonDomain],
    // Read as an address, this would name another host than it seems to.
    ["a host with credentials", `user@${sandboxMastodonDomain}`],
    ["a host with a port", `${sandboxMastodonDomain}:8443`],
    // Made of the letters of a host name, and none: it cannot be read as
    // an address at all.
    ["a host that is no name", "xn--"],
  ])("have none for %s", async (_name, host) => {
    const { test, admin } = await start();

    const response = await admin.fetch(
      `/sim/network/${host}/oauth/authorize?client_id=x`,
    );

    expect(response.status).toBe(404);
    // Whether a world has a server is one person's business too.
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    // Nothing was asked of a real host by that name either.
    expect(test.network.requests).toEqual([]);
  });
});
