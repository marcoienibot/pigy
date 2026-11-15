// Checks whether a build contains what is for development and tests only and
// must never be deployed: the simulated Google sign-in, which signs anybody
// in as anybody, and the development keys: the one that seals the
// credentials of the channels, and the one that pigy signs with as a client
// of Bluesky, both in the repository. Also the ID of an e2e build, which is
// harmless, but which a production build has no use for: what is deployed
// has nothing of the tests.
//
//   node scripts/check-build.mjs <build directory> <absent|present>
//
// `absent` is for the production build. `present` is for the e2e build: it
// proves that the texts searched for are still the ones that these things
// are made of, so that `absent` cannot pass because they were renamed.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const [directory, expectation] = process.argv.slice(2);
if (!directory || !["absent", "present"].includes(expectation)) {
  console.error("Usage: check-build.mjs <build directory> <absent|present>");
  process.exit(2);
}

// One text from each part of the simulated sign-in, the development keys,
// and what every ID of an e2e build begins with.
// A bundler can rename identifiers, not the contents of strings.
const markers = [
  // The consent page, packages/simulators/src/google/pages.ts.
  "This page stands in for Google in development and tests.",
  // The key the simulated Google signs with, .../google/signing-key.ts.
  "simulated-google-key-1",
  // The Worker's wiring, apps/worker/src/simulated-google.ts.
  "pigy-simulated.apps.googleusercontent.com",
  // The development keys, apps/worker/src/development-keys.ts.
  "cGlneS1kZXZlbG9wbWVudC1rZXktbm90LXNlY3JldCE=",
  "MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgCj+9E/o0LdQG8E+Rihsa7GEbjQ7zSIaFoQ51knoAAgGhRANCAATKD3QJ85MhWIEglaVAztVqWPYx+He7d07jTs5peuVOm1SxxgUDDtXC/jWxSy3EJQe+8xdLna01e6MHdXCridoY",
  // The ID of an e2e build, `e2eBuildId` in apps/web/vite.config.ts.
  "pigy-e2e-build ",
];

const files = readdirSync(directory, { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile())
  .map((entry) => join(entry.parentPath, entry.name));
const found = new Map(markers.map((marker) => [marker, []]));
for (const file of files) {
  const content = readFileSync(file, "latin1");
  for (const marker of markers) {
    if (content.includes(marker)) found.get(marker).push(file);
  }
}

let failed = false;
for (const [marker, places] of found) {
  if (expectation === "absent" && places.length > 0) {
    failed = true;
    console.error(
      `The production build contains what is for development only: "${marker}" is in ${places.join(", ")}`,
    );
  }
  if (expectation === "present" && places.length === 0) {
    failed = true;
    console.error(
      `"${marker}" is not in the e2e build. If the simulated Google sign-in, a development key or the ID of an e2e build was changed, update the markers in apps/web/scripts/check-build.mjs.`,
    );
  }
}
if (files.length === 0) {
  failed = true;
  console.error(`${directory} holds no build`);
}
process.exit(failed ? 1 : 0);
