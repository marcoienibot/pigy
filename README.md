<img src="assets/icon.svg" width="64" height="64" alt="">

# pigy

pigy is an invite-only web app for writing a post once and publishing it to LinkedIn, Mastodon, Bluesky and Threads. It runs as a single Cloudflare Worker with a local-first React frontend.

pigy is under construction. [PLAN.md](PLAN.md) holds the design and the phases it is built in. [AGENTS.md](AGENTS.md) holds the conventions for working on the code.

## Development

Prerequisites: Node.js 22 and pnpm 12. If pnpm is missing, `npm install -g --prefix ~/.local pnpm` installs it without sudo.

```sh
pnpm install
pnpm dev
```

`pnpm dev` serves the web app and the Worker together on http://localhost:5173. The Worker runs in the local Workers runtime, so no Cloudflare account is needed.

```sh
pnpm lint        # Biome lint and format check
pnpm typecheck   # TypeScript in every package
pnpm test        # unit tests and Worker tests in the Workers runtime
pnpm e2e         # Playwright against the production build
pnpm build       # production build into apps/web/dist
```

The end-to-end tests need Chromium once: `pnpm --filter @pigy/e2e exec playwright install chromium`.
