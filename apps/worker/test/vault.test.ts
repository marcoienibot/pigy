import { expect, it } from "vitest";
import { developmentCredentialKeys } from "../src/development-keys.ts";
import type { Bindings } from "../src/env.ts";
import {
  createVault,
  type Vault,
  VaultError,
  vaultFor,
  vaultWithoutRequest,
} from "../src/vault.ts";
import { credentialKey, expectErrors } from "./helpers.ts";

const context = ["channel", "workspace-1", "mastodon", "1@mastodon.example"];
const credentials = { domain: "mastodon.example", accessToken: "token-123" };

/** The vault of `keys`, which must be a valid configuration. */
function vault(keys: string): Vault {
  const made = createVault(keys);
  if (typeof made === "string") throw new Error(made);
  return made;
}

/** The error that `action` fails with. */
async function failure(action: () => Promise<unknown>): Promise<unknown> {
  return action().then(
    () => undefined,
    (error: unknown) => error,
  );
}

it("opens what it has sealed", async () => {
  const { seal, open } = vault(`1:${credentialKey(1)}`);

  const sealed = await seal(context, credentials);

  expect(await open(context, sealed)).toEqual(credentials);
  // Nothing of the value can be read in what is stored.
  expect(sealed).not.toContain("token-123");
  expect(atob(sealed.split(".")[2] ?? "")).not.toContain("token-123");
});

it("seals the same value differently every time", async () => {
  const { seal } = vault(`1:${credentialKey(1)}`);

  // Otherwise somebody who reads the database could tell that two channels
  // hold the same token, or that a token is the one from before.
  expect(await seal(context, credentials)).not.toBe(
    await seal(context, credentials),
  );
});

it("does not open what was sealed with another key", async () => {
  const sealed = await vault(`1:${credentialKey(1)}`).seal(
    context,
    credentials,
  );

  // The same version, so the key is tried: the cipher is what refuses.
  const error = await failure(() =>
    vault(`1:${credentialKey(2)}`).open(context, sealed),
  );

  expect(error).toBeInstanceOf(VaultError);
});

it.each([
  ["of another account", ["channel", "workspace-1", "mastodon", "2@x.example"]],
  ["of another workspace", ["channel", "workspace-2", "mastodon", context[3]]],
  ["of another kind", ["oauth_state", "workspace-1", "mastodon", context[3]]],
])("does not open a value in the place %s", async (_name, other) => {
  const { seal, open } = vault(`1:${credentialKey(1)}`);
  const sealed = await seal(context, credentials);

  // What somebody does who can write to the database but has no key: copy
  // the sealed credentials of one channel to another, to post as the first.
  const error = await failure(() => open(other as string[], sealed));

  expect(error).toBeInstanceOf(VaultError);
});

it("tells apart places whose parts read the same when put in a row", async () => {
  const { seal, open } = vault(`1:${credentialKey(1)}`);
  // The ID of an account is whatever its network says, also this.
  const sealed = await seal(["channel", "workspace-1", "1\n2"], credentials);

  const error = await failure(() =>
    open(["channel", "workspace-1", "1", "2"], sealed),
  );

  expect(error).toBeInstanceOf(VaultError);
});

it("does not open a value that was changed", async () => {
  const { seal, open } = vault(`1:${credentialKey(1)}`);
  const sealed = await seal(context, credentials);
  const [version, nonce, ciphertext = ""] = sealed.split(".");
  // One character of the ciphertext is another.
  const changed = [
    version,
    nonce,
    (ciphertext.startsWith("A") ? "B" : "A") + ciphertext.slice(1),
  ].join(".");

  expect(await failure(() => open(context, changed))).toBeInstanceOf(
    VaultError,
  );
});

it.each([
  ["text that was never sealed", '{"accessToken":"token-123"}'],
  ["nothing", ""],
  ["a value with a part too many", "1.AAAAAAAAAAAAAAAA.AAAA.AAAA"],
  ["a nonce of the wrong length", "1.AAAA.AAAA"],
  ["a version that is not a number", "one.AAAAAAAAAAAAAAAA.AAAA"],
])("does not open %s", async (_name, sealed) => {
  const { open } = vault(`1:${credentialKey(1)}`);

  expect(await failure(() => open(context, sealed))).toBeInstanceOf(VaultError);
});

it("seals with the newest key and opens with the key of each value", async () => {
  const old = vault(`1:${credentialKey(1)}`);
  // The order in the configuration does not matter: the version does.
  const rotated = vault(`1:${credentialKey(1)}, 2:${credentialKey(2)}`);
  const fromBefore = await old.seal(context, credentials);

  const fromNow = await rotated.seal(context, credentials);

  // The version is stored with the value, which is how the right key is
  // found for it.
  expect(fromBefore.startsWith("1.")).toBe(true);
  expect(fromNow.startsWith("2.")).toBe(true);
  expect(await rotated.open(context, fromBefore)).toEqual(credentials);
  expect(await rotated.open(context, fromNow)).toEqual(credentials);
  // The old key alone does not open what the new one sealed.
  expect(await failure(() => old.open(context, fromNow))).toBeInstanceOf(
    VaultError,
  );
});

it("does not open a value whose key has been taken away", async () => {
  const sealed = await vault(`1:${credentialKey(1)}`).seal(
    context,
    credentials,
  );

  const error = await failure(() =>
    vault(`2:${credentialKey(2)}`).open(context, sealed),
  );

  expect(error).toBeInstanceOf(VaultError);
  expect(String(error)).toContain("no key of version 1");
});

// A key that is too short to be one, and that must not show up anywhere.
const weakKey = btoa("too-short-to-be-a-key");

it.each([
  ["a key without a version", credentialKey(1)],
  ["a key of the wrong length", `1:${weakKey}`],
  ["a key that is not base64", `1:${"!".repeat(44)}`],
  ["a version twice", `1:${credentialKey(1)},1:${credentialKey(2)}`],
  ["an empty entry", `1:${credentialKey(1)},`],
  ["nothing", ""],
])("refuses a configuration with %s", (_name, keys) => {
  const refusal = createVault(keys);

  // A description, for the log, in place of a vault. Sealing with part of a
  // configuration would hide the mistake until the day the rest is needed.
  expect(refusal).toBeTypeOf("string");
  expect(refusal).not.toContain(weakKey);
  expect(refusal).not.toContain(credentialKey(1));
});

/** The bindings of a deployment, as far as the vault reads them. */
const bindings = (keys?: string) =>
  (keys === undefined ? {} : { CREDENTIAL_KEYS: keys }) as Bindings;

it("is the vault of the configured keys", async () => {
  const configured = vaultFor(
    bindings(`1:${credentialKey(1)}`),
    developmentCredentialKeys,
    "http://localhost:5173",
  );

  // The key of the deployment, not the one in the repository, also where
  // the app is built with it and reached locally.
  const sealed = await configured?.seal(context, credentials);
  expect(sealed?.startsWith("1.")).toBe(true);
});

it.each([
  "http://localhost:5173",
  "http://localhost:4173",
  "http://127.0.0.1:5173",
  "http://pigy.localhost:5173",
])("falls back to the development key at %s", async (origin) => {
  const local = vaultFor(bindings(), developmentCredentialKeys, origin);

  const sealed = (await local?.seal(context, credentials)) ?? "";

  // Version 0 marks what the development key sealed.
  expect(sealed.startsWith("0.")).toBe(true);
  expect(await local?.open(context, sealed)).toEqual(credentials);
});

it.each([
  // A build with the development key that was deployed all the same.
  [
    "a build for development that is not reached locally",
    developmentCredentialKeys,
    "https://pigy.example",
  ],
  ["a production build", undefined, "https://pigy.example"],
  [
    "a production build that is reached locally",
    undefined,
    "http://localhost:4173",
  ],
])("has no vault in %s without keys", (_name, developmentKeys, origin) => {
  const errors = expectErrors();

  // Nothing to seal with, so nothing is sealed: whoever asks refuses to
  // store anything.
  expect(vaultFor(bindings(), developmentKeys, origin)).toBeUndefined();
  expect(String(errors.mock.calls[0]?.[0])).toContain(
    "CREDENTIAL_KEYS is not set",
  );
});

it("opens for work without a request what a request has sealed", async () => {
  // A step of the publishing workflow is reached at no address. It opens
  // what a route sealed, with the keys that the route had.
  const configured = await vaultFor(
    bindings(`1:${credentialKey(1)}`),
    undefined,
    "https://pigy.example",
  )?.seal(context, credentials);
  const local = await vaultFor(
    bindings(),
    developmentCredentialKeys,
    "http://localhost:5173",
  )?.seal(context, credentials);

  expect(
    await vaultWithoutRequest(
      bindings(`1:${credentialKey(1)}`),
      developmentCredentialKeys,
    )?.open(context, configured ?? ""),
  ).toEqual(credentials);
  // The development key, where the build has it: such a build is not
  // deployed, and what it holds was sealed with that key.
  expect(
    await vaultWithoutRequest(bindings(), developmentCredentialKeys)?.open(
      context,
      local ?? "",
    ),
  ).toEqual(credentials);
});

it("has no vault for work without a request in a production build without keys", () => {
  const errors = expectErrors();

  expect(vaultWithoutRequest(bindings(), undefined)).toBeUndefined();
  expect(String(errors.mock.calls[0]?.[0])).toContain(
    "CREDENTIAL_KEYS is not set",
  );
});

it("has no vault with keys that are not valid, and keeps them out of the log", () => {
  const errors = expectErrors();

  const invalid = vaultFor(
    bindings(`1:${weakKey}`),
    // Not a fallback for a configuration that is wrong.
    developmentCredentialKeys,
    "http://localhost:5173",
  );

  expect(invalid).toBeUndefined();
  const logged = errors.mock.calls.flat().join("\n");
  expect(logged).toContain("CREDENTIAL_KEYS is not valid");
  expect(logged).not.toContain(weakKey);
});
