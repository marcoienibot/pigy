import { describe, expect, it } from "vitest";
import {
  agent,
  assertion,
  clientId,
  newClient,
  newKey,
  pkce,
  proof,
  redirectUri,
  scope,
  type TestClient,
} from "../../test/bluesky-client.ts";
import {
  answerConsent,
  createWorld,
  entitiesOf,
  feed,
  isSimulatedSecret,
  simulationNotice,
} from "../world/index.ts";
import {
  accessTokenLifetimeMs,
  type BlueskySimulatorOptions,
  blueskyEntryway,
  createBlueskySimulator,
  dnsResolverHost,
  plcDirectoryHost,
  refreshTokenLifetimeMs,
} from "./index.ts";

const issuer = `https://${blueskyEntryway}`;
const pdsHost = "pds.bsky.test";
const start = new Date("2026-11-15T10:00:00Z");
const minute = 60 * 1000;
const day = 24 * 60 * minute;

/**
 * A world with a PDS behind the entryway, one account on it and a client
 * whose metadata the world finds at its address.
 */
async function setup(
  options: {
    client?: Record<string, unknown>;
    simulator?: Partial<BlueskySimulatorOptions>;
  } = {},
) {
  const world = createWorld({ now: () => start });
  const client = await newClient(options.client);
  const simulator = createBlueskySimulator(world, {
    clients: (id) => (id === client.id ? client.metadata : undefined),
    ...options.simulator,
  });
  simulator.addPds(pdsHost);
  const ada = simulator.addAccount({
    handle: "ada.bsky.test",
    pds: pdsHost,
    name: "Ada Lovelace",
  });
  const dpop = await newKey();
  const pigy = agent(simulator.fetch, client, world.now, dpop);
  return { world, simulator, client, ada, dpop, pigy };
}

type Sim = Awaited<ReturnType<typeof setup>>;

/** The JSON body of an answer. */
const body = async (response: Response) =>
  (await response.clone().json()) as Record<string, unknown>;

/** Connects the account `did` and returns its tokens. */
async function connected({ pigy, ada }: Sim, did = ada.id) {
  return pigy.connect(issuer, did);
}

/** A post record as an adapter writes it. */
const post = (text: string, extra: Record<string, unknown> = {}) => ({
  $type: "app.bsky.feed.post",
  text,
  createdAt: start.toISOString(),
  ...extra,
});

/** Writes a post as the account of `accessToken`. */
function createRecord(
  sim: Sim,
  accessToken: string,
  record: unknown,
  extra: Record<string, unknown> = {},
) {
  return sim.pigy.xrpc(pdsHost, "com.atproto.repo.createRecord", accessToken, {
    repo: sim.ada.id,
    collection: "app.bsky.feed.post",
    record,
    ...extra,
  });
}

/** Reads a record of the PDS, as anybody may. */
function getRecord(sim: Sim, query: Record<string, string>) {
  return sim.simulator.fetch(
    `https://${pdsHost}/xrpc/com.atproto.repo.getRecord?${new URLSearchParams(query)}`,
  );
}

describe("the simulated Bluesky as a host", () => {
  it("owns the hosts of its world and refuses every other, as an unreachable host", async () => {
    const { simulator } = await setup();
    for (const host of [
      plcDirectoryHost,
      dnsResolverHost,
      blueskyEntryway,
      pdsHost,
      "ada.bsky.test",
    ]) {
      expect(simulator.owns(host)).toBe(true);
    }
    expect(simulator.owns("bsky.app")).toBe(false);
    expect(simulator.owns("grace.bsky.test")).toBe(false);
    // What `fetch` throws when no answer comes.
    await expect(
      simulator.fetch("https://bsky.app/profile/x"),
    ).rejects.toBeInstanceOf(TypeError);
    // Its own hosts only over HTTPS, as the real ones.
    await expect(
      simulator.fetch(`http://${pdsHost}/xrpc/com.atproto.repo.getRecord`),
    ).rejects.toBeInstanceOf(TypeError);
  });

  it("takes names under .test for its servers and accounts, and nothing else", async () => {
    const { simulator } = await setup();
    // A real name would make the simulation answer for a real server.
    expect(() => simulator.addPds("pds.example.com")).toThrow(/\.test/);
    expect(() =>
      simulator.addAccount({ handle: "grace.bsky.social", pds: pdsHost }),
    ).toThrow(/\.test/);
    expect(() =>
      simulator.addAccount({ handle: "grace.bsky.test", pds: "other.test" }),
    ).toThrow(/no PDS/);
  });

  it("refuses to arm a fault that it does not have", async () => {
    const { simulator } = await setup();
    expect(() =>
      // @ts-expect-error: what the sandbox could pass on from a person.
      simulator.arm({ kind: "slow-media" }),
    ).toThrow(/no fault/);
    expect(() =>
      // @ts-expect-error: as above.
      simulator.arm({ kind: "server-error", operation: "dance" }),
    ).toThrow(/no request/);
  });
});

describe("finding an account", () => {
  const query = (sim: Sim, name: string, type = "TXT") =>
    sim.simulator.fetch(
      `https://${dnsResolverHost}/dns-query?${new URLSearchParams({ name, type })}`,
      { headers: { Accept: "application/dns-json" } },
    );

  it("answers the TXT record of a handle that is resolved by the DNS", async () => {
    const sim = await setup();
    const answer = await body(await query(sim, "_atproto.ada.bsky.test"));
    expect(answer).toMatchObject({
      Status: 0,
      // A TXT record is quoted in the answer of the resolver.
      Answer: [{ type: 16, data: `"did=${sim.ada.id}"` }],
    });
  });

  it("answers a name without the record, and a name that does not exist", async () => {
    const sim = await setup();
    sim.simulator.addAccount({
      handle: "grace.bsky.test",
      pds: pdsHost,
      resolution: "https",
    });
    // The handle exists and says its DID another way.
    const elsewhere = await body(await query(sim, "_atproto.grace.bsky.test"));
    expect(elsewhere).toMatchObject({ Status: 0 });
    expect(elsewhere.Answer).toBeUndefined();
    // NXDOMAIN.
    expect(await body(await query(sim, "_atproto.nobody.bsky.test"))).toEqual(
      expect.objectContaining({ Status: 3 }),
    );
  });

  it("refuses a query that is not simulated rather than answer it with nothing", async () => {
    const sim = await setup();
    expect((await query(sim, "ada.bsky.test", "A")).status).toBe(400);
    // Without the type of the answer that it is to give.
    const bare = await sim.simulator.fetch(
      `https://${dnsResolverHost}/dns-query?name=_atproto.ada.bsky.test&type=TXT`,
    );
    expect(bare.status).toBe(400);
  });

  it("serves the DID of a handle from the host of the handle, where that is how it resolves", async () => {
    const sim = await setup();
    const grace = sim.simulator.addAccount({
      handle: "grace.bsky.test",
      pds: pdsHost,
      resolution: "https",
    });
    const served = await sim.simulator.fetch(
      "https://grace.bsky.test/.well-known/atproto-did",
    );
    expect(await served.text()).toBe(grace.id);
    // Ada's handle is resolved by the DNS, so its host says nothing.
    const other = await sim.simulator.fetch(
      "https://ada.bsky.test/.well-known/atproto-did",
    );
    expect(other.status).toBe(404);
  });

  it("serves the document of a did:plc from the directory and of a did:web from its host", async () => {
    const sim = await setup();
    const plc = await body(
      await sim.simulator.fetch(`https://${plcDirectoryHost}/${sim.ada.id}`),
    );
    expect(plc).toMatchObject({
      id: sim.ada.id,
      // What makes the handle the account's own: the document claims it.
      alsoKnownAs: ["at://ada.bsky.test"],
      service: [
        {
          id: "#atproto_pds",
          type: "AtprotoPersonalDataServer",
          serviceEndpoint: `https://${pdsHost}`,
        },
      ],
    });
    const web = sim.simulator.addAccount({
      handle: "grace.bsky.test",
      pds: pdsHost,
      did: "web",
    });
    expect(web.id).toBe("did:web:grace.bsky.test");
    const document = await body(
      await sim.simulator.fetch("https://grace.bsky.test/.well-known/did.json"),
    );
    expect(document).toMatchObject({ id: web.id });
    // The directory keeps did:plc alone.
    const missing = await sim.simulator.fetch(
      `https://${plcDirectoryHost}/did:plc:aaaaaaaaaaaaaaaaaaaaaaaa`,
    );
    expect(missing.status).toBe(404);
  });

  it("says who authorizes the accounts of a PDS: the entryway, or the PDS itself", async () => {
    const sim = await setup();
    const resource = await body(
      await sim.simulator.fetch(
        `https://${pdsHost}/.well-known/oauth-protected-resource`,
      ),
    );
    expect(resource).toMatchObject({
      resource: `https://${pdsHost}`,
      authorization_servers: [issuer],
    });
    sim.simulator.addPds("self.test", { authorizes: true });
    const own = await body(
      await sim.simulator.fetch(
        "https://self.test/.well-known/oauth-protected-resource",
      ),
    );
    expect(own.authorization_servers).toEqual(["https://self.test"]);
    const server = await body(
      await sim.simulator.fetch(
        "https://self.test/.well-known/oauth-authorization-server",
      ),
    );
    expect(server).toMatchObject({
      issuer: "https://self.test",
      require_pushed_authorization_requests: true,
      dpop_signing_alg_values_supported: ["ES256"],
    });
    // A PDS behind an entryway has no authorization server of its own.
    const none = await sim.simulator.fetch(
      `https://${pdsHost}/.well-known/oauth-authorization-server`,
    );
    expect(none.status).toBe(404);
  });
});

describe("pushing an authorization request", () => {
  it("asks for a nonce first, and takes the request with it", async () => {
    const sim = await setup();
    const code = pkce();
    const send = async (nonce?: string) =>
      sim.simulator.fetch(`${issuer}/oauth/par`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          DPoP: await proof(sim.dpop, {
            method: "POST",
            url: `${issuer}/oauth/par`,
            now: start,
            nonce,
          }),
        },
        body: new URLSearchParams({
          client_id: sim.client.id,
          client_assertion_type:
            "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
          client_assertion: await assertion(sim.client, issuer, start),
          response_type: "code",
          code_challenge: code.challenge,
          code_challenge_method: "S256",
          state: "state",
          redirect_uri: redirectUri,
          scope,
        }),
      });
    const first = await send();
    expect(first.status).toBe(400);
    expect(await body(first)).toMatchObject({ error: "use_dpop_nonce" });
    const nonce = first.headers.get("DPoP-Nonce") ?? "";
    expect(nonce).not.toBe("");
    const second = await send(nonce);
    expect(second.status).toBe(201);
    expect(await body(second)).toMatchObject({
      request_uri: expect.stringMatching(/^urn:ietf:params:oauth:request_uri:/),
    });
  });

  it("refuses a request without a proof of a key", async () => {
    const sim = await setup();
    const response = await sim.simulator.fetch(`${issuer}/oauth/par`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: sim.client.id }),
    });
    expect(response.status).toBe(400);
    expect(await body(response)).toMatchObject({ error: "invalid_dpop_proof" });
  });

  it("refuses a proof that was sent before, or for another address", async () => {
    const sim = await setup();
    // Learns the nonce.
    await sim.pigy.push(issuer);
    const nonce = sim.pigy.nonces.get(blueskyEntryway);
    const once = await proof(sim.dpop, {
      method: "POST",
      url: `${issuer}/oauth/par`,
      now: start,
      nonce,
    });
    const elsewhere = await proof(sim.dpop, {
      method: "POST",
      url: `${issuer}/oauth/token`,
      now: start,
      nonce,
    });
    const send = async (dpop: string) =>
      sim.simulator.fetch(`${issuer}/oauth/par`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          DPoP: dpop,
        },
        body: new URLSearchParams({
          client_id: sim.client.id,
          client_assertion_type:
            "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
          client_assertion: await assertion(sim.client, issuer, start),
          response_type: "code",
          code_challenge: pkce().challenge,
          code_challenge_method: "S256",
          state: "state",
          redirect_uri: redirectUri,
          scope,
        }),
      });
    expect((await send(once)).status).toBe(201);
    const replayed = await send(once);
    expect(replayed.status).toBe(401);
    expect(await body(replayed)).toMatchObject({ error: "invalid_dpop_proof" });
    const misdirected = await send(elsewhere);
    expect(await body(misdirected)).toMatchObject({
      error: "invalid_dpop_proof",
    });
  });

  it("checks the assertion of the client against the keys that it publishes", async () => {
    const sim = await setup();
    const stranger = await newKey("key-1");
    const forged = async () => {
      // The same request, signed by a key that the client does not publish
      // under the name of one that it does.
      const response = await sim.pigy.form(issuer, "/oauth/par", {
        client_assertion: await assertion(sim.client, issuer, start, {
          key: stranger.privateKey,
        }),
        response_type: "code",
        code_challenge: pkce().challenge,
        code_challenge_method: "S256",
        state: "state",
        redirect_uri: redirectUri,
        scope,
      });
      return body(response);
    };
    expect(await forged()).toMatchObject({ error: "invalid_client" });
    // For another server.
    const wrongAudience = await sim.pigy.form(issuer, "/oauth/par", {
      client_assertion: await assertion(sim.client, issuer, start, {
        claims: { aud: "https://elsewhere.test" },
      }),
      response_type: "code",
    });
    expect(await body(wrongAudience)).toMatchObject({
      error: "invalid_client",
    });
  });

  it("refuses an assertion without a time at which it ends", async () => {
    const sim = await setup();
    const push = async (claims: Record<string, unknown>) =>
      body(
        await sim.pigy.form(issuer, "/oauth/par", {
          client_assertion: await assertion(sim.client, issuer, start, {
            claims,
          }),
          response_type: "code",
          code_challenge: pkce().challenge,
          code_challenge_method: "S256",
          state: "state",
          redirect_uri: redirectUri,
          scope,
        }),
      );
    // RFC 7523 section 3: the JWT must contain an "exp". Signed by the
    // client's key and right in everything else.
    expect(await push({ exp: undefined })).toMatchObject({
      error: "invalid_client",
      error_description: expect.stringMatching(/"exp"/),
    });
    // The same with one is taken.
    expect(await push({})).toMatchObject({
      request_uri: expect.any(String),
    });
  });

  it("refuses an assertion that comes a second time", async () => {
    const sim = await setup();
    await sim.pigy.push(issuer);
    const reused = await assertion(sim.client, issuer, start);
    const push = () =>
      sim.pigy.form(issuer, "/oauth/par", {
        client_assertion: reused,
        response_type: "code",
        code_challenge: pkce().challenge,
        code_challenge_method: "S256",
        state: "state",
        redirect_uri: redirectUri,
        scope,
      });
    expect((await push()).status).toBe(201);
    expect(await body(await push())).toMatchObject({
      error: "invalid_client",
      error_description: expect.stringMatching(/used before/),
    });
  });

  it("refuses a proof of the key that the client authenticates with", async () => {
    const sim = await setup();
    // The key of the session has to be another than the client's own.
    const { kid: _, ...jwk } = sim.client.key.jwk;
    const same = agent(sim.simulator.fetch, sim.client, sim.world.now, {
      ...sim.client.key,
      jwk,
    });
    const { response } = await same.push(issuer);
    expect(await body(response)).toMatchObject({ error: "invalid_request" });
  });

  it("refuses what the client did not declare, and what PKCE does not allow", async () => {
    const sim = await setup();
    const refusal = async (params: Record<string, string>) =>
      body((await sim.pigy.push(issuer, params)).response);
    expect(
      await refusal({ redirect_uri: "https://pigy.example/elsewhere" }),
    ).toMatchObject({ error: "invalid_request" });
    expect(
      await refusal({ scope: "atproto transition:generic" }),
    ).toMatchObject({ error: "invalid_scope" });
    expect(await refusal({ scope: "repo:app.bsky.feed.post" })).toMatchObject({
      error: "invalid_scope",
    });
    expect(await refusal({ code_challenge_method: "plain" })).toMatchObject({
      error: "invalid_request",
    });
    expect(await refusal({ state: "" })).toMatchObject({
      error: "invalid_request",
    });
  });

  it("refuses a code challenge that was used before", async () => {
    const sim = await setup();
    const code = pkce();
    const params = {
      code_challenge: code.challenge,
    };
    expect((await sim.pigy.push(issuer, params)).response.status).toBe(201);
    expect(
      await body((await sim.pigy.push(issuer, params)).response),
    ).toMatchObject({ error: "invalid_request" });
  });

  it("reads the client from its metadata, and refuses what a real server refuses", async () => {
    const refusal = async (client: Record<string, unknown>) => {
      const sim = await setup({ client });
      const { response } = await sim.pigy.push(issuer);
      return body(response);
    };
    // A client must be an HTTPS address without a port.
    expect(
      await refusal({ client_id: "http://pigy.example/client.json" }),
    ).toMatchObject({ error: "invalid_client_metadata" });
    expect(
      await refusal({ client_id: "https://pigy.example:8443/client.json" }),
    ).toMatchObject({ error: "invalid_client_metadata" });
    // Tokens that are not bound to a key are not given out.
    expect(await refusal({ dpop_bound_access_tokens: false })).toMatchObject({
      error: "invalid_client_metadata",
    });
    // Only confidential clients are simulated.
    expect(await refusal({ token_endpoint_auth_method: "none" })).toMatchObject(
      { error: "invalid_client_metadata" },
    );
    // A published private key is a key given away.
    const sim = await setup();
    expect(
      await refusal({
        jwks: { keys: [{ ...sim.client.key.jwk, d: "secret" }] },
      }),
    ).toMatchObject({ error: "invalid_client_metadata" });
    expect(await refusal({ scope: "transition:generic" })).toMatchObject({
      error: "invalid_client_metadata",
    });
  });

  it("refuses a client that it cannot read", async () => {
    const sim = await setup({ simulator: { clients: () => undefined } });
    const { response } = await sim.pigy.push(issuer);
    expect(await body(response)).toMatchObject({
      error: "invalid_client_metadata",
    });
  });

  it("takes a client at a local address without HTTPS only when told to", async () => {
    const local = "http://localhost:5173/connect/bluesky/client-metadata.json";
    const callback = "http://localhost:5173/connect/bluesky/callback";
    const client = { client_id: local, redirect_uris: [callback] };
    const strict = await setup({ client });
    expect(
      await body(
        (await strict.pigy.push(issuer, { redirect_uri: callback })).response,
      ),
    ).toMatchObject({ error: "invalid_client_metadata" });
    // For a pigy that runs on somebody's machine, and its sandbox.
    const lenient = await setup({ client, simulator: { localClients: true } });
    const pushed = await lenient.pigy.push(issuer, { redirect_uri: callback });
    expect(pushed.response.status).toBe(201);
  });
});

describe("consenting", () => {
  it("shows a page marked as a simulation, with the account that the hint names", async () => {
    const sim = await setup();
    sim.simulator.addAccount({ handle: "grace.bsky.test", pds: pdsHost });
    const hinted = await sim.pigy.push(issuer, { login_hint: "ada.bsky.test" });
    const page = await (await sim.simulator.fetch(hinted.url)).text();
    expect(page).toContain(simulationNotice);
    expect(page).toContain("@ada.bsky.test");
    // The client would refuse any other account in the end.
    expect(page).not.toContain("grace");
    const open = await sim.pigy.push(issuer);
    expect(await (await sim.simulator.fetch(open.url)).text()).toContain(
      "@grace.bsky.test",
    );
  });

  it("sends the browser back with a code, the state and who issued it", async () => {
    const sim = await setup();
    const pushed = await sim.pigy.push(issuer);
    const callback = await answerConsent(sim.simulator.fetch, pushed.url, {
      account: sim.ada.id,
    });
    expect(callback.origin + callback.pathname).toBe(redirectUri);
    expect(callback.searchParams.get("state")).toBe(pushed.state);
    expect(callback.searchParams.get("iss")).toBe(issuer);
    expect(isSimulatedSecret(callback.searchParams.get("code") ?? "")).toBe(
      true,
    );
    // A request is good for one answer.
    const again = await sim.simulator.fetch(pushed.url);
    expect(again.status).toBe(400);
  });

  it("says that the person declined", async () => {
    const sim = await setup();
    const pushed = await sim.pigy.push(issuer);
    const callback = await answerConsent(
      sim.simulator.fetch,
      pushed.url,
      "deny",
    );
    expect(callback.searchParams.get("error")).toBe("access_denied");
    expect(callback.searchParams.get("state")).toBe(pushed.state);
    expect(callback.searchParams.has("code")).toBe(false);
  });

  it("ends on a page of its own for a request that it does not know or that has expired", async () => {
    const sim = await setup();
    const unknown = await sim.simulator.fetch(
      `${issuer}/oauth/authorize?client_id=${encodeURIComponent(clientId)}&request_uri=urn:ietf:params:oauth:request_uri:req-x`,
    );
    expect(unknown.status).toBe(400);
    expect(await unknown.text()).toContain(simulationNotice);
    const pushed = await sim.pigy.push(issuer);
    sim.world.advance(5 * minute);
    expect((await sim.simulator.fetch(pushed.url)).status).toBe(400);
  });
});

describe("tokens", () => {
  async function consented(sim: Sim) {
    const pushed = await sim.pigy.push(issuer);
    const callback = await answerConsent(sim.simulator.fetch, pushed.url, {
      account: sim.ada.id,
    });
    return { code: callback.searchParams.get("code") ?? "", pushed };
  }

  it("gives tokens bound to the key of the session, for the account that consented", async () => {
    const sim = await setup();
    const { code, pushed } = await consented(sim);
    const { response, tokens } = await sim.pigy.exchange(
      issuer,
      code,
      pushed.verifier,
    );
    expect(response.status).toBe(200);
    expect(tokens).toMatchObject({
      token_type: "DPoP",
      sub: sim.ada.id,
      scope,
      expires_in: accessTokenLifetimeMs / 1000,
    });
    expect(isSimulatedSecret(tokens.access_token)).toBe(true);
    expect(isSimulatedSecret(tokens.refresh_token)).toBe(true);
  });

  it("refuses a code with the wrong verifier, or with a proof of another key", async () => {
    const sim = await setup();
    const { code, pushed } = await consented(sim);
    const wrong = await sim.pigy.exchange(issuer, code, pkce().verifier);
    expect(await body(wrong.response)).toMatchObject({
      error: "invalid_grant",
    });
    const other = agent(
      sim.simulator.fetch,
      sim.client,
      sim.world.now,
      await newKey(),
    );
    const stolen = await other.exchange(issuer, code, pushed.verifier);
    expect(await body(stolen.response)).toMatchObject({
      error: "invalid_grant",
    });
  });

  it("ends the session of a code that comes a second time", async () => {
    const sim = await setup();
    const { code, pushed } = await consented(sim);
    const { tokens } = await sim.pigy.exchange(issuer, code, pushed.verifier);
    const second = await sim.pigy.exchange(issuer, code, pushed.verifier);
    expect(await body(second.response)).toMatchObject({
      error: "invalid_grant",
    });
    // Somebody else may have used it: the tokens it gave are worthless.
    const write = await createRecord(sim, tokens.access_token, post("Hi"));
    expect(write.status).toBe(401);
  });

  it("ends the session of a code that comes a second time after its own time, when other codes have been given since", async () => {
    const sim = await setup();
    const { code, pushed } = await consented(sim);
    const { tokens } = await sim.pigy.exchange(issuer, code, pushed.verifier);
    // Past the time that the code had to be exchanged in. Another person
    // consents, which is when the server forgets the codes that have had
    // their time: the one that was exchanged has not had it.
    sim.world.advance(11 * minute);
    await consented(sim);
    const second = await sim.pigy.exchange(issuer, code, pushed.verifier);
    expect(await body(second.response)).toMatchObject({
      error: "invalid_grant",
      error_description: "Code replayed",
    });
    // The access token has run out by itself by now, so the session is
    // shown to be over by its refresh token.
    const refreshed = await sim.pigy.refresh(issuer, tokens.refresh_token);
    expect(await body(refreshed.response)).toMatchObject({
      error: "invalid_grant",
    });
  });

  it("refuses a code that waited too long", async () => {
    const sim = await setup();
    const { code, pushed } = await consented(sim);
    sim.world.advance(11 * minute);
    const late = await sim.pigy.exchange(issuer, code, pushed.verifier);
    expect(await body(late.response)).toMatchObject({ error: "invalid_grant" });
  });

  it("renews the tokens of a session once for each refresh token", async () => {
    const sim = await setup();
    const tokens = await connected(sim);
    sim.world.advance(accessTokenLifetimeMs);
    // The access token is past its end.
    expect(
      (await createRecord(sim, tokens.access_token, post("Late"))).status,
    ).toBe(401);
    const renewed = await sim.pigy.refresh(issuer, tokens.refresh_token);
    expect(renewed.response.status).toBe(200);
    expect(renewed.tokens.refresh_token).not.toBe(tokens.refresh_token);
    expect(
      (await createRecord(sim, renewed.tokens.access_token, post("On time")))
        .status,
    ).toBe(200);
    // The refresh token that was used comes again: a copy, or an answer
    // that was lost. Nobody can tell, so the whole session ends.
    const replayed = await sim.pigy.refresh(issuer, tokens.refresh_token);
    expect(await body(replayed.response)).toMatchObject({
      error: "invalid_grant",
    });
    const after = await sim.pigy.refresh(issuer, renewed.tokens.refresh_token);
    expect(await body(after.response)).toMatchObject({
      error: "invalid_grant",
    });
  });

  it("lets a refresh token lapse when nobody uses it", async () => {
    const sim = await setup();
    const tokens = await connected(sim);
    sim.world.advance(refreshTokenLifetimeMs);
    const lapsed = await sim.pigy.refresh(issuer, tokens.refresh_token);
    expect(await body(lapsed.response)).toMatchObject({
      error: "invalid_grant",
    });
  });

  it("renews a session only with the key that the client began it with", async () => {
    const sim = await setup();
    const tokens = await connected(sim);
    // The client publishes a second key and signs with it.
    const second = await newKey("key-2");
    (sim.client.metadata.jwks as { keys: unknown[] }).keys.push(second.jwk);
    const switched: TestClient = {
      ...sim.client,
      key: { ...second },
    };
    const other = agent(sim.simulator.fetch, switched, sim.world.now, sim.dpop);
    const refused = await other.form(issuer, "/oauth/token", {
      client_assertion: await assertion(switched, issuer, start, {
        kid: "key-2",
      }),
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
    });
    expect(await body(refused)).toMatchObject({ error: "invalid_grant" });
  });

  it("takes the tokens of a session back", async () => {
    const sim = await setup();
    const tokens = await connected(sim);
    const revoked = await sim.pigy.form(issuer, "/oauth/revoke", {
      token: tokens.access_token,
    });
    expect(revoked.status).toBe(200);
    expect(
      (await createRecord(sim, tokens.access_token, post("Gone"))).status,
    ).toBe(401);
    const refreshed = await sim.pigy.refresh(issuer, tokens.refresh_token);
    expect(await body(refreshed.response)).toMatchObject({
      error: "invalid_grant",
    });
    // A token that it does not know is not an error, RFC 7009.
    const unknown = await sim.pigy.form(issuer, "/oauth/revoke", {
      token: "pigy-sim-unknown",
    });
    expect(unknown.status).toBe(200);
  });
});

describe("the repository of an account", () => {
  it("writes a post under a key of its own choosing, or of the client's", async () => {
    const sim = await setup();
    const tokens = await connected(sim);
    const written = await createRecord(sim, tokens.access_token, post("Hello"));
    expect(written.status).toBe(200);
    const { uri, cid } = await body(written);
    expect(uri).toMatch(
      new RegExp(`^at://${sim.ada.id}/app.bsky.feed.post/[2-7a-z]{13}$`),
    );
    expect(cid).toMatch(/^b[a-z2-7]+$/);
    // The key is a timestamp identifier, which the client may choose.
    const chosen = await createRecord(sim, tokens.access_token, post("Mine"), {
      rkey: "3m2abcdefgh22",
    });
    expect(await body(chosen)).toMatchObject({
      uri: `at://${sim.ada.id}/app.bsky.feed.post/3m2abcdefgh22`,
    });
    expect(feed(sim.world).map(({ post }) => post.text)).toEqual(
      expect.arrayContaining(["Hello", "Mine"]),
    );
  });

  it("does not write a second record under a key that has one", async () => {
    const sim = await setup();
    const tokens = await connected(sim);
    const rkey = "3m2abcdefgh22";
    await createRecord(sim, tokens.access_token, post("First"), { rkey });
    const second = await createRecord(sim, tokens.access_token, post("Again"), {
      rkey,
    });
    // GUESS, as in pds.ts: an error of the server, which leaves the first.
    expect(second.status).toBe(500);
    expect(feed(sim.world).map(({ post }) => post.text)).toEqual(["First"]);
  });

  it("refuses what the schema of a post does not allow", async () => {
    const sim = await setup();
    const tokens = await connected(sim);
    const refused = async (record: unknown, extra = {}) => {
      const response = await createRecord(
        sim,
        tokens.access_token,
        record,
        extra,
      );
      expect(response.status).toBe(400);
      return body(response);
    };
    // 300 grapheme clusters at most: a letter with an accent that is a
    // code point of its own is one.
    const accented = "e\u0301";
    expect(
      (await createRecord(sim, tokens.access_token, post(accented.repeat(300))))
        .status,
    ).toBe(200);
    expect(await refused(post("a".repeat(301)))).toMatchObject({
      error: "InvalidRequest",
    });
    // And 3000 bytes, which 300 such emoji are more than.
    const family = String.fromCodePoint(
      0x1f468,
      0x200d,
      0x1f469,
      0x200d,
      0x1f467,
      0x200d,
      0x1f466,
    );
    expect(await refused(post(family.repeat(300)))).toMatchObject({
      error: "InvalidRequest",
    });
    expect(await refused(post("Hi", { createdAt: "yesterday" }))).toMatchObject(
      { error: "InvalidRequest" },
    );
    expect(await refused({ text: "No type" })).toMatchObject({
      error: "InvalidRequest",
    });
    // Not simulated, and so refused rather than ignored.
    expect(await refused(post("Hi", { labels: {} }))).toMatchObject({
      error: "InvalidRequest",
    });
    // A post is kept under a timestamp identifier.
    expect(await refused(post("Hi"), { rkey: "self" })).toMatchObject({
      error: "InvalidRequest",
    });
  });

  it("keeps the facets of a post, and shows what they mark by where it stands in the text", async () => {
    const sim = await setup();
    const tokens = await connected(sim);
    // An emoji first: four bytes in UTF-8 and two code units in a string,
    // so every facet after it stands elsewhere in the bytes than in the
    // string.
    const text = "😀 @ada.bsky.test wrote https://example.test/ #news";
    const at = (part: string) => {
      const start = new TextEncoder().encode(
        text.slice(0, text.indexOf(part)),
      ).length;
      return {
        byteStart: start,
        byteEnd: start + new TextEncoder().encode(part).length,
      };
    };
    const facet = (part: string, feature: Record<string, string>) => ({
      index: at(part),
      features: [feature],
    });
    const written = await createRecord(
      sim,
      tokens.access_token,
      post(text, {
        facets: [
          facet("@ada.bsky.test", {
            $type: "app.bsky.richtext.facet#mention",
            did: sim.ada.id,
          }),
          facet("https://example.test/", {
            $type: "app.bsky.richtext.facet#link",
            uri: "https://example.test/",
          }),
          facet("#news", { $type: "app.bsky.richtext.facet#tag", tag: "news" }),
        ],
      }),
    );
    expect(written.status).toBe(200);
    const kept = feed(sim.world)[0]?.post;
    expect(kept && entitiesOf(kept)).toEqual([
      ["mention", "@ada.bsky.test", sim.ada.id],
      ["link", "https://example.test/", "https://example.test/"],
      ["hashtag", "#news", "news"],
    ]);
    expect(kept?.card).toBeNull();
  });

  it("refuses a facet that an app could not show", async () => {
    const sim = await setup();
    const tokens = await connected(sim);
    const text = "é #tag";
    const tag = { $type: "app.bsky.richtext.facet#tag", tag: "tag" };
    const refused = async (facets: unknown) => {
      const response = await createRecord(
        sim,
        tokens.access_token,
        post(text, { facets }),
      );
      expect(response.status).toBe(400);
      return (await body(response)).message as string;
    };
    const facet = (
      byteStart: number,
      byteEnd: number,
      feature: unknown = tag,
    ) => ({
      index: { byteStart, byteEnd },
      features: [feature],
    });
    // "é" is two bytes, so the tag is bytes 3 to 7 of 7.
    expect(
      (
        await createRecord(
          sim,
          tokens.access_token,
          post(text, { facets: [facet(3, 7)] }),
        )
      ).status,
    ).toBe(200);
    // Beyond the text, which is what offsets in code units give for a
    // text with letters of more than one byte before the facet.
    expect(await refused([facet(3, 8)])).toContain("the text has 7");
    expect(await refused([facet(7, 3)])).toContain("names bytes");
    // In the middle of the "é".
    expect(await refused([facet(1, 7)])).toContain("middle of a character");
    expect(await refused([facet(3, 7), facet(5, 7)])).toContain("overlaps");
    expect(
      await refused([
        facet(3, 7, { $type: "app.bsky.richtext.facet#tag", tag: "#tag" }),
      ]),
    ).toContain('must not begin with "#"');
    expect(
      await refused([
        facet(3, 7, {
          $type: "app.bsky.richtext.facet#link",
          uri: "example.test",
        }),
      ]),
    ).toContain("must be a uri");
    // A mention of an account that this world does not have.
    expect(
      await refused([
        facet(3, 7, {
          $type: "app.bsky.richtext.facet#mention",
          did: "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa",
        }),
      ]),
    ).toContain("names no account");
    expect(
      await refused([facet(3, 7, { $type: "app.bsky.richtext.facet#bold" })]),
    ).toContain("no feature");
  });

  it("keeps the card of a link, and takes no picture for it", async () => {
    const sim = await setup();
    const tokens = await connected(sim);
    const external = {
      uri: "https://example.test/",
      title: "The example page",
      description: "",
    };
    const embed = (fields: unknown) => ({
      $type: "app.bsky.embed.external",
      external: fields,
    });
    const written = await createRecord(
      sim,
      tokens.access_token,
      post("See https://example.test/", { embed: embed(external) }),
    );
    expect(written.status).toBe(200);
    expect(feed(sim.world)[0]?.post.card).toEqual({
      url: "https://example.test/",
      title: "The example page",
      description: "",
    });
    const refused = async (embedded: unknown) =>
      (
        await createRecord(
          sim,
          tokens.access_token,
          post("Hi", { embed: embedded }),
        )
      ).status;
    // The lexicon requires a title and a description, empty or not.
    expect(
      await refused(embed({ uri: external.uri, title: "No description" })),
    ).toBe(400);
    // Blobs are not simulated, so a picture is refused and not ignored.
    expect(await refused(embed({ ...external, thumb: {} }))).toBe(400);
    expect(await refused({ $type: "app.bsky.embed.images", images: [] })).toBe(
      400,
    );
  });

  it("takes a reply only to a post that is there, named by its hash, in its thread", async () => {
    const sim = await setup();
    const tokens = await connected(sim);
    const root = await body(
      await createRecord(sim, tokens.access_token, post("Root")),
    );
    const ref = { uri: root.uri, cid: root.cid };
    const reply = await body(
      await createRecord(
        sim,
        tokens.access_token,
        post("Reply", { reply: { root: ref, parent: ref } }),
      ),
    );
    expect(reply.uri).toEqual(expect.any(String));
    const replyRef = { uri: reply.uri, cid: reply.cid };
    // The root of a reply to a reply is the root of the thread.
    const wrongRoot = await createRecord(
      sim,
      tokens.access_token,
      post("Third", { reply: { root: replyRef, parent: replyRef } }),
    );
    expect(wrongRoot.status).toBe(400);
    const staleHash = await createRecord(
      sim,
      tokens.access_token,
      post("Third", {
        reply: { root: ref, parent: { uri: reply.uri, cid: root.cid } },
      }),
    );
    expect(staleHash.status).toBe(400);
    const third = await createRecord(
      sim,
      tokens.access_token,
      post("Third", { reply: { root: ref, parent: replyRef } }),
    );
    expect(third.status).toBe(200);
    expect(feed(sim.world).map(({ post }) => post.replyToId)).toEqual([
      null,
      root.uri,
      reply.uri,
    ]);
  });

  it("lets an account write to its own repository alone", async () => {
    const sim = await setup();
    const grace = sim.simulator.addAccount({
      handle: "grace.bsky.test",
      pds: pdsHost,
    });
    const tokens = await connected(sim);
    const response = await createRecord(sim, tokens.access_token, post("Hi"), {
      repo: grace.id,
    });
    expect(response.status).toBe(401);
  });

  it("writes only what the scopes of the session allow", async () => {
    const narrow = "atproto repo:app.bsky.feed.post?action=delete";
    const sim = await setup({ client: { scope: narrow } });
    const pushed = await sim.pigy.push(issuer, { scope: narrow });
    const callback = await answerConsent(sim.simulator.fetch, pushed.url, {
      account: sim.ada.id,
    });
    const { tokens } = await sim.pigy.exchange(
      issuer,
      callback.searchParams.get("code") ?? "",
      pushed.verifier,
    );
    const response = await createRecord(sim, tokens.access_token, post("Hi"));
    expect(response.status).toBe(403);
  });

  it("takes a token only with a proof of its key, with a nonce of the PDS", async () => {
    const sim = await setup();
    const tokens = await connected(sim);
    const url = `https://${pdsHost}/xrpc/com.atproto.repo.createRecord`;
    const request = (headers: Record<string, string>) =>
      sim.simulator.fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify({
          repo: sim.ada.id,
          collection: "app.bsky.feed.post",
          record: post("Hi"),
        }),
      });
    // A token bound to a key is no bearer token.
    expect(
      (await request({ Authorization: `Bearer ${tokens.access_token}` }))
        .status,
    ).toBe(401);
    // The PDS has nonces of its own, which the client learns from it.
    const first = await request({
      Authorization: `DPoP ${tokens.access_token}`,
      DPoP: await proof(sim.dpop, {
        method: "POST",
        url,
        now: start,
        nonce: sim.pigy.nonces.get(blueskyEntryway),
        accessToken: tokens.access_token,
      }),
    });
    expect(first.status).toBe(401);
    expect(await body(first)).toMatchObject({ error: "use_dpop_nonce" });
    expect(first.headers.get("WWW-Authenticate")).toMatch(/use_dpop_nonce/);
    const nonce = first.headers.get("DPoP-Nonce") ?? undefined;
    // A proof of another key.
    const other = await newKey();
    const stolen = await request({
      Authorization: `DPoP ${tokens.access_token}`,
      DPoP: await proof(other, {
        method: "POST",
        url,
        now: start,
        nonce,
        accessToken: tokens.access_token,
      }),
    });
    expect(stolen.status).toBe(401);
    const right = await request({
      Authorization: `DPoP ${tokens.access_token}`,
      DPoP: await proof(sim.dpop, {
        method: "POST",
        url,
        now: start,
        nonce,
        accessToken: tokens.access_token,
      }),
    });
    expect(right.status).toBe(200);
    // It tells how much is left of what the account may write.
    expect(right.headers.get("RateLimit-Remaining")).toBe(String(5000 - 3));
  });

  it("reads a record for anybody, and says when there is none", async () => {
    const sim = await setup();
    const tokens = await connected(sim);
    const written = await body(
      await createRecord(sim, tokens.access_token, post("Read me"), {
        rkey: "3m2abcdefgh22",
      }),
    );
    const read = await getRecord(sim, {
      repo: sim.ada.id,
      collection: "app.bsky.feed.post",
      rkey: "3m2abcdefgh22",
    });
    expect(await body(read)).toEqual({
      uri: written.uri,
      cid: written.cid,
      value: post("Read me"),
    });
    const missing = await getRecord(sim, {
      repo: sim.ada.id,
      collection: "app.bsky.feed.post",
      rkey: "3m2abcdefgh23",
    });
    expect(missing.status).toBe(400);
    expect(await body(missing)).toMatchObject({ error: "RecordNotFound" });
    const profile = await body(
      await getRecord(sim, {
        repo: sim.ada.id,
        collection: "app.bsky.actor.profile",
        rkey: "self",
      }),
    );
    expect(profile).toMatchObject({ value: { displayName: "Ada Lovelace" } });
  });

  it("deletes a record, and is fine with one that is not there", async () => {
    const sim = await setup();
    const tokens = await connected(sim);
    await createRecord(sim, tokens.access_token, post("Delete me"), {
      rkey: "3m2abcdefgh22",
    });
    const remove = () =>
      sim.pigy.xrpc(
        pdsHost,
        "com.atproto.repo.deleteRecord",
        tokens.access_token,
        {
          repo: sim.ada.id,
          collection: "app.bsky.feed.post",
          rkey: "3m2abcdefgh22",
        },
      );
    expect((await remove()).status).toBe(200);
    expect(feed(sim.world)).toEqual([]);
    // "Delete a repository record, or ensure it doesn't exist."
    expect((await remove()).status).toBe(200);
  });
});

describe("what the world keeps", () => {
  it("forgets what has had its time when it writes, and does not grow with every request", async () => {
    const sim = await setup();
    // Everything that a client does with a server, which leaves something
    // for a while: proofs and assertions, nonces, code challenges, pushed
    // requests that nobody answers, codes, and tokens.
    const round = async () => {
      const tokens = await connected(sim);
      await createRecord(sim, tokens.access_token, post("Hi"));
      const renewed = await sim.pigy.refresh(issuer, tokens.refresh_token);
      await sim.pigy.push(issuer);
      return renewed.tokens;
    };
    const rows = <Row>(name: string) =>
      sim.world.table<Row>("bluesky", name).entries();
    const sessions = () => rows<{ revoked: boolean }>("session");
    const first = await round();
    // The one session so far, which is to end.
    const [ended] = sessions().map(([id]) => id);
    expect(ended).toBeDefined();
    // A second session, which lives on, and the first one ends: the codes
    // that they were begun with have both had their time by the second
    // round.
    await connected(sim);
    const lasting = sessions().find(([id]) => id !== ended)?.[0];
    await sim.pigy.form(issuer, "/oauth/revoke", { token: first.access_token });
    sim.world.advance(2 * day);
    await round();

    const now = sim.world.now().getTime();
    for (const [name, until] of [
      ["replay", (row: number) => row],
      ["challenge", (row: number) => row],
      ["request", (row: { expiresAt: number }) => row.expiresAt],
    ] as const) {
      const kept = rows<never>(name);
      // There is something to forget: the second round made some.
      expect(kept.length, name).toBeGreaterThan(0);
      for (const [id, row] of kept) {
        expect(until(row), `${name} ${id}`).toBeGreaterThan(now);
      }
    }
    // A code that was exchanged is kept for as long as its session lives,
    // to tell it when it comes again, and forgotten when the session ends.
    // The code of the second round is kept, and so is the one of the
    // session that lives on, past its time.
    const codes = rows<{ expiresAt: number; sessionId: string | null }>(
      "code",
    ).map(([, code]) => code);
    expect(codes.map(({ sessionId }) => sessionId)).not.toContain(ended);
    expect(codes.map(({ sessionId }) => sessionId)).toContain(lasting);
    const revoked = new Map(
      sessions().map(([id, { revoked }]) => [id, revoked]),
    );
    expect(codes.length).toBe(2);
    for (const { expiresAt, sessionId } of codes) {
      expect(
        expiresAt > now || revoked.get(sessionId ?? "") === false,
        `code of ${sessionId}`,
      ).toBe(true);
    }
    // A server takes its nonce of now and the one before it.
    const span = 2 * minute;
    for (const [id] of rows<string>("nonce")) {
      expect(Number(id.split("/").at(-1)), id).toBeGreaterThanOrEqual(
        Math.floor(now / span) - 1,
      );
    }
    // The access tokens of the first round have ended. Its refresh tokens
    // have not: they are kept, as revoked, for as long as a replay of one
    // has to be told from a token that the server never issued.
    const tokens = sim.world.tokens("bluesky");
    expect(tokens.length).toBeGreaterThan(0);
    for (const token of tokens) {
      expect(token.expiresAt ?? Number.POSITIVE_INFINITY).toBeGreaterThan(now);
    }
  });
});

describe("faults", () => {
  it("expires a token before its time, which a refresh cures", async () => {
    const sim = await setup();
    const tokens = await connected(sim);
    sim.simulator.arm({ kind: "token-expired", operation: "publish" });
    const refused = await createRecord(sim, tokens.access_token, post("Hi"));
    expect(refused.status).toBe(401);
    expect(await body(refused)).toMatchObject({ error: "invalid_token" });
    // Not once, but from now on: the token has ended.
    expect(
      (await createRecord(sim, tokens.access_token, post("Hi"))).status,
    ).toBe(401);
    const renewed = await sim.pigy.refresh(issuer, tokens.refresh_token);
    expect(
      (await createRecord(sim, renewed.tokens.access_token, post("Hi"))).status,
    ).toBe(200);
  });

  it("revokes a session, which no refresh cures", async () => {
    const sim = await setup();
    const tokens = await connected(sim);
    sim.simulator.arm({ kind: "token-revoked", operation: "publish" });
    expect(
      (await createRecord(sim, tokens.access_token, post("Hi"))).status,
    ).toBe(401);
    const refreshed = await sim.pigy.refresh(issuer, tokens.refresh_token);
    expect(await body(refreshed.response)).toMatchObject({
      error: "invalid_grant",
    });
  });

  it("loses the answer to a write that it has carried out", async () => {
    const sim = await setup();
    const tokens = await connected(sim);
    sim.simulator.arm({ kind: "lost-response", operation: "publish" });
    await expect(
      createRecord(sim, tokens.access_token, post("Unseen")),
    ).rejects.toBeInstanceOf(TypeError);
    expect(feed(sim.world).map(({ post }) => post.text)).toEqual(["Unseen"]);
  });

  it("fails with a page of its proxy, or asks to be asked later", async () => {
    const sim = await setup();
    const tokens = await connected(sim);
    sim.simulator.arm({ kind: "server-error", operation: "publish" });
    const failed = await createRecord(sim, tokens.access_token, post("Down"));
    expect(failed.status).toBe(502);
    expect(failed.headers.get("Content-Type")).toMatch(/text\/html/);
    sim.simulator.arm({ kind: "rate-limit", operation: "publish" });
    const limited = await createRecord(sim, tokens.access_token, post("Busy"));
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(feed(sim.world)).toEqual([]);
  });

  it("keeps a fault for a request that it takes up, not one that it refuses for its token", async () => {
    const sim = await setup();
    const tokens = await connected(sim);
    sim.world.advance(accessTokenLifetimeMs);
    sim.simulator.arm({ kind: "lost-response", operation: "publish" });
    // The token has ended: nothing is written, so there is nothing to lose
    // the answer to.
    expect(
      (await createRecord(sim, tokens.access_token, post("Hi"))).status,
    ).toBe(401);
    const renewed = await sim.pigy.refresh(issuer, tokens.refresh_token);
    await expect(
      createRecord(sim, renewed.tokens.access_token, post("Hi")),
    ).rejects.toBeInstanceOf(TypeError);
  });

  it("strikes the requests it is armed for, and no other", async () => {
    const sim = await setup();
    const tokens = await connected(sim);
    sim.simulator.arm({ kind: "server-error", operation: "delete" });
    // A write is no deletion.
    expect(
      (await createRecord(sim, tokens.access_token, post("Hi"))).status,
    ).toBe(200);
    sim.world.advance(day);
    expect(sim.world.faults.armed("bluesky")).toHaveLength(1);
  });
});

describe("the app view", () => {
  /** Asks the public app view for the posts of `uris`. */
  const getPosts = (sim: Sim, uris: string[]) =>
    sim.simulator.fetch(
      `https://public.api.bsky.app/xrpc/app.bsky.feed.getPosts?${new URLSearchParams(uris.map((uri) => ["uris", uri]))}`,
    );

  it("shows a post to anybody, with what people did with it", async () => {
    const sim = await setup();
    const tokens = await connected(sim);
    const { uri, cid } = await body(
      await createRecord(sim, tokens.access_token, post("Counted")),
    );
    sim.world.engage("bluesky", String(uri), { likes: 4, reposts: 1 });

    // No token: the counts of a post are public.
    const answer = await getPosts(sim, [String(uri)]);

    expect(answer.status).toBe(200);
    expect(await body(answer)).toEqual({
      posts: [
        {
          uri,
          cid,
          author: {
            did: sim.ada.id,
            handle: "ada.bsky.test",
            displayName: "Ada Lovelace",
          },
          record: post("Counted"),
          replyCount: 0,
          repostCount: 1,
          likeCount: 4,
          quoteCount: 0,
          indexedAt: start.toISOString(),
        },
      ],
    });
  });

  it("leaves out a post that it does not have, and refuses what is no AT URI", async () => {
    const sim = await setup();
    const gone = `at://${sim.ada.id}/app.bsky.feed.post/3m2abcdefgh22`;

    expect(await body(await getPosts(sim, [gone]))).toEqual({ posts: [] });
    expect((await getPosts(sim, ["https://bsky.app/post/1"])).status).toBe(400);
    // The lexicon takes 25 at most.
    expect((await getPosts(sim, Array(26).fill(gone))).status).toBe(400);
  });

  it("asks a client that asks too often to wait", async () => {
    const sim = await setup();
    sim.simulator.arm({ kind: "rate-limit", operation: "stats" });

    const answer = await getPosts(sim, [`at://${sim.ada.id}/x/y`]);

    expect(answer.status).toBe(429);
    expect(answer.headers.get("Retry-After")).toBe("60");
  });
});
