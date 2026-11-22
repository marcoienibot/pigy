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

/**
 * The key that a build for development and tests signs with as a client of
 * Bluesky when `BLUESKY_CLIENT_KEYS` is not set, for the sandbox of a pigy
 * that runs on somebody's machine. A private key of P-256 in PKCS #8, for
 * everybody to read, under the same rules as the key above: never in a
 * production build, which apps/web/scripts/check-build.mjs checks.
 */
/**
 * The key that a build for development and tests signs with as a sender of
 * push messages when `VAPID_PRIVATE_KEY` is not set. A private key of
 * P-256 in PKCS #8, for everybody to read, under the same rules as the
 * keys above: never in a production build, which apps/web/scripts/
 * check-build.mjs checks.
 */
export const developmentVapidKey =
  "MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgrcFc2MX0MRBIlLB78ZSOqneXGFezUOz3qSOjuwrzsn+hRANCAATHaygzW2aCiwiLLvHpSa8Ya2zbppIyzHGsw1FaWTr3eDakn7AVApXSGd2nro+eF5zNKo78zR6cNng8hbdiyLFF";

export const developmentBlueskyClientKeys =
  "0:MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgCj+9E/o0LdQG8E+Rihsa7GEbjQ7zSIaFoQ51knoAAgGhRANCAATKD3QJ85MhWIEglaVAztVqWPYx+He7d07jTs5peuVOm1SxxgUDDtXC/jWxSy3EJQe+8xdLna01e6MHdXCridoY";
