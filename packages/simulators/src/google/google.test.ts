import * as oauth from "oauth4webapi";
import { expect, it } from "vitest";
import {
  createGoogleSimulator,
  type GoogleSimulatorOptions,
  googleAuthorizationEndpoint,
  googleIssuer,
} from "./index.ts";

const client = {
  clientId: "test-client.apps.googleusercontent.com",
  clientSecret: "test-client-secret",
  redirectUris: ["https://app.example/callback"],
};
const redirectUri = "https://app.example/callback";
const tokenEndpoint = "https://oauth2.googleapis.com/token";

// A challenge and the verifier it was made from, with the S256 method.
const verifier = "a".repeat(43);
const challenge = "ZtNPunH49FD35FWYhT5Tv8I7vRKQJ8uxMaL0_9eHjNA";

/** A simulated Google whose clock stands still until it is moved. */
function setup(options: Partial<GoogleSimulatorOptions> = {}) {
  const clock = { time: new Date("2026-11-14T10:00:00Z") };
  const simulator = createGoogleSimulator({
    now: () => clock.time,
    client,
    ...options,
  });
  return { simulator, clock };
}

function authorizationUrl(overrides: Record<string, string | null> = {}) {
  const url = new URL(googleAuthorizationEndpoint);
  const params: Record<string, string | null> = {
    client_id: client.clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "openid email profile",
    state: "state-1",
    nonce: "nonce-1",
    code_challenge: challenge,
    code_challenge_method: "S256",
    ...overrides,
  };
  for (const [name, value] of Object.entries(params)) {
    if (value !== null) url.searchParams.set(name, value);
  }
  return url;
}

/**
 * Answers the consent page and returns where Google redirects to. A null
 * leaves a field out, the way a browser leaves out an unchecked checkbox.
 */
async function consent(
  simulator: ReturnType<typeof setup>["simulator"],
  overrides: Record<string, string | null> = {},
  url = authorizationUrl(),
) {
  const form = new URLSearchParams();
  const fields: Record<string, string | null> = {
    email: "ada@example.com",
    email_verified: "on",
    action: "continue",
    ...overrides,
  };
  for (const [name, value] of Object.entries(fields)) {
    if (value !== null) form.set(name, value);
  }
  const response = await simulator.fetch(url, { method: "POST", body: form });
  expect(response.status).toBe(302);
  return new URL(response.headers.get("Location") ?? "");
}

function tokenRequest(
  simulator: ReturnType<typeof setup>["simulator"],
  code: string | null,
  overrides: Record<string, string | null> = {},
  headers: Record<string, string> = {},
) {
  const form = new URLSearchParams();
  const params: Record<string, string | null> = {
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: client.clientId,
    client_secret: client.clientSecret,
    code_verifier: verifier,
    ...overrides,
  };
  for (const [name, value] of Object.entries(params)) {
    if (value !== null) form.set(name, value);
  }
  return simulator.fetch(tokenEndpoint, {
    method: "POST",
    headers,
    body: form,
  });
}

/** The claims of an ID token, without checking anything. */
function decodeIdToken(body: { id_token: string }) {
  const payload = body.id_token.split(".")[1] ?? "";
  return JSON.parse(atob(payload.replaceAll("-", "+").replaceAll("_", "/")));
}

async function signIn(
  { simulator }: ReturnType<typeof setup>,
  form: Record<string, string | null> = {},
) {
  const redirect = await consent(simulator, form);
  const response = await tokenRequest(
    simulator,
    redirect.searchParams.get("code"),
  );
  expect(response.status).toBe(200);
  return decodeIdToken(await response.json());
}

it("is accepted from end to end by an OpenID Connect client", async () => {
  // oauth4webapi is the client pigy signs in with. It checks the discovery
  // document, the token response and the ID token against the
  // specifications, so this fails if the simulator strays from them. The
  // client reads the real clock, so the simulator has to as well.
  const simulator = createGoogleSimulator({ now: () => new Date(), client });
  const options = {
    // oauth4webapi spells "no body" as `body: undefined`, which the type of
    // `fetch` does not allow.
    [oauth.customFetch]: (
      url: string,
      {
        body,
        ...init
      }: oauth.CustomFetchOptions<string, URLSearchParams | undefined>,
    ) => simulator.fetch(url, body === undefined ? init : { ...init, body }),
  };
  const issuer = new URL(googleIssuer);
  const as = await oauth.processDiscoveryResponse(
    issuer,
    await oauth.discoveryRequest(issuer, options),
  );
  expect(as.authorization_endpoint).toBe(googleAuthorizationEndpoint);

  const codeVerifier = oauth.generateRandomCodeVerifier();
  const callback = await consent(
    simulator,
    { email: "Ada@Example.com", name: "Ada Lovelace" },
    authorizationUrl({
      code_challenge: await oauth.calculatePKCECodeChallenge(codeVerifier),
    }),
  );

  const oauthClient = { client_id: client.clientId };
  const response = await oauth.authorizationCodeGrantRequest(
    as,
    oauthClient,
    oauth.ClientSecretPost(client.clientSecret),
    oauth.validateAuthResponse(as, oauthClient, callback, "state-1"),
    redirectUri,
    codeVerifier,
    options,
  );
  const result = await oauth.processAuthorizationCodeResponse(
    as,
    oauthClient,
    response,
    { expectedNonce: "nonce-1", requireIdToken: true },
  );
  // Fetches the keys and checks the signature of the ID token with them.
  await oauth.validateApplicationLevelSignature(as, response, options);

  expect(oauth.getValidatedIdTokenClaims(result)).toMatchObject({
    iss: googleIssuer,
    aud: client.clientId,
    email: "Ada@Example.com",
    email_verified: true,
    name: "Ada Lovelace",
  });
});

it("labels the consent page as a simulation and offers the accounts", async () => {
  const { simulator } = setup({
    accounts: [{ email: "admin@example.com", name: "Local <Admin>" }],
  });

  const response = await simulator.fetch(authorizationUrl());

  expect(response.status).toBe(200);
  const page = await response.text();
  expect(page).toContain("Simulation");
  expect(page).toContain("admin@example.com");
  // Names end up in HTML, so they must not be able to carry markup.
  expect(page).toContain("Local &lt;Admin&gt;");
  expect(page).not.toContain("<Admin>");
});

it("gives an email address the same account ID every time", async () => {
  const google = setup();

  const first = await signIn(google, { email: "ada@example.com" });
  // Case and spaces do not make another account.
  const again = await signIn(google, { email: " ADA@example.com" });
  const other = await signIn(google, { email: "bob@example.com" });

  expect(first.sub).toMatch(/^\d{21}$/);
  expect(again.sub).toBe(first.sub);
  expect(other.sub).not.toBe(first.sub);
});

it("lets a test choose the account ID and an unverified email", async () => {
  const claims = await signIn(setup(), { sub: "42", email_verified: null });

  expect(claims.sub).toBe("42");
  expect(claims.email_verified).toBe(false);
});

it("leaves out what the scope does not ask for", async () => {
  const { simulator } = setup();
  const redirect = await consent(
    simulator,
    {},
    authorizationUrl({ scope: "openid" }),
  );

  const response = await tokenRequest(
    simulator,
    redirect.searchParams.get("code"),
  );
  const claims = decodeIdToken(await response.json());

  expect(claims.sub).toBeDefined();
  expect(claims).not.toHaveProperty("email");
  expect(claims).not.toHaveProperty("name");
});

it("dates the ID token by its own clock", async () => {
  const google = setup();

  const claims = await signIn(google);

  const now = google.clock.time.getTime() / 1000;
  expect(claims.iat).toBe(now);
  expect(claims.exp).toBe(now + 3600);
});

it("redirects with access_denied when the person cancels", async () => {
  const { simulator } = setup();

  const redirect = await consent(simulator, { action: "cancel" });

  expect(redirect.origin + redirect.pathname).toBe(redirectUri);
  expect(redirect.searchParams.get("error")).toBe("access_denied");
  expect(redirect.searchParams.get("state")).toBe("state-1");
  expect(redirect.searchParams.has("code")).toBe(false);
});

// Google shows an error page for these and never redirects, because it has
// no address it can trust to redirect to.
it.each([
  ["an unknown client", { client_id: "other" }, 401, "invalid_client"],
  [
    "a redirect address that is not registered",
    { redirect_uri: "https://evil.example/callback" },
    400,
    "redirect_uri_mismatch",
  ],
  [
    // Google compares character by character.
    "a redirect address that differs by a trailing slash",
    { redirect_uri: `${redirectUri}/` },
    400,
    "redirect_uri_mismatch",
  ],
  ["no redirect address", { redirect_uri: null }, 400, "redirect_uri_mismatch"],
  [
    "a response type other than code",
    { response_type: "token" },
    400,
    "invalid_request",
  ],
  ["a scope without openid", { scope: "email" }, 400, "invalid_scope"],
  [
    "an unknown challenge method",
    { code_challenge_method: "S512" },
    400,
    "invalid_request",
  ],
  [
    "a challenge method without a challenge",
    { code_challenge: null },
    400,
    "invalid_request",
  ],
  [
    "a malformed challenge",
    { code_challenge: "short" },
    400,
    "invalid_request",
  ],
] as const)(
  "refuses an authorization request with %s",
  async (_name, overrides, status, error) => {
    const { simulator } = setup();
    const url = authorizationUrl(overrides);

    const page = await simulator.fetch(url);
    // Posting the consent form must not get around the check either.
    const posted = await simulator.fetch(url, {
      method: "POST",
      body: new URLSearchParams({ email: "ada@example.com" }),
    });

    for (const response of [page, posted]) {
      expect(response.status).toBe(status);
      expect(response.headers.has("Location")).toBe(false);
      expect(await response.text()).toContain(`Error ${status}: ${error}`);
    }
  },
);

it.each([
  ["a wrong client secret", { client_secret: "wrong" }, 401, "invalid_client"],
  ["no client secret", { client_secret: null }, 401, "invalid_client"],
  ["an unknown client", { client_id: "other" }, 401, "invalid_client"],
  [
    "another redirect address than the code was issued for",
    { redirect_uri: "https://app.example/other" },
    400,
    "redirect_uri_mismatch",
  ],
  ["a wrong verifier", { code_verifier: "b".repeat(43) }, 400, "invalid_grant"],
  ["no verifier", { code_verifier: null }, 400, "invalid_grant"],
  [
    "another grant type",
    { grant_type: "refresh_token" },
    400,
    "unsupported_grant_type",
  ],
] as const)(
  "refuses a token request with %s",
  async (_name, overrides, status, error) => {
    const { simulator } = setup();
    const redirect = await consent(simulator);
    const code = redirect.searchParams.get("code");

    const response = await tokenRequest(simulator, code, overrides);

    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ error });
    // The failed attempt must not have used the code up: with everything
    // right it still works, so the refusal was for the one thing changed.
    expect((await tokenRequest(simulator, code)).status).toBe(200);
  },
);

it("refuses a token request that is not a form", async () => {
  const { simulator } = setup();

  const response = await simulator.fetch(tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ grant_type: "authorization_code" }),
  });

  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ error: "invalid_request" });
});

it("accepts the client secret in the Authorization header", async () => {
  const { simulator } = setup();
  const redirect = await consent(simulator);

  const response = await tokenRequest(
    simulator,
    redirect.searchParams.get("code"),
    { client_id: null, client_secret: null },
    {
      Authorization: `Basic ${btoa(`${client.clientId}:${client.clientSecret}`)}`,
    },
  );

  expect(response.status).toBe(200);
});

it("refuses a code the second time", async () => {
  const { simulator } = setup();
  const redirect = await consent(simulator);
  const code = redirect.searchParams.get("code");

  expect((await tokenRequest(simulator, code)).status).toBe(200);
  const second = await tokenRequest(simulator, code);

  expect(second.status).toBe(400);
  expect(await second.json()).toMatchObject({ error: "invalid_grant" });
});

it("refuses a code after ten minutes", async () => {
  const { simulator, clock } = setup();
  const redirect = await consent(simulator);
  const code = redirect.searchParams.get("code");

  clock.time = new Date(clock.time.getTime() + 10 * 60 * 1000);
  const response = await tokenRequest(simulator, code);

  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ error: "invalid_grant" });
});

it("still accepts a code just before the ten minutes are over", async () => {
  // The counterpart of the test above: it shows that the refusal there is
  // for the age of the code.
  const { simulator, clock } = setup();
  const redirect = await consent(simulator);

  clock.time = new Date(clock.time.getTime() + 10 * 60 * 1000 - 1000);
  const response = await tokenRequest(
    simulator,
    redirect.searchParams.get("code"),
  );

  expect(response.status).toBe(200);
});

it("refuses a code that was tampered with or made up", async () => {
  const { simulator } = setup();
  const redirect = await consent(simulator);
  const code = redirect.searchParams.get("code") ?? "";
  // Swap two characters in the middle of the code, which is in its payload.
  const middle = Math.floor(code.length / 2);
  const tampered =
    code.slice(0, middle) +
    code.charAt(middle + 1) +
    code.charAt(middle) +
    code.slice(middle + 2);
  expect(tampered).not.toBe(code);

  for (const bad of [tampered, "4/0made-up", "", null]) {
    const response = await tokenRequest(simulator, bad);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_grant" });
  }
});

it("does not take an ID token for a code", async () => {
  // Both are signed with the same key, so the type is what tells them apart.
  // Without that check, an ID token could be traded for a fresh one forever.
  const { simulator } = setup();
  const redirect = await consent(simulator);
  const response = await tokenRequest(
    simulator,
    redirect.searchParams.get("code"),
  );
  const { id_token: idToken } = await response.json();

  const second = await tokenRequest(simulator, `4/0${idToken}`);

  expect(second.status).toBe(400);
  expect(await second.json()).toMatchObject({ error: "invalid_grant" });
});

it("refuses a verifier for a code that was issued without a challenge", async () => {
  const { simulator } = setup();
  const redirect = await consent(
    simulator,
    {},
    authorizationUrl({ code_challenge: null, code_challenge_method: null }),
  );
  const code = redirect.searchParams.get("code");

  const withVerifier = await tokenRequest(simulator, code);
  const without = await tokenRequest(simulator, code, { code_verifier: null });

  expect(withVerifier.status).toBe(400);
  expect(without.status).toBe(200);
});

it("redeems a code that another instance issued", async () => {
  // Two Worker isolates each have their own simulator. A sign-in that starts
  // in one and ends in the other must still work.
  const issuing = setup().simulator;
  const redeeming = setup().simulator;
  const redirect = await consent(issuing);

  const response = await tokenRequest(
    redeeming,
    redirect.searchParams.get("code"),
  );

  expect(response.status).toBe(200);
});

it("answers 404 for an unknown path and fails for an unknown host", async () => {
  const { simulator } = setup();

  const unknownPath = await simulator.fetch(`${googleIssuer}/nope`);
  expect(unknownPath.status).toBe(404);

  // Like `fetch` for a host that cannot be reached. Above all, the request
  // must not be passed on to the network.
  await expect(simulator.fetch("https://example.invalid/")).rejects.toThrow(
    TypeError,
  );
});
