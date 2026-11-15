# pigy implementation plan

Draft for review, 2026-11-14.

pigy is an invite-only web app for writing a post once and publishing it to LinkedIn, Mastodon, Bluesky and Threads. It runs on Cloudflare Workers, installs on phones as a PWA, works offline, and has a REST API with API keys.

## 1. Decisions

### From your answers

| Area | Decision |
| --- | --- |
| Publishing | Publish now, save as draft, schedule for an exact time, and a queue with recurring weekly slots |
| Content | Text can be overridden per network. Threads are published as reply chains on Bluesky, Mastodon and Threads, and joined into one post on LinkedIn |
| Media | Images and video |
| API | REST with an OpenAPI spec, using Buffer's resource names, fields and enums |
| Stack | TypeScript backend, local-first frontend that feels like Linear |
| Extras in the first version | Push notifications for failures, share-to-pigy from the phone share sheet, engagement stats |
| Sandbox | Simulated networks that work in the UI, so people can try pigy before connecting accounts. Signed-in users only, no public demo |
| Tests | CI runs against simulated networks and never calls the real services |
| Queue | One posting schedule per user, shared by all accounts. A cross-post goes out everywhere at the same time |
| Domain | Start on the free `workers.dev` address that Cloudflare gives every Worker |
| Later | LinkedIn company pages, a custom domain |

### Made on your behalf

| Area | Decision | Why |
| --- | --- | --- |
| Sign-in | Google only | The allowlist is keyed on a verified email. Bluesky gives no email, and a second provider adds a second identity to reconcile. LinkedIn sign-in can be added later in a few lines |
| Sign-in code | `oauth4webapi` for the OpenID Connect flow, and sessions of our own on D1. Not Better Auth, which an earlier draft of this plan named | Code that talks to external services gets `fetch` and the clock as parameters (section 6), so that tests and local development run against simulators and never reach a real host. Better Auth has no way to pass a `fetch` to the requests it makes to the provider: discovery, token exchange and signing keys. `oauth4webapi` takes one. Sessions are a small, well-documented pattern (section 11) |
| Invite-only | Email allowlist stored in the database, managed from an admin page | No redeploy to invite a friend. Removing an email signs that person out |
| Frontend | React, Vite, TanStack Router, TanStack DB, Tailwind, shadcn/ui | The local-first libraries are best supported on React. The speed comes from reading local data, not from the framework |
| Data | One Durable Object with SQLite per user and environment, D1 for sign-in and global data | Local-first sync needs ordered, transactional writes per user, which a Durable Object gives for free |
| Publishing | Cloudflare Workflows, started by Durable Object alarms | Publishing is multi-step and must survive retries without double-posting |
| Sandbox shape | A Live/Sandbox switch per user, like Stripe's test mode | Sandbox data, accounts and API keys stay fully separate from real ones |

## 2. Terms

- **Workspace**: one user's data in one environment (live or sandbox).
- **Channel**: a connected social account. This is Buffer's term.
- **Post**: one piece of content, made of one or more parts.
- **Part**: one item of a thread. An ordinary post has a single part.
- **Target**: the delivery of a post to one channel. It has its own status, optional text override, result links and stats.

## 3. Architecture

```
 Browser / installed PWA                      Cloudflare Worker "pigy"
┌──────────────────────────────┐          ┌─────────────────────────────────────────┐
│ React UI                     │  HTTPS   │ Hono router                             │
│ TanStack DB (rows in memory) │◄────────►│  /api/auth/*   sign-in with Google      │
│ IndexedDB (rows + outbox)    │          │  /api/admin/*  the allowlist            │
│                              │          │  /api/v1/*     public REST API          │
│ Service worker (shell, push) │◄────────►│  /sync/*       WebSocket to WorkspaceDO │
└──────────────────────────────┘ WebSocket│  /connect/*    OAuth to the networks    │
                                          │  /m/*          signed media URLs        │
                                          │  /sim/*        simulated services       │
                                          └────┬─────────────┬──────────────┬───────┘
                                               │             │              │
                                   ┌───────────▼───┐   ┌─────▼──────┐  ┌────▼─────┐
                                   │ WorkspaceDO   │   │ D1         │  │ R2       │
                                   │ per user+env  │   │ users      │  │ media    │
                                   │ posts         │   │ sessions   │  └──────────┘
                                   │ channels      │   │ allowlist  │
                                   │ queue, stats  │   │ API keys   │
                                   │ change log    │   └────────────┘
                                   │ alarms        │
                                   └───────┬───────┘
                                           │ starts
                                   ┌───────▼────────┐  provider adapters  ┌──────────────────┐
                                   │ PublishWorkflow│────────────────────►│ live: real APIs  │
                                   │ durable steps  │   injected fetch    │ sandbox: /sim    │
                                   └────────────────┘                     └──────────────────┘
```

Everything is one Worker deployment. The React app is served as Worker static assets.

### Repository layout

```
apps/web          React app, service worker, PWA manifest
apps/worker       Hono routes, Durable Objects, Workflows, D1 migrations
packages/core     Shared domain code: schemas, mutators, validation, text utilities, limits
packages/providers   The contract with a network, and the LinkedIn, Mastodon, Bluesky and Threads adapters
packages/simulators  Simulated versions of the four networks, Google sign-in and web push
e2e               Playwright tests
```

Tooling: pnpm workspaces, strict TypeScript, Biome, Vitest, Playwright, Wrangler, the Cloudflare Vite plugin, Drizzle for both D1 and Durable Object SQLite.

## 4. Local-first sync

The UI never waits for the network. It reads from memory, writes locally first, and syncs in the background. [SYNC.md](SYNC.md) is the protocol between client and server, in enough detail to write a client from.

- **Source of truth**: one `WorkspaceDO` per workspace. All writes go through it in a single order.
- **Client state**: every row of the workspace is held in TanStack DB collections and mirrored to IndexedDB. A cold start renders from IndexedDB before any request finishes.
- **Writes**: named mutators such as `post.create`, `part.setText` and `post.schedule` live in `packages/core`. They are synchronous functions over a small transaction interface: read a row, find rows by a column, write a row, delete a row, the time. The client runs them optimistically. The Durable Object runs the same code as the authority. The REST API calls the same mutators, so an API write shows up in open tabs immediately.
- **Idempotency**: IDs are generated on the client (UUIDv7). Each client numbers its mutations, and the Durable Object remembers the last number applied per client, so a replay is a no-op and a gap is refused.
- **Transport**: one WebSocket per device, to `/sync/<workspace ID>`, using Durable Object hibernation so idle connections cost nothing. One tab holds the socket and shares updates with other tabs over BroadcastChannel. The Durable Object holds a client to that: a second socket of the same client closes the first.
- **Catch-up**: every committed write gets an increasing sequence number and an entry in a change log, which names the rows that changed. A reconnecting client sends its last sequence number and receives the current state of the rows that changed since. The log covers the last 1,000 changes: a client that is further behind gets a fresh snapshot.
- **Confirmation**: the message that carries the changes of a client's mutation also says that the mutation was processed, so the client can replace its own version of the change with the server's in one step.
- **Offline**: mutations queue in an IndexedDB outbox and replay in order on reconnect. A rejected mutation rolls back and shows an error on the affected post. The Durable Object keeps the reason until the client has seen it, so the error is shown also when the answer that carried it was lost.
- **Conflicts**: the server applies mutations in arrival order, last write wins per field. State guards reject impossible edits, such as changing a post that is already sending.
- **Secrets**: channel credentials are never synced. Each table has an explicit list of synced columns, and a test fails if a credential field appears in any sync message.
- **Versions**: the protocol and the synced schema each have a version number. A client that says hello with another version is told so, and updates itself.

**Library choice.** TanStack DB is the client store. The sync protocol is ours and small. Alternatives considered:

| Option | Verdict |
| --- | --- |
| Zero | Needs Postgres and its own server process, so it cannot run on Workers alone |
| LiveStore | Event-sourced. The scheduler and REST API would have to take part in the event log, which is a larger change of model than this app needs |
| Replicache | Fits well, but is in maintenance mode, and it brings a protocol of its own, which the server does not speak |

**Spike before committing** (first task of phase 2b). Build drafts only, then check: cold start renders from IndexedDB with the network disabled, an offline edit survives a reload and syncs later, two tabs converge, and an API write appears live. The protocol was fixed with the server, in phase 2a, and does not depend on the client library. So if TanStack DB cannot do this cleanly, the fallback is a small client store of our own that speaks the same protocol. An earlier draft named Replicache as the fallback: that would mean replacing the protocol and the server side of sync with Replicache's.

## 5. Data model

**D1 (global)**

| Table | Purpose |
| --- | --- |
| `user` | Google account ID, which is the identity, and the email and name as of the last sign-in |
| `session` | ID, SHA-256 of the session secret, user, expiry |
| `allowed_email` | Email, role (admin or member), who invited them |
| `workspace` | ID, owner, environment (live or sandbox) |
| `api_key` | Workspace, name, visible prefix, SHA-256 hash, scopes, last used, expiry, revoked |
| `push_subscription` | Web push endpoints per user and device |
| `mastodon_app` | OAuth client per Mastodon instance, shared by all users of the live environment. A cache: the adapter replaces an entry that the instance no longer knows |
| `oauth_state` | What an adapter needs to finish a connection that has begun, kept under the `state` of the callback for a few minutes. It holds secrets: a PKCE verifier, and for Mastodon the client secret |

**WorkspaceDO SQLite (per workspace)**

| Table | Purpose |
| --- | --- |
| `channel` | Network, account ID, handle, name, avatar, status, the limits of the account, when to refresh the access and when it ends, encrypted credentials |
| `post` | Status, mode, due time, source (UI or API), tags, timestamps |
| `post_part` | Ordered text of each part |
| `part_media` | Media attached to a part, with alt text |
| `post_target` | Post and channel, status, optional override of the parts, error, sent time |
| `target_part_result` | Remote ID and URL of each published part |
| `media` | Kind, type, size, dimensions, duration, R2 key, processing status |
| `schedule_slot`, `settings` | Weekly queue slots, timezone, queue paused flag |
| `metric` | Likes, reposts, replies, quotes and views per target over time |
| `notification` | In-app notification inbox |
| `change_log`, `client_mutation`, `rejection` | Sync bookkeeping: which rows each of the latest changes touched, the last mutation applied per client, and the rejected mutations that a client has yet to hear of |
| `workspace` | One row: which workspace the object holds, and the sequence number of its last change |

Post status follows Buffer: `draft`, `scheduled`, `sending`, `sent`, `error`. A post whose targets ended differently reports `error` and lists each target's own status.

## 6. The four networks

Each adapter in `packages/providers` implements one interface, `Provider` in `src/provider.ts`, and callers know nothing of a network beyond it. An adapter is made by a function of its own, which takes `fetch` and the clock and whatever is the network's own: the registration of the operator's app for LinkedIn and Threads, the signing key and an identity resolver for Bluesky, a store for its registrations with instances for Mastodon. Adapters never use globals, which is what lets the sandbox and the tests swap in simulators. An adapter keeps nothing between calls: what has to last is handed to the caller as JSON that only the adapter understands, and is checked against the adapter's own schema when it comes back.

| | LinkedIn | Mastodon | Bluesky | Threads |
| --- | --- | --- | --- | --- |
| Developer app | Yes, tied to a LinkedIn Page. Products: Share on LinkedIn, Sign In with OpenID Connect | None. pigy registers itself with each instance on first use | None. pigy hosts its own OAuth client metadata | Yes, a Meta app with the Threads use case |
| Who can connect | Anyone | Anyone | Anyone | Only accounts you add as Threads testers, until Meta approves the app |
| Token life | 60 days, no refresh. The user reconnects | Does not expire | Refreshed automatically | 60 days, refreshed automatically |
| Text limit | 3000 | 500 by default, read from the instance | 300 graphemes | 500 |
| Threads | Parts joined into one post | Reply chain | Reply chain | Reply chain |
| Media | Upload to LinkedIn, then reference | Upload, wait for processing | Upload blob. Video goes through the video service | Meta fetches from a public URL we provide |
| Stats | Not available for personal profiles without LinkedIn's approval | Yes | Yes | Yes |

Notes that shape the design:

- **LinkedIn** needs reserved characters escaped in the post text, a dated version header that must be bumped about once a year, and link previews supplied by us (title and thumbnail), because it does not fetch them for API posts.
- **Bluesky** needs links, mentions and hashtags marked up with UTF-8 byte offsets, and link cards built by us. Connection uses atproto OAuth as a confidential client, with the signing key stored as a Worker secret.
- **Threads** publishes in two steps: create a container, wait for it to be ready, then publish it. Media must be reachable at a public URL, so `/m/*` serves R2 objects through signed, expiring links.
- **Mastodon** limits vary per instance. pigy reads them from the instance and validates against the real values.
- **Link previews**: a shared service fetches a URL's title, description and image once, caches it, and feeds LinkedIn and Bluesky.
- **Token refresh** runs inside the WorkspaceDO, one refresh at a time per channel. Bluesky refresh tokens are single-use, so two parallel refreshes would lock the account out. It runs when the alarm reaches the time the adapter named, whether or not the channel is in use: a Threads channel that nobody posts to for 60 days would otherwise lapse. It also runs at once when an adapter says that the network has refused a token before that time.

### The provider interface

| Part | What it is |
| --- | --- |
| Connecting | `beginConnect` takes pigy's callback address and, on networks with no single place to sign in, what the person typed to say where their account lives. It returns the address to send the browser to, the `state` that the callback will carry, and `pending`: what to keep under that state until then. `completeConnect` takes `pending` and the parameters of the callback and returns the account for display (ID, handle, name, avatar, profile link) and the access |
| Access | The credentials, opaque and stored encrypted, with two times: `refreshAt`, when to call `refresh`, and `expiresAt`, when the access ends unless it is refreshed. Either is null where it does not apply. Only adapters of networks that can renew an access have `refresh`. It is called by a timer when `refreshAt` comes, and at once when a method fails with `refresh`, one refresh at a time per channel. `disconnect` gives the access back where the network has a way |
| Limits | `limits` asks what the account may post. The answer is data that names its network, defined in `packages/core` with the counting that goes with it: `countCharacters` and `validateContent` are pure and run in the browser too. Adapters do not validate. They send what they are given, and the network is the judge |
| Publishing | `publishStep` takes the content, a key that names the delivery, and the progress that the step before returned. It makes at most one request that changes something and returns the new progress: the parts that are published, each with its ID and link, whether the post is done, how long to wait before the next step, and the adapter's own notes. Section 8 has the rules |
| Reading and deleting | `readPost` returns the text and what the post replies to, on networks that let pigy read. `deletePost` is fine with a post that is gone |
| Errors | Every failure is a `ProviderError` with one of four kinds: `retry` (with the time the network named, if any), `refresh` (renew the credentials now, then try again), `fail` (with a message for the person) and `reconnect`. Messages may quote the network, without the secrets of the request |

How the four networks map onto it. Mastodon is built. The other three columns are the design that the interface was checked against, for whoever builds them to check in turn:

| | Mastodon | Bluesky | LinkedIn | Threads |
| --- | --- | --- | --- | --- |
| What the adapter is made with | A store for registrations | Client metadata address, signing key, identity resolver | Client ID and secret, API version | App ID and secret |
| What the person types | The domain of the instance | The handle | Nothing | Nothing |
| `beginConnect` | Reads the instance, registers pigy there if it has not, PKCE where the instance has it | Resolves the handle to its server, pushes the authorization request with PKCE and DPoP | Builds the address | Builds the address |
| `pending` holds | State, domain, the registration, PKCE verifier | State, account and server, PKCE verifier, DPoP key | State | State |
| `completeConnect` | Code for token, then `verify_credentials` | Code for tokens, checks the account is the one that was resolved, reads the profile | Code for token, then `userinfo` | Code for a short-lived token, that for a long-lived one, then the profile |
| Account ID | Account ID and domain | DID | `sub` | User ID |
| `refreshAt` and `refresh` | None | Shortly before the access token ends. Refresh tokens are single-use | None | Some days after issue. Not before a day has passed |
| `expiresAt` | None | None known | 60 days after issue | 60 days after the last refresh |
| `disconnect` | Revokes the token | Revokes the tokens | To decide | Nothing to call |
| `limits` | Read from the instance | Fixed: 300 graphemes | Fixed: 3000 | Fixed: 500 |
| Steps of `publishStep` | One per part: post the status, as a reply to the part before | Two per part: choose the record key, then write the record with the references to the first and the previous part | One for the whole post: the parts joined | Per part: create a container, wait, publish it |
| Adapter's notes between steps | None | The record key in use, and the reference of each part | None | The container in use |
| `readPost` | Yes | Yes | No: reading takes a permission that LinkedIn restricts | Yes |
| What asks for `refresh` | Nothing | An access token that the server refuses | Nothing | A token that Threads refuses as expired |
| What asks for `reconnect` | 401, a missing scope | A refresh that is refused | 401 | An invalid token that cannot be refreshed |

The handle of a LinkedIn account is its name: LinkedIn gives pigy no other. The time of a refresh for Threads, and how Bluesky tells a token that has expired from one that was revoked, are for those adapters to settle.

What was decided along the way, and why:

- **No validation inside adapters.** The browser has to validate while somebody types, and it cannot import the adapters, so the rules live in `packages/core`. Keeping adapters out of it also means that the conformance suite can send what the validation would stop, and see the network refuse it.
- **Credentials carry what revoking them takes.** On Mastodon that is the registration the token was issued to. The stored registration of an instance can then change, or be lost, without breaking a channel.
- **Optional methods for what a network cannot do.** `refresh` and `readPost` are missing from an adapter rather than present and failing, so the type says what a caller can count on.
- **Scopes for media are asked for now.** A registration with a Mastodon instance cannot gain a scope later. Asking for `write:media` in phase 3 spares everybody a second connection in phase 7.
- **`refresh` is a kind of its own.** A token can be refused before the time pigy has for it: the clocks differ, or a refresh for another post replaced it while this step ran. `reconnect` would mark a healthy channel as broken, and `retry` would hand the step the same token until the workflow gave up.

## 7. Sandbox and simulators

### Simulators

`packages/simulators` contains a working imitation of each network's HTTP API, written from the official docs:

- **LinkedIn**: OAuth, user info, posts, image and video upload.
- **Mastodon**: app registration, OAuth, instance info, media, statuses.
- **Bluesky**: OAuth with DPoP, identity resolution, blob upload, record creation, video service, post stats.
- **Threads**: OAuth, token exchange and refresh, containers, publish, insights.
- **Google sign-in** and a **web push service**, used by development and tests only.

Each simulator:

- Validates requests strictly. A missing header, wrong token, bad field or over-limit text is rejected the way the real service rejects it.
- Keeps state: accounts, tokens, uploaded media, published posts and reply chains.
- Supports fault injection: rate limit, expired token, server error, slow media processing, and "succeeded but the response was lost".
- Has a controllable clock.

Adapters keep calling the real hostnames. The injected `fetch` decides whether the request leaves the Worker or is handled in-process by a simulator. The adapter code that runs in tests is the code that runs in production.

What the simulators of the networks share is written once, in `packages/simulators/src/world`:

- **The world**: the accounts, tokens and posts of all networks in one form, behind a storage of keys and values that is read and written at once. It has the shape of the storage of a Durable Object with SQLite, so the `SimWorldDO` passes its own. A simulator keeps nothing outside the world and is made anew for every request. `feed` lists what is published, for the simulated feeds page.
- **The clock**: the one the world is made with, plus what `advance` has added, which is kept in the world.
- **Faults**: armed ahead of time, for a network and optionally for one kind of request, and struck by the next request they apply to. The kinds are `rate-limit`, `server-error`, `lost-response` and `token-revoked`: what Mastodon can suffer from. A token that expires and processing that takes long are added with the first network that has them, together with the simulator that applies them and its tests.
- **The consent page**: where a person chooses which simulated account to connect, marked as a simulation. `answerConsent` answers it without a browser.

A simulator is written from the network's documentation and shares no code with the adapter or with the validation in `packages/core`: a simulator that is more lenient than the service hides the mistakes it is there to find. Where the documentation is silent and something had to be assumed, the code says GUESS, for a live run to confirm.

The simulators of the networks are part of the production build, because the sandbox runs on them. So they are built to act on a simulated world and on nothing else:

- A simulator makes no requests, and fails for every host that is not its own.
- A simulated Mastodon instance has a domain under `.example`, `.test` or `.invalid`. Such a name cannot exist on the internet, so a simulated instance is never taken for a real one, and a request that was meant for it and left the Worker by mistake reaches nobody. The other three networks have fixed hosts, where this cannot be done.
- Every secret of a simulated network begins with `pigy-sim-`, and a world finds no token that it did not issue. A real credential that reaches a simulator is refused before it is compared with anything.
- Which `fetch` an adapter gets is decided by the environment of the workspace, live or sandbox, and by nothing in a request.

The sandbox gives the Mastodon adapter a store for registrations of its own, per world: the same simulated instance exists in every user's world, each with its own registered clients.

The Google simulator is the first one, built in phase 1, and differs from the others in two ways:

- It is not part of the production build, because it signs anybody in as anybody. The Worker's entry point builds it in only for development, tests and the build that the end-to-end tests run against. The production build is checked for it, and it answers only requests that name a local host such as `localhost`. That is a property of the request, not of where it comes from, so a build that contains it must not be exposed to a network.
- It keeps almost no state. Sign-in happens before there is a user whose `SimWorldDO` could hold any, so its authorization codes carry what is needed to redeem them, signed. Only which codes were redeemed is remembered, in memory.

Its consent page is served by the Worker under `/sim/google/*`. Without Google credentials, development and the end-to-end build use it and make `admin@example.com` the admin, so that a fresh clone needs no setup.

### Sandbox in the app

- A **Live / Sandbox** switch in the header. The sandbox has a visible banner.
- New users start in the sandbox with simulated accounts already connected and a few sample drafts.
- Connecting a simulated account goes through a simulated consent screen under `/sim/*`, clearly labelled as fake.
- A **simulated feeds** page shows what was published to each network, including thread chains and media.
- A **failure panel** lets the user make the next publish fail, to see error handling, retries and notifications.
- Sandbox API keys (`pigy_test_…`) hit the sandbox, so scripts can be developed without posting for real.
- Simulated Google sign-in is compiled out of production. Real sign-in is always required, including for the sandbox.

Simulator state lives in a `SimWorldDO` per user, so one person's simulated posts are never visible to another.

## 8. Publishing pipeline

1. A post becomes due: the user chose "now", or the WorkspaceDO alarm fired.
2. The WorkspaceDO marks the post `sending` and starts one `PublishWorkflow` per target, with an ID derived from the target so that a second start is a no-op.
3. The workflow runs one durable step per remote call: upload each media item, publish part 1, publish part 2 as a reply, and so on. Each result is written back to the WorkspaceDO as it happens, so the UI shows progress live.
4. Transient failures (rate limit, server error, timeout) retry with backoff. Permanent failures (invalid content, revoked access) stop, mark the target `error` with a readable reason, and send a notification.
5. If a thread fails midway, the sent parts stay recorded. "Retry" continues from the failed part and never re-posts a sent one.

How the workflow and an adapter share the work:

- The content is checked with `validateContent` before the first step. What fails is not sent.
- A step of the workflow is one call of `publishStep`. It returns the progress as plain JSON, which is the recorded result of the step and the input of the next. `publish` in `packages/providers` is the loop: it takes the workflow's `step.do` and `step.sleep` and names the steps by their position, the same on a replay.
- The credentials are asked of the WorkspaceDO inside every step, also when a step is run again. A post can take longer than credentials last, and the WorkspaceDO replaces them: by its alarm when `refreshAt` comes, and at once when a step fails with `refresh`.
- A `ProviderError` says what the workflow does:
  - `retry` runs the step again with the same input, after the time the network named if it named one.
  - `refresh` has the WorkspaceDO renew the credentials at once, whatever `refreshAt` says, and runs the step again with the new ones. `publish` does this inside the same workflow step. If the stored credentials are no longer the ones that were refused, another refresh has replaced them, and they are used as they are. A refresh that the network refuses, or new credentials that are refused too, mean `reconnect`.
  - `fail` ends the target with the message.
  - `reconnect` ends it and marks the channel.
- A step may ask for a wait before the next one, which is how Threads gets the time to prepare a post, and how media will get the time to be processed.
- The progress lists the published parts one by one. "Retry" starts a new run from the progress that was recorded, with the same key.
- The key names the delivery: the ID of the target. It is what Mastodon's idempotency keys are made from, so publishing a post a second time on purpose takes a new key.

Avoiding duplicates when a retry follows an uncertain result:

| Network | Mechanism |
| --- | --- |
| Mastodon | `Idempotency-Key` header derived from target and part. Mastodon remembers a key for an hour |
| Bluesky | The record key is generated and stored before the call, so a retry writes the same record |
| Threads | The container ID is stored before publishing, and a container publishes only once |
| LinkedIn | No idempotency key. Rely on LinkedIn's duplicate-content rejection and treat it as success (to verify) |

## 9. Scheduling and queue

- **Exact time**: the WorkspaceDO keeps one alarm set to the earliest due item. No polling.
- **Queue**: weekly slots (weekday and time) in the user's timezone. "Add to queue" takes the next free slot, "share next" takes the first slot and shifts the rest. Posts can be reordered, and the queue can be paused.
- **Views**: a queue list and a calendar, both reading local data.
- The same alarm also drives token refresh, reconnect reminders and stats refresh.

## 10. Media

- **Upload**: the browser uploads in chunks through the Worker into an R2 multipart upload. Uploads are resumable, which matters on phones.
- **Images**: up to 4 per part, alt text per image. When a network's size limit is smaller than the original, the Cloudflare Images binding produces a smaller variant at publish time.
- **Video**: one per part. Workers cannot transcode, so the client reads the file's format, size and duration and blocks a video that a selected network would reject, naming the network and the reason.
- **Limits** for every network live in one module in `packages/core`, `src/network/limits.ts`, filled from each network's docs when the phase starts. Mastodon's come from the instance. The limits for text are there since phase 3, with the counting. Those for media join them in phase 7.
- **API uploads**: `POST /api/v1/media`, or a public URL in `assets` as in Buffer. Fetched URLs are size-capped and type-checked.
- **Retention**: originals are deleted from R2 a set number of days after every target has been sent. A thumbnail is kept.

## 11. Sign-in and access

- Sign-in with Google is the OpenID Connect authorization code flow with PKCE, state and nonce, done with `oauth4webapi`, which also validates the ID token. State, nonce and the PKCE verifier live in a cookie for the ten minutes a sign-in may take, not in the database. Section 1 says why this is not Better Auth.
- The Google account ID is the identity of a user. The email address is what the allowlist is matched against, trimmed and lowercased, and only if Google has verified it. Only ASCII addresses are accepted, from an admin, from `ADMIN_EMAILS` and from Google, and that is checked before the address is lowercased: lowercasing turns some other characters into ASCII letters, which would let one address pass for another.
- Sessions are our own, on D1 through Drizzle, after the guides at https://lucia-auth.com and https://auth.pilcrowonpaper.com/sessions. The cookie holds a random token, the database a SHA-256 of its secret half, and a session ends when its row is deleted. Sessions last 30 days and renew on use, at most once a day, so the installed PWA stays signed in. The cookie is `HttpOnly`, `SameSite=Lax` and, over HTTPS, `Secure` with the `__Host-` prefix.
- Sign-in is refused unless the email is in `allowed_email` or in the `ADMIN_EMAILS` variable. The check runs for every new session and again on every request, so a change of role applies to the next request. Removing an email also deletes that user's sessions. So does a sign-in that is refused: when Google reports an address for a known account that is not invited or not verified, the sessions that account has on any device end, because they would go on working with the address it had before. The stored address is left as it was, since nothing is stored about an address that is not invited. A sign-in that succeeds also ends the sessions of any other account stored with the same address: Google has just said that the address belongs to the account signing in, so the account that had it before has lost it.
- The first admin comes from `ADMIN_EMAILS`. The addresses in it are always admins and cannot be changed from the settings page, where admins manage the rest of the allowlist. Nobody can change their own entry. An entry that is not an email address is ignored and logged.
- A person who is not invited sees a plain "pigy is invite-only" page. Nothing is stored about them.
- A request that changes something and is authenticated by the cookie must carry the app's own `Origin`. So must the handshake of the sync WebSocket, which is a GET: a browser sends the cookie with a handshake that any site starts.
- The session is checked when a sync socket is opened, not while it is open. A socket therefore lasts five minutes, after which the client has to open a new one. That bounds how long a session that has ended, by sign-out or by removal from the allowlist, can go on using a socket. Telling every workspace about every session that ends would close them sooner, but sessions end in many places, and one that was missed would leave a socket open for good.
- The address Google redirects back to is built from the address the app is reached at, so it works unchanged on `localhost`, on `workers.dev` and on a custom domain. Each has to be registered with the Google client.
- Without Google credentials nobody can sign in: the production build has no other way in. Section 7 covers the simulated Google of development and tests.

## 12. Public API

REST under `/api/v1`, described by an OpenAPI document generated from the same Zod schemas the app uses, with a docs page.

| Endpoint | Buffer equivalent |
| --- | --- |
| `GET /account` | `account` |
| `GET /channels`, `GET /channels/{id}` | `channels`, `channel` |
| `GET /posts`, `GET /posts/{id}` | `posts`, `post` |
| `POST /posts` | `createPost` |
| `PATCH /posts/{id}` | `editPost` |
| `DELETE /posts/{id}` | `deletePost` |
| `POST /posts/{id}/move` | `movePostInQueue` |
| `GET /posting-schedule`, `PUT /posting-schedule` | `Channel.postingSchedule` |
| `POST /media` | None. Buffer accepts URLs only |

- **Copied from Buffer**: camelCase fields (`text`, `assets`, `dueAt`, `saveToDraft`, `metadata`), `mode` values (`addToQueue`, `shareNext`, `shareNow`, `customScheduled`), status values, the `assets` shape with `altText`, per-service `metadata` including `thread`, cursor pagination with `pageInfo`, and error names (`InvalidInputError`, `NotFoundError`, `UnauthorizedError`, `LimitReachedError`, `UnexpectedError`).
- **Different from Buffer**: `channelIds` is a list, because a pigy post is cross-network, and the response carries `targets[]` with per-channel status, link, error and metrics. `schedulingType` is dropped, since pigy always publishes automatically.
- **Errors**: every error response is `{ "error": name, "message": text }`. The name follows from the status: `UnauthorizedError` for 401 and 403, `NotFoundError` for 404, `LimitReachedError` for 429, `InvalidInputError` for every other 4xx, `UnexpectedError` for 5xx. The app's own routes outside `/api/v1` answer the same way.
- **Keys**: created in settings, shown once, stored hashed. Prefix `pigy_live_` or `pigy_test_`. Scopes: `posts:read`, `posts:write`, `channels:read`, `media:write`. Sent as `Authorization: Bearer`.
- **Safety**: `Idempotency-Key` header on writes, and per-key rate limits using the Workers rate limiting binding.

## 13. PWA, notifications and share target

- **Install**: manifest, icons and a service worker that caches the app shell. With local data, the app opens and is usable offline.
- **Push**: Web Push from the Worker using VAPID keys. Sent when a post fails, when a channel needs reconnecting, and a week before a LinkedIn token expires. On iPhone, push works only once pigy is installed to the home screen, so the same events also appear in the in-app inbox.
- **Share target**: pigy registers as a share target for text and links, and opens the composer prefilled. Android only. Sharing image and video files into pigy is a stretch goal for the same phase.

## 14. Engagement stats

- Fetched per target for Mastodon, Bluesky and Threads: likes, reposts, replies, plus quotes and views where the network reports them.
- Refresh slows down as a post ages, for example at 1 hour, 6 hours, 1 day, 3 days, 7 days and 30 days.
- LinkedIn stats show as unavailable.

## 15. Testing and CI

| Layer | Tool | What it proves |
| --- | --- | --- |
| Unit | Vitest | Grapheme counting, link and mention detection, LinkedIn escaping, thread splitting, queue slot maths, validation rules |
| Adapter conformance | Vitest in Node | One spec for all networks, run once per network: connect, validate, publish text, images, video and threads, read back, delete, refresh tokens, map every error class, publish nothing twice. Runs against the simulator |
| Pipeline | Vitest in the Workers runtime with local D1, Durable Objects, R2 and Workflows | API call to alarm to workflow to simulator. Asserts final statuses, sync messages and the push notification. Injects faults, including the lost-response case, and asserts no duplicate post |
| Sync | Vitest in the Workers runtime | Two clients converge, the offline outbox replays once, snapshot fallback works, one user cannot reach another's workspace, credentials never appear in sync messages |
| End to end | Playwright against the local Worker, built as for production except that sign-in is simulated | Simulated Google sign-in, allowlist refusal, sandbox onboarding, connecting four simulated accounts, cross-post with override, thread and image, schedule and fast-forward, offline draft then sync, installability checks, phone viewports |

**No real network in CI.** In test runs, any outbound request to a host that is not simulated throws, so a test that reaches for a real service fails.

**Keeping the simulators honest.** The adapter conformance spec can also run against the real services with dedicated test accounts. That run is manual or nightly, never part of pull request CI, and it deletes what it posts. If the real service and the simulator disagree, the simulator is fixed.

The run is started by `pnpm --filter @pigy/providers conformance:live <network>`, with the credentials of the test account in the environment. The script is the only way to start it, and refuses in CI. It posts with the least visibility the network has: on Mastodon, posts that only the account itself sees. In CI the same specification also runs against the simulator with the harness of the live run, which has one account and no way to look into the network, so that the live run does not break unnoticed between the times somebody starts it.

The conformance suite runs in Node, like the other tests of the packages, and not in the Workers runtime as an earlier draft of this plan had it. The adapters use nothing but web-standard APIs, the live run needs Node to reach the network, and the pipeline tests run the same adapters in the Workers runtime.

**CI (GitHub Actions)**: lint, typecheck, unit and Workers-runtime tests, Playwright with traces on failure, build. From phase 11, merges to `main` also apply D1 migrations and deploy.

## 16. Security

- Channel tokens are encrypted at rest with a key held as a Worker secret, with a key version for rotation.
- OAuth uses state and PKCE everywhere. Cookie-authenticated writes and the WebSocket handshake check the origin.
- A workspace is reached only through the Worker, which looks it up by its ID and the signed-in user together. The Durable Object never sees the request of the client: the Worker makes a new one. The object also remembers which workspace and owner it was first used for and refuses any other, so a mistake in the Worker's routing cannot hand one person's data to another.
- Mastodon instance domains and asset URLs come from users, so they are validated, HTTPS only, and size-capped. An adapter follows no redirects, gives up on a host that does not answer, and reads a bounded amount of every answer. What a network says in an error may reach a message, a log or the screen only without the secrets of the request.
- The addresses of avatars and profiles come from the networks. Only HTTPS addresses are passed on.
- The simulated networks are part of the production build. Section 7 says what keeps them to their simulated world.
- Media links for Threads are signed and expire.
- Signing out wipes the local IndexedDB copy.
- A content security policy, and an audit trail of publishes per workspace.

## 17. Phases

Each phase ends with something that works and is covered by tests. Sizes are relative: S, M, L.

| # | Phase | Size | Done when |
| --- | --- | --- | --- |
| 0 | Foundations | S | Monorepo, a hello-world Worker with the React shell running in the local Workers runtime, CI green on lint, typecheck, tests, build and a Playwright smoke test |
| 1 | Sign-in and invite-only access | M | Google sign-in works, a non-invited email is refused, admins manage the allowlist, simulated Google sign-in drives the tests |
| 2 | Local-first core | L | Sync spike passed. Drafts can be created and edited offline, sync across tabs and devices, and the app installs as a PWA |
| 3 | Networks, simulators, sandbox | L | All four simulators and adapters exist. A text post publishes now to all four, in the sandbox and for real. Conformance and pipeline tests pass |
| 4 | Per-network text and threads | M | Live character counters, per-network overrides, thread editor, link cards, mentions and hashtags |
| 5 | Scheduling and queue | M | Exact-time scheduling, weekly slots, add to queue, reorder, pause, queue and calendar views |
| 6 | API keys and REST API | M | Keys can be created and revoked, the API passes its tests in both environments, OpenAPI docs are served |
| 7 | Images | M | Upload, alt text, per-network variants, published to all four |
| 8 | Video | L | Chunked upload, client-side checks, each network's upload and processing flow |
| 9 | Phone features | M | Push notifications, in-app inbox, share target, install prompts |
| 10 | Engagement stats | S | Stats collected and shown on sent posts |
| 11 | Hardening and launch | M | Deployment from CI, security review, reconnect flows, logging and alerts, backups checked, setup guide, friends invited |

Phase 2 is built in two steps. 2a is the server side: workspaces, the `WorkspaceDO`, the mutators, and the sync protocol with its tests. 2b is the client: the browser store, IndexedDB, the offline outbox, the drafts screen and the PWA shell.

Phase 3 is built in steps too. 3a is in the packages only: the provider interface, what the simulators share, and Mastodon as the first network, with its adapter, its simulator and the conformance suite. The steps after it put that to use in the Worker: the channels with their encrypted credentials, the routes that connect an account, the publishing workflow, the simulated world of each sandbox user, the Live/Sandbox switch, the simulated feeds and the failure panel. Then Bluesky, LinkedIn and Threads follow, each the way Mastodon was built.

Until deployment is set up in phase 11, every phase is built and verified locally against the simulated networks. Connecting real networks and installing on a phone need the deployed address.

Usable milestones:

- After phase 3: cross-posting text from your phone.
- After phase 6: a scheduler with an API.
- After phase 8: full media.
- After phase 11: everything in this plan.

Each network in phase 3 is built in the same order: conformance spec, simulator, adapter passing against the simulator, then one live run to confirm that both match reality. Order: Mastodon, Bluesky, LinkedIn, Threads.

## 18. What you need to set up

| What | Notes |
| --- | --- |
| Cloudflare account | Workers, D1, R2, Durable Objects, Workflows. R2 needs a payment method on file. Budget for the Workers Paid plan |
| Address | `https://pigy.<your-subdomain>.workers.dev`, free and with HTTPS. The subdomain is set once per Cloudflare account, under Workers in the dashboard. The address is a single setting, `APP_URL` |
| Google Cloud OAuth client | Set the consent screen to "In production". In "Testing", only listed test users can sign in. Basic scopes need no review. The redirect address is `<address>/api/auth/google/callback`. Client ID and secret become the Worker secrets `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` |
| First admin | Your Google email address, as the Worker secret `ADMIN_EMAILS` |
| LinkedIn developer app | Must be linked to a LinkedIn Page. A placeholder page is enough |
| Meta developer app | Threads use case. Add each friend as a Threads tester. They accept the invite in their Threads settings |
| Test accounts | One per network for the live conformance run |

Mastodon and Bluesky need no developer registration. VAPID keys, the Bluesky signing key and the token encryption key are generated during setup and stored as Worker secrets.

## 19. Risks and things to verify

| Risk | Mitigation |
| --- | --- |
| TanStack DB with a custom sync protocol is newer ground than the rest of the stack | Spike at the start of phase 2b. The protocol does not depend on the library, so the fallback is a small client store of our own |
| atproto OAuth libraries are written for Node and may not run on Workers | Spike at the start of the Bluesky work. Candidates: `@atcute/oauth-node-client`, then `@bskyprism/atproto-oauth-client-cloudflare-workers`. Last resort: Bluesky app passwords |
| Threads is limited to testers | Fine for friends. Opening it up needs Meta's app review |
| LinkedIn tokens die after 60 days | Reminder a week before, one-tap reconnect |
| No LinkedIn stats | Shown as unavailable. Revisit together with company pages, which need the same approval |
| Video rejected by one network after upload | Client-side checks against the limits of the selected networks before upload |
| Simulators drift from the real APIs | Live conformance run, nightly or before releases |
| The first version is large | Phases are ordered so pigy is useful after phase 3 |

To confirm when the relevant phase starts:

- Whether Threads reply chains need the `threads_manage_replies` permission.
- Whether Bluesky video upload works with the OAuth scopes pigy requests.
- LinkedIn's behaviour on duplicate content, and the current API version string.
- Current media size and duration limits per network.
- Workflows support in the Workers Vitest pool, which has had isolation caveats. WebSockets to Durable Objects were confirmed in phase 2a: they work, hibernation included.
- Whether usage fits the Cloudflare free plan.

Open since phase 3a, all of it about Mastodon and none of it confirmed against a real server, because the live conformance run has not been made yet. The first run settles most of it. Where the simulator had to assume an answer, the place in `packages/simulators/src/mastodon` is marked GUESS, and every such mark is in this list. The rest of the list is about the adapter and the run itself:

- That the live run works at all: it is written and has never been started.
- That a status with the visibility `direct` and no mention is accepted and seen by its author alone, which the live run relies on.
- What counts as a link. pigy and the simulator take any top-level domain of two or more ASCII letters, Mastodon only the ones that exist. Mastodon's development branch has also replaced the pattern that 4.5 uses. A text that pigy counts as shorter than Mastodon does is refused by Mastodon, with a message that says so.
- That grapheme clusters are counted alike by the browser, the Workers runtime and Mastodon's Ruby. They follow the same standard in versions that differ, which matters for the newest emoji only.
- How Mastodon answers a token request of a client without a scope when the client has not registered `read`, and whether servers that speak Mastodon's API without being Mastodon (GoToSocial, Pleroma, Akkoma) answer the check of a registration in a way the adapter understands. The adapter asks for a scope by name and takes any refusal other than `invalid_client` to mean that the registration is still known.
- That a wrong authorization request ends on a page of the instance and not in a redirect, and that an authorization code lasts ten minutes.
- That a revocation without a token is refused, and that revoking a token which the instance does not know is not an error.
- That a repeated idempotency key for a status that was deleted since is answered with 404.
- What Mastodon answers for an address it does not have. The simulator answers 404, with JSON under `/api/` and with a page elsewhere.
- Mastodon gives out the same token again for the same client, account and scopes. If one Mastodon account is connected to two workspaces, disconnecting one revokes the token of the other, which then has to be connected again. To decide in phase 3b: accept it, or revoke only when no other channel uses the token.
- The limits that Mastodon keeps per IP address are not simulated. Registrations are limited to 5 in 10 minutes per address, and Cloudflare Workers share theirs with others. The adapter reports it as a failure to try again later.

## 20. Moving to a custom domain later

pigy starts on `https://pigy.<your-subdomain>.workers.dev`. Switching to a custom domain later means changing `APP_URL` and then:

- Updating the redirect addresses in the Google, LinkedIn and Meta apps.
- Reconnecting Bluesky channels, because the Bluesky client ID is the app's address. LinkedIn, Mastodon and Threads channels keep working.
- Reinstalling the PWA and re-enabling push on each phone, because both belong to the address.
- Pointing API clients at the new base URL. Keys stay valid.

Posts, drafts, schedules and stats are unaffected.

## 21. Possible later additions

- A public "try the demo" link with a temporary anonymous sandbox.
- A posting schedule per account, as in Buffer.
- LinkedIn company pages and LinkedIn stats, which need the same LinkedIn approval.

## References

- Buffer API: https://developers.buffer.com/reference.md and https://developers.buffer.com/guides/posts-and-scheduling.md
- Typefully API: https://typefully.com/docs/api
- Threads long-lived tokens: https://developers.facebook.com/docs/threads/get-started/long-lived-tokens
- Threads app setup and testers: https://developers.facebook.com/docs/development/create-an-app/threads-use-case
- atproto OAuth: https://atproto.com/guides/oauth and https://docs.bsky.app/docs/advanced-guides/oauth-client
- Bluesky video: https://docs.bsky.app/docs/tutorials/video
- LinkedIn access tiers: https://learn.microsoft.com/en-us/linkedin/marketing/increasing-access
- Google OpenID Connect: https://developers.google.com/identity/openid-connect/openid-connect
- oauth4webapi: https://github.com/panva/oauth4webapi
- Sessions: https://lucia-auth.com and https://auth.pilcrowonpaper.com/sessions
- TanStack DB: https://tanstack.com/db/latest/docs/overview and https://tanstack.com/db/latest/docs/guides/offline-transactions
- Durable Object sync with TanStack DB, as a reference design: https://github.com/grrowl/tanstack-durable-object-sync
- Cloudflare limits: https://developers.cloudflare.com/workers/platform/limits and https://developers.cloudflare.com/durable-objects/platform/limits
- Workers Vitest integration: https://developers.cloudflare.com/workers/testing/vitest-integration/test-apis and https://developers.cloudflare.com/workers/testing/vitest-integration/known-issues/
