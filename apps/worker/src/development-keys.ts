/**
 * The key that a build for development and tests seals with when
 * `CREDENTIAL_KEYS` is not set, so that a fresh clone needs no setup. It is
 * here for everybody to read, so it protects nothing, and it must never be
 * part of a production build: only src/index.ts imports this file, and only
 * under a condition that is false in production. apps/web/scripts/
 * check-build.mjs fails a production build that contains it.
 *
 * The key is the text "pigy-development-key-not-secret!" in base64. Its
 * version is 0, which no key that is configured should have: a value that
 * begins with "0." was sealed with this key.
 */
export const developmentCredentialKeys =
  "0:cGlneS1kZXZlbG9wbWVudC1rZXktbm90LXNlY3JldCE=";
