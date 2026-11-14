# Working on pigy

`PLAN.md` is the design: architecture, naming, repository layout and what each phase delivers. Read it before starting a phase.

## Setup

- Node.js 22 (`.nvmrc`).
- pnpm 12, pinned by `packageManager` in `package.json`. Install it without sudo with `npm install -g --prefix ~/.local pnpm` and make sure `~/.local/bin` is on `PATH`. `corepack pnpm` does not work: the corepack bundled with Node 22 cannot run pnpm 12.
- `pnpm install`

## Commands

Run from the repository root.

| Command | What it does |
| --- | --- |
| `pnpm dev` | Web app with hot reload and the Worker in the local Workers runtime, both on http://localhost:5173 |
| `pnpm build` | Production build of the web app and the Worker into `apps/web/dist` |
| `pnpm preview` | Serves the production build in the local Workers runtime |
| `pnpm lint` | Biome lint, format and import order check |
| `pnpm format` | Biome fixes for the above |
| `pnpm typecheck` | `tsc` in every package |
| `pnpm test` | All Vitest suites |
| `pnpm e2e` | Builds, then runs Playwright against the production build |

One package: `pnpm --filter @pigy/worker test`. One file: `pnpm --filter @pigy/worker test test/health.test.ts`. Watch mode: `pnpm --filter @pigy/core exec vitest`.

## Layout

| Path | Contents |
| --- | --- |
| `apps/web` | React 19, TanStack Router, Tailwind CSS v4, shadcn/ui. Its `vite.config.ts` builds and serves both the web app and the Worker |
| `apps/worker` | Hono app, `wrangler.jsonc`, tests that run in the Workers runtime |
| `packages/core` | Zod schemas and domain code shared by web and Worker. Consumed as TypeScript source, no build step |
| `e2e` | Playwright tests |

Imports:

- `apps/web` and `apps/worker` import `@pigy/core`. They never import each other.
- `packages/core` imports nothing from the apps and uses no DOM, Node or Workers APIs, because it runs in the browser and in the Worker.
- `e2e` imports no application code.

## Rules

- Tests never reach a real network host. External services are simulated.
- No tautological tests. When a test step or assertion is not obvious, add a comment saying why it is there.
- Code that talks to external services takes `fetch` and the clock as parameters. It never uses the globals.
- Validate data at boundaries with Zod schemas from `packages/core`. Share types, do not duplicate them.
- No secrets in the repository. Local secrets go in `apps/worker/.dev.vars`, which is git-ignored.
- `PLAN.md` is the design. If an implementation must deviate, update `PLAN.md` in the same change and say why.

## How to

**Add a screen.** Create `apps/web/src/routes/<name>.tsx` with `createFileRoute` and wrap the content in `<Page title="…">`. The dev server and the build regenerate `src/routeTree.gen.ts`: commit it, never edit it. Add the route to `navItems` in `src/components/app-shell.tsx` if it belongs in the navigation.

**Add a shadcn/ui component.** In `apps/web`, run `pnpm dlx shadcn@latest add <name>`, then `pnpm format` from the root. Components land in `src/components/ui`. Theme tokens are in `src/styles.css`.

**Add an API route.** Add it to the Hono app in `apps/worker/src` under `/api/`. Put the request and response schemas in `packages/core` and parse with them on both sides. Only `/api/*` reaches the Worker. Every other path is a static asset or the app shell, so a new prefix such as `/sync` must be added to `assets.run_worker_first` in `wrangler.jsonc`.

**Add a binding or variable.** Edit `apps/worker/wrangler.jsonc`, then run `pnpm typecheck`. It runs `wrangler types`, which regenerates the git-ignored `worker-configuration.d.ts` that declares `Env` and the runtime types. `pnpm install` generates it too.

**Add a test.**

- `packages/core`: `src/**/*.test.ts` next to the code. Runs in Node.
- `apps/worker`: `test/*.test.ts`. Runs inside the Workers runtime. Call the Worker with `exports.default.fetch()` and read bindings from `env`, both from `cloudflare:workers`. `test/setup.ts` makes the global `fetch` throw, and `vitest.config.ts` blocks anything that gets past it. Extend `test/setup.ts` when a simulated host has to be reachable through the global `fetch`.
- `e2e`: `tests/*.spec.ts`. Every test runs twice, in the `desktop` and `phone` projects. Traces of failed tests are kept in `e2e/test-results`.

## Tool versions

- The Workers test integration is `@cloudflare/vitest-plugin`, the renamed `@cloudflare/vitest-pool-workers`. It supports Vitest 4.1 and 5. This repository uses Vitest 5.
- `@playwright/test` is pinned to an exact version because each version needs its own browser build. After changing it, run `pnpm --filter @pigy/e2e exec playwright install chromium`.
- Versions shared by several packages are in the `catalog` of `pnpm-workspace.yaml`.
- pnpm refuses install scripts and agent skills from dependencies unless `pnpm-workspace.yaml` allows them. If `pnpm install` reports a package awaiting approval, decide there.
