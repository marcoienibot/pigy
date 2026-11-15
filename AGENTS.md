# Working on pigy

`PLAN.md` is the design: architecture, naming, repository layout and what each phase delivers. Read it before starting a phase. `SYNC.md` is the protocol through which clients keep a copy of a workspace and change it.

## Setup

- Node.js 22 (`.nvmrc`).
- pnpm 12, pinned by `packageManager` in `package.json`. Install it without sudo with `npm install -g --prefix ~/.local pnpm` and make sure `~/.local/bin` is on `PATH`. `corepack pnpm` does not work: the corepack bundled with Node 22 cannot run pnpm 12.
- `pnpm install`

Nothing else: `pnpm dev` needs no configuration, no Google project and no Cloudflare account.

## Commands

Run from the repository root.

| Command | What it does |
| --- | --- |
| `pnpm dev` | Web app with hot reload and the Worker in the local Workers runtime, both on http://localhost:5173. Brings the local database up to date first |
| `pnpm build` | Production build of the web app and the Worker into `apps/web/dist`. Fails if the build contains the simulated sign-in |
| `pnpm preview` | Builds for production and serves that build in the local Workers runtime, on http://localhost:4173. Sign-in needs Google credentials, see below |
| `pnpm preview:e2e` | Builds the app that `pnpm e2e` tests and serves it on http://localhost:4173, to try a built app by hand. Port 4173 must be free |
| `pnpm lint` | Biome lint, format and import order check |
| `pnpm format` | Biome fixes for the above |
| `pnpm typecheck` | `tsc` in every package |
| `pnpm test` | All Vitest suites |
| `pnpm e2e` | Runs `pnpm preview:e2e`, then Playwright against it. Port 4173 must be free |

One package: `pnpm --filter @pigy/worker test`. One file: `pnpm --filter @pigy/worker test test/health.test.ts`. Watch mode: `pnpm --filter @pigy/core exec vitest`.

## Signing in locally

Sign-in is with Google. Without Google credentials, a simulated Google stands in for it: "Sign in with Google" leads to a page of the app itself, labelled as a simulation, where you say who you are. Any email address works, no password.

- `pnpm dev` after a fresh clone: sign in as `admin@example.com`, which the simulated page offers with one click. It is the admin. Invite other addresses under Settings → Access, then sign in as them the same way.
- To change the admins, or to sign in with the real Google, copy `apps/worker/.dev.vars.example` to `apps/worker/.dev.vars` and follow the comments in it.
- `pnpm preview:e2e` always simulates, with `admin@example.com` as the admin, and starts from an empty database every time. It ignores `.dev.vars`.
- `pnpm preview` serves the production build, which has no simulated sign-in. Without Google credentials in `.dev.vars` its sign-in page says that sign-in is not set up.

Which Google is used is decided per request, in `accessConfig` in `apps/worker/src/auth/config.ts`: the real one if `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are set. Otherwise the simulated one, if the build has it and the request names a local host, as described below. Otherwise sign-in is refused.

The simulated sign-in signs anybody in as anybody, so it must never be deployed:

- `apps/worker/src/index.ts` builds it in only when the Vite mode is `development`, `test` or `e2e`. In a production build the bundler drops it.
- `pnpm build` runs `apps/web/scripts/check-build.mjs`, which fails if the production build contains it. `pnpm preview:e2e` runs the same script the other way round, to prove that the check still knows what to look for. If you rename something in the simulated sign-in, that run tells you to update the script.
- It answers only a request whose URL has a local hostname: `localhost`, a name that ends in `.localhost`, `127.0.0.1` or `[::1]`. That is `isLocal` in `apps/worker/src/auth/config.ts`. The Worker reads the hostname from the URL of the request, which comes from its `Host` header: it says what the client asked for, not where the client is. So a dev or e2e build that is exposed to a network, for example with `vite --host` or through a tunnel, lets anyone who sends a local `Host` header sign in as anybody. Keep those builds on the local machine.

## Layout

| Path | Contents |
| --- | --- |
| `apps/web` | React 19, TanStack Router, Tailwind CSS v4, shadcn/ui. Its `vite.config.ts` builds and serves both the web app and the Worker |
| `apps/worker` | Hono app, `wrangler.jsonc`, the D1 schema and its migrations, the Durable Object of a workspace with its own schema and migrations, tests that run in the Workers runtime |
| `packages/core` | Zod schemas and domain code shared by web and Worker. Consumed as TypeScript source, no build step. `src/sync` holds what client and server of the sync protocol share: the synced tables, the mutators and the messages |
| `packages/simulators` | Stand-ins for external services, written from their documentation. So far Google sign-in. Consumed as TypeScript source, one entry point per service: `@pigy/simulators/google` |
| `e2e` | Playwright tests |

Imports:

- `apps/web` imports `@pigy/core`. `apps/worker` imports `@pigy/core` and `@pigy/simulators`. The apps never import each other.
- `packages/core` imports nothing from the apps or the other packages. It runs in the browser and in the Worker, so it uses only the web-standard APIs that both have, such as `URL`, `crypto` and `TextEncoder`, and no browser-only, Node or Workers APIs.
- `packages/simulators` imports `@pigy/core` and nothing from the apps. It runs in the Worker, and in Node for its own tests, so the same limits apply.
- For both packages Biome rejects `window`, `document`, `localStorage`, `process` and `Buffer`, and Node modules in the source. The source is type-checked without Node types (`tsconfig.src.json`), the tests with them (`tsconfig.test.json`).
- `e2e` imports no application code.

In `apps/worker/src`: `index.ts` is the entry point and only chooses what the app and the Durable Object are built with. `app.ts` puts the routes together. `auth/` holds sign-in, sessions and the guards for routes, `admin/` the allowlist API, `db/schema.ts` the schema of D1.

`workspace/` holds the data of the workspaces. Each workspace is a Durable Object of the class `WorkspaceDO` with a SQLite database of its own:

- `object.ts` is the object: its sockets and the messages of the sync protocol.
- `store.ts` is its database: it runs mutators, numbers the changes and works out what a client is missing.
- `schema.ts` has its tables, `migrations/` what `drizzle-kit` generates from them.
- `synced.ts` lists the columns that clients get to see, and is the only code that reads or writes them.
- `workspaces.ts` is the Worker's side: the `workspace` table of D1, and `connectWorkspace` and `mutateWorkspace`, the only ways into an object.
- `routes.ts` has `GET /api/workspaces` and the WebSocket endpoint `/sync/<workspace ID>`.

## Rules

- Tests never reach a real network host. External services are simulated.
- No tautological tests. When a test step or assertion is not obvious, add a comment saying why it is there.
- Code that talks to external services takes `fetch` and the clock as parameters, typed `Fetch` and `Clock` from `@pigy/core`. It never uses the globals. In the Worker both come from `createApp` in `src/app.ts`.
- Validate data at boundaries with Zod schemas from `packages/core`. Share types, do not duplicate them.
- The synced data of a workspace changes only through mutators from `packages/core`, run by the workspace's Durable Object. No other code writes to a synced table.
- `SYNC.md` is the contract with the clients. Change it in the same change as the code. Raise `syncProtocolVersion` when the messages or their meaning change and `syncSchemaVersion` when the synced tables or the mutators do: a client that speaks another version is turned away until it has updated itself.
- No secrets in the repository. Local secrets go in `apps/worker/.dev.vars`, which is git-ignored.
- `PLAN.md` is the design. If an implementation must deviate, update `PLAN.md` in the same change and say why.

## How to

**Add a screen.** Create `apps/web/src/routes/_app/<name>.tsx` with `createFileRoute` and wrap the content in `<Page title="…">`. Everything under `_app` needs a session: `_app.tsx` checks it before anything renders and puts who is signed in into the route context, `Route.useRouteContext().me`. A screen for people who are not signed in goes next to `sign-in.tsx` and uses `<PublicPage>`. The dev server and the build regenerate `src/routeTree.gen.ts`: commit it, never edit it. Add the route to `navItems` in `src/components/app-shell.tsx` if it belongs in the navigation.

**Add a shadcn/ui component.** Run `pnpm --filter @pigy/web exec shadcn add <name>`, then `pnpm format` from the root. This runs the `shadcn` version that `apps/web` depends on, the same one whose CSS its styles import. Components land in `apps/web/src/components/ui`. Theme tokens are in `apps/web/src/styles.css`. If the command asks whether to overwrite a component that exists, say no.

**Add an API route.** Add it to a group of routes under `/api/` in `apps/worker/src`, or add a group and mount it in `app.ts`. Put the request and response schemas in `packages/core` and parse with them on both sides: `parseJsonBody` in `src/errors.ts` does it for a request body. To refuse a request, throw Hono's `HTTPException` with the status and a message for the client. It becomes an error response in the shape of `errorResponseSchema`, with the error name that `PLAN.md` section 12 gives the status. Any other exception becomes a JSON 500 that says nothing about it. Guard a route with `requireUser`, and `requireAdmin` after it, from `src/auth/guards.ts`: the first also refuses requests that change something and do not come from pigy's own pages. In the web app, call the route through `request` in `apps/web/src/lib/api.ts`. Only `/api/*`, `/sim/*` and `/sync/*` reach the Worker. Every other path is a static asset or the app shell, so a new prefix such as `/connect` must be added to `assets.run_worker_first` in `wrangler.jsonc`.

**Change the database schema.** There are two databases. Never edit a migration of either that is on `main`.

- D1 holds sign-in and what is global. Edit `apps/worker/src/db/schema.ts`, run `pnpm --filter @pigy/worker db:generate --name <what_changed>` and commit the files it adds to `apps/worker/migrations`. The migrations are applied by `pnpm dev`, `pnpm preview` and `pnpm preview:e2e` when they start, and by `test/setup.ts` before every Worker test.
- Every workspace has a SQLite database in its Durable Object. Edit `apps/worker/src/workspace/schema.ts`, run `pnpm --filter @pigy/worker workspace:generate --name <what_changed>` and commit what it adds and changes in `apps/worker/src/workspace/migrations`. That includes `migrations.js`, which imports the SQL files and is how they get into the Worker. Nothing applies these migrations from outside: each object applies them to its own database when it starts, so after a deploy a workspace is migrated the next time it is used. A migration therefore has to work on a database of any age, and the code must not assume that all workspaces change at once.

**Add a synced table**, one that clients hold a copy of.

1. Describe its rows in `packages/core/src/sync/tables.ts`: a strict Zod schema with an `id`, added to `rowSchemas`. Add `putSchema("<table>")` to `changeSchema` in `protocol.ts`.
2. Add the table to `apps/worker/src/workspace/schema.ts` and generate the migration. No "on delete cascade" and no triggers: a row that the database changes by itself is a change that no client hears of.
3. List the table and its synced columns in `synced` in `apps/worker/src/workspace/synced.ts`. The compiler compares the list with the row in `packages/core`.
4. Raise `syncSchemaVersion` and describe the table in `SYNC.md`.
5. Add the table to the two local copies that tests keep, which list the tables by hand: `SyncClient` in `apps/worker/test/sync-client.ts` and `memoryWorkspace` in `packages/core/test/memory-transaction.ts`.

Nothing else in the server: the change log and the patches work on any table that `synced` lists.

A column that clients must not see goes into `schema.ts` and not into `synced.ts` and the row schema. It has to be nullable or have a default, because a mutator that creates a row writes only the synced columns. Code in the object reads and writes it with Drizzle, outside the mutators. A table that clients must not see is simply not listed. `sync.test.ts` has the test that proves both, and it should gain a case when the first real secret arrives.

**Add a mutator.** Add it to `mutators` in `packages/core/src/sync/mutators.ts`: a name, a strict Zod schema for its arguments and a function over the `Transaction`. It is synchronous, uses nothing but its arguments and the transaction, and takes the time from `tx.now`, because a client runs it too. It refuses by throwing `MutationRejected` with a code from `rejectionCodeSchema`. The state guards belong here, not in the callers. Unit-test it in `mutators.test.ts`, raise `syncSchemaVersion`, and add it to the table in `SYNC.md`.

**Change a workspace from Worker code**, without a client, as the REST API will. Look the workspace up in D1, which is where it is decided whose it is, and call `mutateWorkspace(env.WORKSPACE, workspace, name, args)` from `src/workspace/workspaces.ts`. It runs the mutator in the workspace's object, and the clients that are connected receive the change. It answers `{ ok: true }` or the reason the mutator refused, and throws if the database of the workspace failed.

A call to `mutateWorkspace` cannot be repeated safely. If it fails on the way, after the object has committed the change, the caller cannot tell, and a second call would run a mutator again that is not idempotent. Callers that retry, which are the publishing pipeline in phase 3 and the REST API in phase 6, need one of two things: mutators that are idempotent by design, or a `mutateWorkspace` that takes an identifier from the caller and goes through the bookkeeping that skips a client's mutation the second time. The first such caller decides.

**Add a binding or variable.** Edit `apps/worker/wrangler.jsonc`, then run `pnpm typecheck`. It runs `wrangler types`, which regenerates the git-ignored `worker-configuration.d.ts` that declares `Env` and the runtime types. `pnpm install` generates it too. A secret is not in `wrangler.jsonc`: declare it in `Secrets` in `apps/worker/src/env.ts`, as optional, and add it to `.dev.vars.example`. Routes take their bindings from the `Bindings` type there, not from `Env`, which differs between machines with and without a `.dev.vars`.

**Add a simulator.** Add a directory to `packages/simulators/src` and an entry to `exports` in its `package.json`. A simulator answers on the real addresses of the service, as a function with the signature of `fetch` that fails for every other host. It is written from the documentation of the service, rejects what the service rejects, takes its clock as a parameter, and has tests of its own. `src/google` is the example.

**Add a test.**

- `packages/core` and `packages/simulators`: `src/**/*.test.ts` next to the code. Runs in Node, so a test may import Node modules, which the code under test may not. `test/setup.ts` makes the global `fetch` throw.
- `apps/worker`: `test/*.test.ts`. Runs inside the Workers runtime. `test/setup.ts` makes the global `fetch` throw and gives every test an empty database with the current schema. `vitest.config.ts` sends anything that gets past the guard on `fetch`, TCP connections included, to a Worker that refuses it. `test/helpers.ts` has what a test of a route needs: `setup()` builds the app with a clock the test can move, a simulated Google behind its `fetch` and bindings of its own, so that nothing from `.dev.vars` gets in. `signedIn()` returns a browser that is signed in, `Browser` keeps cookies and sends `Origin` the way browsers do. To test what the app does with an answer that Google would not give, pass `intercept` to `setup()` and change the answer on its way. `resignIdToken` from `@pigy/simulators/google` changes claims of an ID token and keeps its signature good. A route that needs none of this can be called with `exports.default.fetch()` from `cloudflare:workers`.
- Workspaces in `apps/worker` tests. The tests run `test/main.ts` in place of `src/index.ts`: the same Worker, with workspace objects whose clock is the one that `setup()` returns, so `advance()` moves time for them too. `test/sync-client.ts` has a client of the sync protocol that keeps a local copy like a real one and fails on anything that `SYNC.md` does not allow: `new SyncClient()`, `connect(browser, workspaceId)`, `mutate(name, args)`, `patch()`. It also has `workspaceIds(browser)`, and `identityOf()` for calling `mutateWorkspace` directly. From `cloudflare:test`, `evictDurableObject(objectOf(id))` takes an object out of memory and leaves its sockets open, which is what hibernation does, and `runInDurableObject` reaches its database. To make an object fail at a point of the test's choosing, spy on a method of `WorkspaceStore.prototype` with `vi.spyOn`: the objects run in the isolate of the test and share its modules. Await a call on an object's stub before giving the result to `expect`: `expect` looks at properties of what it is given, and on the promise of a stub every property is another call. `test/setup.ts` deletes all objects before every test and closes their sockets first.
- `e2e`: `tests/*.spec.ts`. Import `test` and `expect` from `e2e/fixtures.ts`, never from `@playwright/test`, which Biome rejects in a spec: that `test` fails a test whose page requests a host other than the app or opens a WebSocket to one, and blocks both. It cannot block a request that a redirect leads to, so `playwright.config.ts` also starts the browser with a rule that lets it resolve no host but `localhost`. The app must stay addressed as `localhost`, and the rule is a Chromium switch: a project on another browser would run without it. The same file has what tests need to be somebody: the `signedInPage` fixture is `page` signed in as the admin, `signIn(page, email)` goes through the simulated consent page, `newPerson()` opens a page for a second person, and `uniqueEmail()` makes an address for a test to invite. All tests share one database and run at the same time, so a test only changes entries it has made. For the same reason a test never has a sign-in refused as the admin, for example with an unverified address: that ends the admin's sessions in every other test. Every test runs twice, in the `desktop` and `phone` projects. Traces of failed tests are kept in `e2e/test-results`. The tests in `network-guard.spec.ts` are expected to fail, so the list reporter marks them with a cross in a run that passes.
- The Worker under e2e makes no outbound requests: the e2e build has no Google credentials, so sign-in is answered inside the Worker. It is not guarded beyond that yet. That comes in phase 3, when the Worker starts to call the networks.

## Deployment

Deployment is set up in phase 11. Until then nothing is deployed. What the code already relies on:

- `wrangler.jsonc` binds the Durable Object class `WorkspaceDO` as `WORKSPACE` and declares it in `migrations` with `new_sqlite_classes`. The first `wrangler deploy` creates the class with SQLite storage: nothing to set up beforehand. The entry `v1` must be right before that deploy, because the storage of a class cannot be changed afterwards, and an entry that has been deployed is never edited. Renaming or deleting the class takes a new entry with a new tag.
- The databases of the workspaces need no step in a deploy. Their migrations are part of the Worker: the build puts each SQL file next to `index.js` as a module of its own, which `wrangler deploy` uploads with it.
- A deploy can close the sync sockets, and clients connect again by themselves. It can also leave a socket open under the new code. If the deploy raised `syncProtocolVersion` or `syncSchemaVersion`, the object closes such a socket the next time it is used, and clients that still run the old app are turned away until they have loaded the new one.
- The D1 database has no `database_id` in `wrangler.jsonc`. The first `wrangler deploy` creates a database named `pigy` and binds it, and later deploys keep the binding. Wrangler 4.162 does this by default. Migrations are applied to it with `wrangler d1 migrations apply DB --remote`.
- The Worker needs three secrets: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and `ADMIN_EMAILS`. Without the first two nobody can sign in. The Google client needs the redirect address `https://<host>/api/auth/google/callback`.
- Always deploy right after `pnpm build`, never after `pnpm preview:e2e` or `pnpm e2e`. Each build points `wrangler deploy` at itself, through `apps/web/.wrangler/deploy/config.json`, and the e2e build contains the simulated sign-in.

## Tool versions

- The Workers test integration is `@cloudflare/vitest-plugin`, the renamed `@cloudflare/vitest-pool-workers`. It supports Vitest 4.1 and 5. This repository uses Vitest 5.
- `@playwright/test` is pinned to an exact version because each version needs its own browser build. After changing it, run `pnpm --filter @pigy/e2e exec playwright install chromium`.
- Drizzle is `drizzle-orm` 0.45 with `drizzle-kit` 0.31, the stable line. Version 1 is in beta and stores migrations differently. D1 uses `drizzle-orm/d1`, the workspaces `drizzle-orm/durable-sqlite`, which is synchronous. `drizzle.config.ts` is for the first, `drizzle.workspace.config.ts` for the second.
- Versions shared by several packages are in the `catalog` of `pnpm-workspace.yaml`.
- pnpm refuses install scripts and agent skills from dependencies unless `permissions` in `pnpm-workspace.yaml` allows them. If `pnpm install` reports a package awaiting approval, decide there. Do not add `allowBuilds`: `permissions` overrides it.
