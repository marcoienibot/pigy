<img src="assets/icon.svg" width="64" height="64" alt="">

# pigy

pigy is an invite-only web app for writing a post once and publishing it to LinkedIn, Mastodon, Bluesky and Threads. It runs as a single Cloudflare Worker with a local-first React frontend.

pigy is under construction. [PLAN.md](PLAN.md) holds the design and the phases it is built in. [AGENTS.md](AGENTS.md) holds the conventions for working on the code. [SYNC.md](SYNC.md) describes the protocol that keeps the app's local data in step with the server.

## Development

Prerequisites: Node.js 22 and pnpm 12. If pnpm is missing, `npm install -g --prefix ~/.local pnpm` installs it without sudo.

```sh
pnpm install
pnpm dev
```

`pnpm dev` serves the web app and the Worker together on http://localhost:5173. The Worker runs in the local Workers runtime, so no Cloudflare account is needed.

Sign-in needs no setup either. Locally a simulated Google stands in for the real one: "Sign in with Google" opens a page, labelled as a simulation, where you choose who to be. Choose `admin@example.com`, the local admin, and invite other addresses under Settings → Access. You start in your sandbox, where the networks are simulated and nothing is posted for real: connect one of its made-up accounts from the Channels screen. The switch to live is at the top of the sidebar. To change the admins or to sign in with the real Google, see `apps/worker/.dev.vars.example`.

```sh
pnpm lint          # Biome lint and format check
pnpm typecheck     # TypeScript in every package
pnpm test          # unit tests and Worker tests in the Workers runtime
pnpm e2e           # Playwright against a build with simulated sign-in
pnpm build         # production build into apps/web/dist
pnpm preview:e2e   # the build that pnpm e2e tests, on http://localhost:4173
```

`pnpm preview:e2e` is the way to try a built app by hand: it is the production build in everything but sign-in, which is simulated as under `pnpm dev`, and it starts from an empty database. `pnpm preview` serves the real production build, where signing in takes Google credentials.

A built app installs, from the address bar of Chrome or from Settings, and starts without a connection once somebody has signed in. `pnpm dev` has no service worker, so neither works there.

The end-to-end tests need Chromium once: `pnpm --filter @pigy/e2e exec playwright install chromium`.
