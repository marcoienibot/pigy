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
| Frontend | React, Vite, TanStack Router, Tailwind, shadcn/ui, and a small client store of our own for the synced data | The speed comes from reading local data, not from the framework. Section 4 says why the store is not a library |
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
│ Sync store (rows in memory)  │◄────────►│  /api/auth/*   sign-in with Google      │
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

A sandbox workspace has a second Durable Object next to its `WorkspaceDO`, the `SimWorldDO`: the simulated networks as that workspace sees them. Section 7 has it.

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
- **Client state**: every row of the workspace is held in memory by the sync store and stored in IndexedDB, one database per user and workspace. A cold start renders from IndexedDB before any request finishes: the device remembers who was signed in on it, and the server is asked in the background whether that still holds (section 11).
- **Writes**: named mutators such as `post.create`, `part.setText` and `post.schedule` live in `packages/core`. They are synchronous functions over a small transaction interface: read a row, find rows by a column, write a row, delete a row, the time. The client runs them optimistically. The Durable Object runs the same code as the authority. The REST API calls the same mutators, so an API write shows up in open tabs immediately.
- **Idempotency**: IDs are generated on the client (UUIDv7). Each client numbers its mutations, and the Durable Object remembers the last number applied per client, so a replay is a no-op and a gap is refused.
- **Transport**: one WebSocket per device and workspace, to `/sync/<workspace ID>`, using Durable Object hibernation so idle connections cost nothing. A device syncs the workspace that it shows, live or sandbox, and the other one only once it has been shown, or while its copy holds changes that were not sent: section 7. The tabs of a browser share one copy of a workspace in IndexedDB. The tab that holds a Web Lock holds the socket, and when it is closed the next tab takes over. Every tab writes its own mutations to the shared copy and tells the others over a BroadcastChannel what it wrote. The Durable Object holds a client to one socket: a second socket of the same client closes the first.
- **Catch-up**: every committed write gets an increasing sequence number and an entry in a change log, which names the rows that changed. A reconnecting client sends its last sequence number and receives the current state of the rows that changed since. The log covers the last 1,000 changes: a client that is further behind gets a fresh snapshot.
- **Confirmation**: the message that carries the changes of a client's mutation also says that the mutation was processed, so the client can replace its own version of the change with the server's in one step.
- **Offline**: mutations queue in an IndexedDB outbox and are sent in order on reconnect. Mutations that only repeat one another, such as the text of a part on every keystroke, become one while they wait. A rejected mutation rolls back, and a notice says what was refused and why. The notice is not on the post, as an earlier draft of this plan had it: the post is often gone, which is why the mutation was refused. The Durable Object keeps the reason until the client has seen it, so the notice is shown also when the answer that carried it was lost, and the client keeps it until the person has dismissed it.
- **Conflicts**: the server applies mutations in arrival order, last write wins per field. State guards reject impossible edits, such as changing a post that is already sending.
- **Secrets**: channel credentials are never synced. Each table has an explicit list of synced columns, and a test fails if a credential field appears in any sync message.
- **Mutators of the server's own**: a row that stands for something only the server has is changed by mutators that a client may not send. A channel is one: it is made and removed together with its credentials, over HTTP. What a delivery has done is another: a client asks for a post to be published, and the server says how far each target has come. Clients receive what such a mutator did like any other change.
- **Time**: the `WorkspaceDO` runs every mutation at a later time than the one before it, also the mutations of one message and across restarts, so that the times in the rows say in which order they were changed.
- **Versions**: the protocol and the synced schema each have a version number. A client that says hello with another version is told so, and updates itself.

**The client store.** The store is our own code, not a library. `packages/core/src/sync/client` holds everything that needs no browser, and `apps/web/src/sync` what does: IndexedDB, the BroadcastChannel, the Web Lock, the WebSocket and the React hooks.

- **The view** is computed, never stored: the rows of the server with the unconfirmed mutations run on top, by the mutators that the server runs. A patch changes the rows of the server, and the next view has the unconfirmed mutations on the new rows. A mutation that the new rows no longer allow drops out of the view, the way the server will reject it. Each mutation is run at the time it was made by the clock of the device, or one millisecond after the latest time in the rows of the server and the time of the mutation before it, whichever is later: the server will run it after all of those, so a list that is sorted by time keeps its order when the confirmation arrives, also on a device whose clock is behind. A workspace has hundreds to a few thousand rows, so computing the view again on every change costs nothing that anybody notices.
- **Every change of the stored copy is one transaction** of IndexedDB, described by a pure function from what is stored to what to write: applying a patch, adding a mutation and giving it its ID, marking mutations as sent, starting over. The same description of the write goes to the other tabs, which apply it to what they hold in memory. A tab that finds it has missed one reads the copy again. If it finds out by storing a mutation of its own and the read then fails, the mutation is stored all the same: the tab goes on showing it and reads again later, and never stores it a second time, which would make it another mutation under another ID. The messages only make the tabs find out sooner: a tab can be closed after it has stored a mutation and before its message has left, so the tab with the socket also looks at the stored copy with every ping and whenever the browser says that the network or the tab has changed.
- **What is decided in the transaction.** A write waits its turn behind other work on the storage, and the copy can change in that time. So whether a write is still wanted is decided inside its transaction, on what is stored then. A patch is not written for a socket that the tab has given up, or for a copy that has started over under another client ID. And nothing that came from the server is written to a copy whose schema is newer than the tab: a tab that was open before another one loaded the next version of the app says "Reload to update" and gives the socket up. What the person does in such a tab is still stored. Its mutations are of the old schema, like those that the copy held when it was brought to the new one, and section 6 of SYNC.md says what becomes of them. Refusing them would lose typing to the reload that the tab asks for. So one outbox can hold mutations of two schemas, and each mutation in it says which schema it was made under: a mutation takes the place of the one before it only if both are of the same one. A name and its arguments can mean something else in another schema, and the server may reject one where it takes the other.
- **A mutation that cannot be stored**, on a device that is out of space, for example, stays in the memory of its tab and on screen. It is not sent, because the tab with the socket sends what is stored. The app does not call it saved: the indicator says that it is not, which is another matter than the connection, and signing out counts it among the changes that would be lost, in whichever tab it is. Closing the tab would lose it too, and so would loading it again or leaving it for the consent page of a network: while a tab holds such a mutation, of either workspace, the browser asks before the page goes. Signing out in one tab makes the others start again, so a tab tells the others how many such mutations it holds. That goes to every tab of the person, whichever of the two workspaces it shows, and to the other workspace that the same tab has open, over a channel of its own: the channel on which the tabs tell each other of their writes is that of one copy, and reaches only the tabs that have that copy open. Before the count is used, the tabs that are in it are asked again, for at most two seconds. A tab says that it holds none when it has stored them, and when it is closed or leaves the app. One that does not answer keeps the count it gave last: a browser freezes tabs in the background, and a frozen tab still holds what it could not store. A tab that died without saying so is therefore counted until the other tabs are loaded again, which costs a question and no change. The store tries again every few seconds and with every new mutation. Mutations that only repeat one another become one in the memory of the tab as they do in the outbox, by the same rule: what is typed into a draft is one change that is not saved, however many keys it took.
- **React** reads the store through `useSyncExternalStore`: `useSynced(select)` for rows, `useMutate()` to change them. No screen has a loading state for synced data.

Alternatives considered:

| Option | Verdict |
| --- | --- |
| TanStack DB, with its offline transactions | Tried in a spike at the start of phase 2b, and not used. See below |
| Zero | Needs Postgres and its own server process, so it cannot run on Workers alone |
| LiveStore | Event-sourced. The scheduler and REST API would have to take part in the event log, which is a larger change of model than this app needs |
| Replicache | Fits well, but is in maintenance mode, and it brings a protocol of its own, which the server does not speak |

**Why not TanStack DB.** An earlier draft of this plan named it as the client store, with our own store as the fallback if a spike showed that it did not fit. The spike ran `@tanstack/db` 1.0.0-rc.1.5 and `@tanstack/offline-transactions` 1.2.1 against the model of SYNC.md, and they do not fit it:

- A pending change is kept as a snapshot of the whole row, laid over whatever the server sends. In the spike, a post with a pending edit went on showing as a draft after the server had changed its status, and went on showing at all after the server had deleted it. Our protocol needs the pending mutator to run again on the new rows, where it would have refused. Getting that from the library means computing the view ourselves and feeding it in as if it came from the server, which leaves the library as a container for rows.
- Its outbox holds row changes with idempotency keys, in a storage of its own. SYNC.md needs named mutations with consecutive IDs, dropped in the same transaction that stores the rows of the patch that confirms them. Two storages cannot do that, and the outbox would be a second source of truth for what is pending.
- Only the tab that leads has the durable outbox. The other tabs run without it, so a mutation made offline in a second tab does not survive a reload.
- Its persistence for rows in the browser is SQLite compiled to WebAssembly, over OPFS, per collection: more to load than this store is long, and the cursor would still be stored somewhere else.

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
| `mastodon_app` | OAuth client per Mastodon instance: one for all users of the live environment, and one for each simulated instance of every sandbox, whose world is its own. Sealed, see section 16. A cache: the adapter replaces an entry that the instance no longer knows, and one that no longer opens |
| `oauth_state` | What an adapter needs to finish a connection that has begun, kept under the `state` of the callback for ten minutes, with the session that began it and the workspace it is for. It holds secrets, a PKCE verifier and for Mastodon the client secret, so it is sealed too |

**WorkspaceDO SQLite (per workspace)**

| Table | Purpose |
| --- | --- |
| `channel` | Network, account ID, handle, name, avatar, profile link, status, when it was connected, when to refresh the access and when it ends, sealed credentials, and the limits of the account with the time at which its network was asked for them |
| `post` | Status, mode, due time, source (UI or API), tags, timestamps |
| `post_part` | Ordered text of each part |
| `part_media` | Media attached to a part, with alt text |
| `post_target` | Post and channel, status, how often the delivery was begun, error, when it was asked for and when it was sent. Not synced: the progress that the next attempt goes on from, the attempt that has a workflow, and the time of the workspace at which the delivery that is under way began, which is part of the ID of its workflow. The override of the parts joins them in phase 4 |
| `target_part_result` | Remote ID and URL of each published part |
| `media` | Kind, type, size, dimensions, duration, R2 key, processing status |
| `schedule_slot`, `settings` | Weekly queue slots, timezone, queue paused flag |
| `metric` | Likes, reposts, replies, quotes and views per target over time |
| `notification` | In-app notification inbox |
| `change_log`, `client_mutation`, `rejection` | Sync bookkeeping: which rows each of the latest changes touched, the last mutation applied per client, and the rejected mutations that a client has yet to hear of |
| `keyed_call` | The calls of the Worker that came with a key, and how each ended, so that a call which is repeated is not carried out again |
| `workspace` | One row: which workspace the object holds, the sequence number of its last change, and the time of its last mutation |

Post status follows Buffer: `draft`, `scheduled`, `sending`, `sent`, `error`. A post is `sending` from the moment its publication is asked for until the last of its targets has ended, and then `sent` if all of them are. A post whose targets ended differently reports `error` and lists each target's own status.

A target has more to say than a post: `pending` while it is only chosen, `queued` while it waits its turn on its channel, `sending`, `sent`, `error`, and `uncertain` for a delivery that ended without anybody knowing how far it got, which a person has to look into. `scheduled` is a status of the post alone: until phase 5 nothing sets it, and the targets of a scheduled post will be `pending` until it is due.

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
- **Threads** publishes in two steps: create a container, wait for it to be ready, then publish it. A container that is not published within 24 hours expires. Media must be reachable at a public URL, so `/m/*` serves R2 objects through signed, expiring links.
- **Mastodon** limits vary per instance. pigy reads them from the instance and validates against the real values.
- **Link previews**: a shared service fetches a URL's title, description and image once, caches it, and feeds LinkedIn and Bluesky.
- **Token refresh** is one refresh at a time per channel. Bluesky refresh tokens are single-use, so two parallel refreshes would lock the account out. It runs at once when an adapter says that the network has refused a token before its time: that is built, in the step of the publishing workflow that was refused, section 8. It also has to run when the time comes that the adapter named, whether or not the channel is in use: a Threads channel that nobody posts to for 60 days would otherwise lapse. That is not built: no network so far names a time. It belongs to the alarm of the WorkspaceDO, and to the first network that needs it.

### The provider interface

| Part | What it is |
| --- | --- |
| Connecting | `beginConnect` takes pigy's callback address and, on networks with no single place to sign in, what the person typed to say where their account lives. It returns the address to send the browser to, the `state` that the callback will carry, and `pending`: what to keep under that state until then. `completeConnect` takes `pending` and the parameters of the callback and returns the account for display (ID, handle, name, avatar, profile link) and the access. It is called once per callback and fails for good whatever went wrong: the code in a callback is good for one exchange, so the person begins again. A failure says whether the person declined, which is no failure to them |
| Access | The credentials, opaque and stored encrypted, with two times: `refreshAt`, when to call `refresh`, and `expiresAt`, when the access ends unless it is refreshed. Either is null where it does not apply. Only adapters of networks that can renew an access have `refresh`. It is called by a timer when `refreshAt` comes, and at once when a method fails with `refresh`, one refresh at a time per channel. `disconnect` gives the access back where the network has a way |
| Limits | `limits` asks what the account may post. The answer is data that names its network, defined in `packages/core` with the counting that goes with it: `countCharacters` and `validateContent` are pure and run in the browser too. Adapters do not validate. They send what they are given, and the network is the judge |
| Publishing | `publishStep` takes the content, a key that names the delivery, and the progress that the step before returned. It makes at most one request that changes something and returns the new progress: the parts that are published, each with its ID and link, whether the post is done, how long to wait before the next step, and the adapter's own notes. The progress is stored as it is, so it holds no secret. A step can be run again at any time without publishing a part twice. Section 8 has the rules |
| Reading and deleting | `readPost` returns the text and what the post replies to, on networks that let pigy read. `deletePost` is fine with a post that is gone |
| Errors | Every failure that an adapter reports is a `ProviderError` with one of five kinds: `retry` (with the time the network named, if any), `refresh` (renew the credentials now, then try again), `fail` (with a message for the person), `reconnect`, and `uncertain` (a post may or may not be published, and a person has to look). Messages may quote the network, without the secrets of the request. One thing else can come out of any method, as it is: what the `fetch` that the adapter was made with throws that is no failure of a network, or what a store of the adapter's throws. That is a failure of pigy's with none of the kinds. A caller logs it, and knows no more of the call than of one that was cut off |

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
| Steps of `publishStep` | One that notes where the account's statuses stand and who is to see the post, then one per part: look for the status, and post it if it is not there, as a reply to the part before. More steps that only look, where the account has posted more since than one list holds | Two per part: choose the record key, then write the record with the references to the first and the previous part | One for the whole post: the parts joined | Per part: create a container, wait, read its status, publish it. A new container, in a step of its own, if it has expired |
| Adapter's notes between steps | The account's ID, the status after which the next part is looked for, and the visibility of the parts | The record key in use, and the reference of each part | None | The container in use |
| A step that is run again | Finds the status it posted among the account's own, or posts it | Writes the record under the same key | Sends again. It cannot look | Reads the status of the container first. Published: finds the post among the account's own and publishes nothing. Expired: creates a new container, which is a recorded step of its own, and publishes that one in the step after. Ready: publishes it |
| `readPost` | Yes | Yes | No: reading takes a permission that LinkedIn restricts | Yes |
| What asks for `refresh` | Nothing | An access token that the server refuses | Nothing | A token that Threads refuses as expired |
| What asks for `reconnect` | 401, a missing scope | A refresh that is refused | 401 | An invalid token that cannot be refreshed |
| What asks for `uncertain` | Nothing | Nothing | A request to post that ends without a clear answer | A container that is published and whose post cannot be found (to verify) |

The handle of a LinkedIn account is its name: LinkedIn gives pigy no other. The time of a refresh for Threads, and how Bluesky tells a token that has expired from one that was revoked, are for those adapters to settle.

What was decided along the way, and why:

- **No validation inside adapters.** The browser has to validate while somebody types, and it cannot import the adapters, so the rules live in `packages/core`. Keeping adapters out of it also means that the conformance suite can send what the validation would stop, and see the network refuse it.
- **Credentials carry what revoking them takes.** On Mastodon that is the registration the token was issued to. The stored registration of an instance can then change, or be lost, without breaking a channel.
- **Optional methods for what a network cannot do.** `refresh` and `readPost` are missing from an adapter rather than present and failing, so the type says what a caller can count on.
- **Scopes for media are asked for now.** A registration with a Mastodon instance cannot gain a scope later. Asking for `write:media` in phase 3 spares everybody a second connection in phase 7.
- **A step asks the network what happened, and does not trust a window of time.** Mastodon remembers an idempotency key for an hour, LinkedIn tells a repeated post for about ten minutes. A person presses "Retry" hours after a post failed, so neither is a guarantee. Section 8 has what takes their place.
- **`uncertain` is a kind of its own.** Where a network lets pigy neither look nor repeat a request safely, the truthful answer is that nobody knows whether the post is there. Sending again would be a guess, and so would giving up.
- **`refresh` is a kind of its own.** A token can be refused before the time pigy has for it: the clocks differ, or a refresh for another post replaced it while this step ran. `reconnect` would mark a healthy channel as broken, and `retry` would hand the step the same token until the workflow gave up.
- **A connection is never completed twice.** The code in a callback is good for one exchange. A failure halfway may have spent it, so asking the caller to try again would promise what cannot be kept.

### Connecting and disconnecting

The Worker's side of the first row of the table above, built in phase 3b-1. `packages/core/src/connect.ts` has the requests and the answers.

| Route | What it does |
| --- | --- |
| `POST /api/workspaces/<workspace ID>/connect` | Takes the network and, where the network asks, what the person typed. Calls `beginConnect`, keeps `pending` in `oauth_state`, and answers with the address to send the browser to. A refusal carries a message for the person, and names the field of the request that it is about: 400 with `field` set to `identifier` for what they typed, 400 with `network` for a network that pigy cannot connect, 502 without a field for a server that is out of reach or in trouble, 503 for a pigy without keys |
| `GET /connect/<network>/callback` | Where the network sends the browser back to. Takes `pending` out of `oauth_state`, calls `completeConnect`, stores the channel with its sealed credentials, and sends the browser on to `/channels?connect=…`. It answers with that redirect whatever fails, pigy's own database included, and never with an error |
| `DELETE /api/workspaces/<workspace ID>/channels/<channel ID>` | Removes the channel, and calls `disconnect` with the credentials that it held. Answers whether the network took the access back. Both steps go to their end if the client leaves meanwhile |

What was decided, and why:

- **A connection ends in the session that began it.** The callback is a request that another site starts, so it is believed only for its `state`: random, made by the adapter, kept on the server, good once, and found only for the session that began. Otherwise somebody could connect an account of their own, keep the answer of the network to themselves, and have another person open it: that person's workspace would then post to the first one's account. A callback in another session finds nothing and uses nothing up.
- **A refusal to begin says where a form should show it.** One status covered what a person typed, a network that pigy cannot connect and a request that is malformed, and only the first belongs next to the field for the server. So an error response that is about one field of the request names it in `field`, here and in every route: section 12. A server that cannot be reached is a 502 with no field, because trying again later can work.
- **In a sandbox, a server that its world does not have is a mistake of the person, not trouble of a server.** To the adapter it is a host that cannot be reached, which on the internet means trying again later. In a sandbox it means never: a world has the servers that it has. Somebody who enters `mastodon.social` there is told so with a 400 about `identifier`, in a message that names the simulated server to enter, `sandboxServers` in `packages/core`. The `fetch` of a world marks the failure for the route to tell: section 7.
- **The address in the answer is one that a browser may be sent to.** A page of the app navigates to it, so it is checked on both sides with the same schema, `connectResponseSchemaFor` in `packages/core`: an HTTPS address, which the consent page of every network has, or an address of the app itself, which serves the simulated consent pages and is reached without HTTPS in development. An address such as `javascript:…` would run in the page.
- **The outcome travels as a word, not as a message.** The callback answers with a redirect to `/channels`, with `connect` set to `connected`, `cancelled`, `expired` or `failed`, and with the network, the workspace and the channel where they are known. What a network said goes to the log, and so does what went wrong in pigy, without the values that a failed query was run with: the `state` of the callback is one. A message in an address would be shown by the page as pigy's own, and anybody can make up an address. Somebody who is no longer signed in when the network sends them back gets `expired` like everybody whose connection is not found: the app has them sign in, brings them back to `/channels`, and says that the connection has to be begun again.
- **Disconnecting always removes the channel, and removes it first.** The `WorkspaceDO` removes the channel and hands over the sealed credentials that it held, in one transaction. Only then is that access given back, where the network has a way. If that fails, because the network is out of reach or the credentials no longer open, the channel is gone all the same, and the answer says that the access may still stand: a channel that could only be removed while its network answers could stay for ever.
- **The access that is given back is the one that was removed.** In the other order, with the network asked first and the channel removed afterwards, three things went wrong. A workspace that failed in between kept a channel that said `connected` with a token that was revoked. An account that was connected again in between had its new credentials stored on the channel, which was then removed with them: a token that pigy held no more and had not revoked. And a channel could outlive the revocation of its own token. Now a channel that cannot be removed keeps its access, and an account that is connected again while it is disconnected gets a channel of its own, which the disconnect does not touch.
- **One case is left, and is accepted.** Mastodon gives a new connection the token that the account already has with the same registration. An account that is connected again while the revocation of that token is on its way gets the same token, so its new channel says `connected` with an access that is about to go. pigy cannot tell, since the token is the same, and the channel turns out to need connecting again when it is next used. It is the same as for two workspaces that share an account, below, and takes two tabs and a moment of bad luck.
- **A disconnect goes to its end when nobody waits for the answer.** The Workers runtime drops what is left of a request when its client goes away. Somebody who clicks to disconnect and closes the tab would leave a channel that is removed and a token that nobody revokes, with nothing left to revoke it with: the credentials went with the channel, and a second request finds no channel. So the route hands the removal and the revocation to `waitUntil`, which keeps them going for up to 30 seconds after the client is gone, and it still answers whether the access was given back. Two cases are left, and are accepted. The answer of the `WorkspaceDO` can be lost on its way after the object has removed the channel. And the revocation can fail, or take longer than those 30 seconds, once the person has left and cannot be told. In both, the token stays good at the network until the person revokes it there, and pigy holds nothing of it. Closing them would take a place for credentials that wait to be revoked, outside the channel, and a job that tries again: too much for a token that its owner can take back.
- **One account may be connected to several workspaces, and they share its access.** Nothing stops two people from connecting the same account, and Mastodon gives out the same token for the same registration and account. Disconnecting in one workspace revokes that token, so the channel of the other needs connecting again when it is next used. This is accepted. Keeping the token while another workspace uses it would take an index of which workspace holds which account, kept in step with every `WorkspaceDO`, and it would leave pigy with access to an account that somebody has just disconnected. Section 8 has what else such a pair of channels can do.
- **A channel gets only the addresses that a browser can open.** The picture and the page of a simulated account are on a host that exists in its world alone, so a channel of a sandbox has neither.
- **Channels change only through mutators that clients cannot send**, `channel.connect` and `channel.disconnect`. See section 4.

The Channels screen, built in phase 3b-3a, is the app's side of these routes:

- **The list is read from the local copy**, like every screen, so it is there at once and without a connection. Connecting and disconnecting are the two things in the app that a device cannot do by itself: they need the server, and without a connection the screen says so and offers neither.
- **What a network asks is a table, not a screen.** `apps/web/src/lib/networks.ts` says for each network what it is called, whether pigy can connect it, what a person types and where they remove an app at the network. The screen is made from that, so the next network is an entry. A network that cannot be connected yet is listed as coming, and is nothing to press.
- **In a sandbox nobody guesses a server.** The form has the simulated server of the sandbox filled in and says that it is simulated. Somebody who enters another one is told which to enter, next to the field: the route names the field.
- **A refusal is shown where the route says.** With the field `identifier`, next to the field. Otherwise with the form: a 502 with the advice to try again in a moment, a 503 with the plain statement that whoever runs this pigy has not given it the key to store credentials with.
- **The dialog is one step in the history of the browser.** Its address says what it shows, so that the way to a network and back, a link from another screen and the command palette all lead into it. Opening it adds an entry to the history, and Back closes it. The steps inside it, from the choice of a network to the form and back, take the place of that entry, and so does closing it: Back never leads through what the dialog has shown, or into it again.
- **A connection that is being begun can be called off.** Until the answer of the server has sent the browser to the network, closing the dialog, going back to the choice of a network, changing the workspace or leaving the screen gives the request up, and an answer that comes all the same is not followed. A slow answer would otherwise take the person to the consent page of a real network after they have turned to something else, which can be the sandbox.
- **The outcome is taken out of the address at once**, before the screen is shown, and kept in memory until the screen has said it. Loading the page again does not say it again. The screen has a text of its own for each of the four outcomes and shows nothing else of the address: the account that was connected is named from the row of its channel, when the copy has it.
- **The tab shows the workspace that the connection was for.** The address names it. A connection can end in a tab that shows the other workspace: it was begun in another tab, or the network has sent the browser back in a new one. Showing the outcome under the name of the other workspace would say "connected" over a list without the account. This is the one place where something other than the person changes what a tab shows, and it changes that tab alone: the device goes on remembering what the person chose.
- **Disconnecting asks first** and says what it means. The answer says whether the network took the access back. If not, the screen says so and names the place in the network's settings where the person removes pigy. The channel leaves the list when the server has answered, a moment before the copy hears of it. The keyboard was on the button of its row, which is gone with it, so it goes to the button that connects an account. The request is not called off, unlike the one that begins a connection: the server goes through with it whatever becomes of the page. So the question stays open until the answer is in, and the command palette does not open over it, or over any other dialog: a command would take away the screen that the answer is waited for on. The shortcuts of the app do nothing while a dialog is open for the same reason, also when the key press does not come from the dialog: its buttons are disabled while the request is on its way, and a browser takes the focus off a disabled button. The Back of the browser still can. Then a notice says how it went, on whichever screen the person is by then, because what is left to do when the network kept the access is theirs to do.

What the publishing pipeline of phase 3b-2 added to channels, and what is left:

- **The limits of an account** are in the row of its channel, with the time at which the network was asked. `limits` is asked when an account is connected, where a network that does not answer costs the limits and not the connection, and again by a delivery that finds them more than a day old or missing. The browser reads them from the row, to count while somebody types.
- **The status `needs_reconnect`** is set by the mutator that ends a delivery, in the same change as the target that failed, when an adapter fails with `reconnect` or the credentials of the channel no longer open. It is set only for the connection that failed, which the delivery names by its `connectedAt`: a channel that was connected again before the delivery said so stays `connected`. Connecting the account again clears it. A delivery to a channel in that status fails at once, without a request to the network.
- **Refreshing credentials.** A step that an adapter fails with `refresh` renews them and stores the new ones in the channel, in place of the ones that it started from and only of those: `renewChannelAccess`, with the mutator `channel.renew` for when the access ends. `refreshAt` is stored with them and still nothing reads it. The first network that names a time adds the reading to the alarm of the `WorkspaceDO`, and then has two things that refresh a channel, the alarm and a delivery, where now there is one: they have to take turns, which the delivery queue does not see to. The object holds the credentials sealed and has the Worker's secrets, so it can open them with `src/channels/credentials.ts` as the workflow does.
- **Sealing again.** A step of the workflow opens the credentials of its channel each time. Sealing them again there with the newest key, so that an old key can be dropped, is not built: see section 16.

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
- Which `fetch` an adapter gets is decided by the environment of the workspace, live or sandbox, and by nothing in a request. `reachOf` in `apps/worker/src/network/reach.ts` is the one place that decides, and every adapter in the Worker is made through it. A sandbox gets a `fetch` that leads into its world and nowhere else, whatever host a request names. A live workspace gets the `fetch` that the app was built with.

The sandbox gives the Mastodon adapter a store for registrations of its own, per world: the same simulated instance exists in every user's world, each with its own registered clients. The registrations are in the same table as the real ones, `mastodon_app` of D1, under the ID of the sandbox workspace where the real ones are under `live`. They are pigy's own records, not part of a network, so they are not in the world.

### The simulated world of a sandbox

Every sandbox workspace has a `SimWorldDO`, named after the ID of the workspace, which holds its world in the storage of the object. `apps/worker/src/sim` has it.

- A new world starts with one Mastodon instance, `mastodon.example`, and three accounts to connect as. `sandboxMastodonDomain` in `packages/core` is the name, for the app to offer.
- The Worker is the only way in, and the object makes no requests. A request crosses into it whole, as plain data, and so does its answer: a body that is passed as a stream stays open across the call until somebody reads it.
- The object hands a request to the simulator that owns its host: each simulator says which hosts are its own. A host that none owns does not exist in the world, and the `fetch` of the world fails for it as for a host that cannot be reached, with an error of its own kind, because in a world that is for good. An answer that a fault makes a simulator lose fails the same way without that mark. So does a call that the runtime could not carry into the object or back: a connection to the object that was lost, an object that a deploy has reset, one that has more to do than it can take. The way into its world is to a sandbox what the internet is to a live workspace, and the runtime marks such an error as its own, `retryable` or `overloaded`, which is what `worldFetch` goes by. Whatever else goes wrong in a world, such as a world that turns out to be another workspace's or a bug in a simulator, is a failure of pigy's and is not passed off as the network's.
- Like the `WorkspaceDO`, the object remembers which workspace it was first used for and answers no other. It answers no live workspace at all.
- The pages of a simulated network that are there for a person, which are the ones where they consent to a connection, are served by the Worker under `/sim/network/<host>/…`. The address names no world: it is that of the sandbox of whoever is signed in. So no address shows one person the world of another, and the API of a simulated network cannot be reached from a browser at all.

The Google simulator is the first one, built in phase 1, and differs from the others in two ways:

- It is not part of the production build, because it signs anybody in as anybody. The Worker's entry point builds it in only for development, tests and the build that the end-to-end tests run against. The production build is checked for it, and it answers only requests that name a local host such as `localhost`. That is a property of the request, not of where it comes from, so a build that contains it must not be exposed to a network.
- It keeps almost no state. Sign-in happens before there is a user whose `SimWorldDO` could hold any, so its authorization codes carry what is needed to redeem them, signed. Only which codes were redeemed is remembered, in memory.

Its consent page is served by the Worker under `/sim/google/*`. Without Google credentials, development and the end-to-end build use it and make `admin@example.com` the admin, so that a fresh clone needs no setup.

### Sandbox in the app

- A **Live / Sandbox** switch: at the top of the sidebar, in the header on a phone, and in the command palette. The sandbox has a banner across the top of every screen, also over what covers the app on a phone, such as the editor of a draft, and its name in the title of the tab. The live side has neither.
- New users start in the sandbox. Phase 3b-3a leaves it empty and makes the first steps plain instead: the empty Drafts screen says what the sandbox is and leads to connecting a simulated account, which takes the form with the simulated server filled in and the consent page. Whether a new sandbox comes with accounts already connected and a few sample drafts is decided together with publishing, which is what they would be for.
- Connecting a simulated account goes through a simulated consent screen under `/sim/*`, clearly labelled as fake.
- A **simulated feeds** page shows what was published to each network, including thread chains and media. `GET /api/sandbox/feed` has what it shows: the accounts of the world, each with its posts, a thread as a chain of replies.
- A **failure panel** lets the user make the next publish fail, to see error handling, retries and notifications. `GET /api/sandbox/faults` has what it offers, the kinds of fault and of request that each simulated network declares, and what is armed. `POST` arms a fault and `DELETE` disarms them all. A fault that asks to be tried again makes the workflow wait as long as it would for real, a minute at least: the panel should say so.
- Both routes name no workspace, like the pages of the simulated networks: they answer for the sandbox of whoever is signed in. `packages/core/src/sandbox.ts` describes them.
- Sandbox API keys (`pigy_test_…`) hit the sandbox, so scripts can be developed without posting for real.
- Simulated Google sign-in is compiled out of production. Real sign-in is always required, including for the sandbox.

How the switch works, and why:

- **The choice belongs to the tab, and the device remembers the last one.** A tab shows the workspace that was chosen in it, over a reload and over the way to a network and back. The device remembers the choice that was made last, and a new tab, or the app when it is next opened, starts with that. Somebody who has never chosen starts in the sandbox. The other way, one choice for the whole device that every tab follows, was not taken: a tab would turn from sandbox to live behind the back of whoever comes back to it, and what they then try there would go out for real. A tab that changes only when somebody changes it cannot do that. It also lets the two be open side by side, which is how something is tried in the sandbox next to the real thing.
- **A link that is opened in a new tab starts with the device's last choice.** The address of a draft or of a channel to connect again does not say which workspace it is of. A tab that follows such a link stays in its workspace. A new tab has no choice of its own yet and takes what the device remembers, which another tab may have set since: so the link can open under the other workspace, where the draft is not found and there is no such channel to connect. That is accepted. The name on screen is right, the screen says that the draft is not there, and nothing is written into the other workspace. The other way would be to put the workspace into every address, for the switch to rewrite and for every screen to check.
- **A choice names its workspace.** What is remembered is the ID of the workspace. A choice that somebody else left on the device names no workspace of whoever is signed in now, and counts as none. Signing out forgets the choice with everything else: the device's, the choice of the tab that signs out, and the choice of every other tab, which forgets its own when it starts again because of the sign-out. Whoever signs in next starts in the sandbox, in whichever tab, also if it is the same person.
- **The name and the data change in one step.** The route that every screen is under hands the workspace and its store to the screens together, and the banner and the switch read the workspace from the same place. So no screen shows the data of one workspace under the name of the other, not between two renders either. Every screen is made anew for the other workspace, so nothing that it held is carried over: an open dialog, a draft that can be brought back. What the address says beyond the screen goes too, such as the draft that is open: a draft is never edited into the other workspace.
- **Notices belong to a workspace.** The offer to undo a deletion leaves the screen with its workspace. The notice of a refused change does too, without being dismissed: it is there again when the workspace is. They leave in the step in which the name changes, like the screens: the list of the notices is made anew for the other workspace. A notice that faded out under the other name could still be pressed there, and its undo would write into the workspace that is not on screen.
- **Switching does not stop the sync of the workspace that is left.** A tab goes on syncing every workspace that it has shown. Stopping would lose the changes that the tab could not store, which exist in its memory alone, and would keep what was written offline from the server until the person came back to that workspace. It also makes switching back instant. For the same reason the app starts the sync of the workspace that it does not show when the copy of that workspace holds changes that were never sent, for example after a session that ended while the device was offline: the sign-in page promises that they are synced when the same person signs in again.
- **The switch says what the other workspace holds.** The sync indicator is about the workspace on screen, and "Synced" there is not the whole story of a tab that goes on syncing the other one. When the tab holds changes of that one which it could not store, or which wait to be sent, the switch says so: with a dot, in words under it in the sidebar, and in words at that workspace in the choice that it opens, which is where a phone has room. The words are the ones that the indicator would use. It says nothing when there are no such changes, and nothing while they are on their way, which is over in a moment.
- **Signing out counts both workspaces.** The changes that would be lost are those in the copies of both workspaces and those that a tab could not store, whichever workspace that tab shows: section 4.
- **The first time a workspace is shown on a device, it is empty for a moment.** The screens have no loading state, so until the first answer of the server the lists are empty. After that, switching shows the copy at once.

Simulator state lives in a `SimWorldDO` per sandbox workspace, and so per user: one person's simulated posts are never visible to another.

## 8. Publishing pipeline

1. A post becomes due: the user chose "now", which is the mutator `post.publish`, or from phase 5 the WorkspaceDO alarm fired. The post is `sending` and its targets are `queued`.
2. The WorkspaceDO begins the delivery of each target whose channel is free: the target is `sending`, in a new attempt, and gets one run of `PublishWorkflow`, with an ID that is this delivery's alone so that a second start is a no-op: the workspace, the target and the time at which the workspace began the delivery. A target whose channel has another delivery under way waits for it to end, as described below.
3. The workflow runs durable steps, each with at most one request that changes something on a network: publish part 1, publish part 2 as a reply, and so on, and from phase 7 upload each media item. Each result is written back to the WorkspaceDO as it happens, so the UI shows progress live.
4. Transient failures (rate limit, server error, timeout) retry with backoff. Permanent failures (invalid content, revoked access) stop and mark the target `error` with a readable reason. A failure that leaves open whether a post was published, on a network where pigy cannot find out, marks it `uncertain`: the reason then asks the person to look before they retry. Phase 9 sends the notification.
5. If a thread fails midway, the sent parts stay recorded. "Retry", the mutator `target.retry`, continues from the failed part and never re-posts a sent one.

Built in phase 3b-2, for text and for Mastodon, the one network that has an adapter. `apps/worker/src/publish` has the workflow, `apps/worker/src/workspace` the queue, and SYNC.md section 4 what a client asks for and sees.

How the workflow and an adapter share the work:

- The content is checked with `validateContent` before the first step, against the limits of the account, which the first step of a run asks of the network again if the channel has had them for more than a day. What fails is not sent: the target ends in `error` with what `validateContent` found, and the other targets of the post go on. Each target is a delivery of its own from beginning to end, so one that fails holds no other back.
- A step of the workflow is one call of `publishStep`. It returns the progress as plain JSON, which is the recorded result of the step and the input of the next. `publish` in `packages/providers` is the loop: it takes the workflow's `step.do` and `step.sleep` and names the steps by their position, the same on a replay.
- The credentials are asked of the WorkspaceDO inside every step, also when a step is run again. A post can take longer than credentials last, and they can be replaced under it: a step that an adapter fails with `refresh` renews them and stores the new ones in the WorkspaceDO, in place of the ones that it started from. Nothing renews them by a timer when `refreshAt` comes: that is not built, and section 6 says what it takes. The WorkspaceDO hands the credentials out sealed, as it stores them, and the step opens them where it calls the adapter: section 16.
- A `ProviderError` says what the workflow does:
  - `retry` runs the step again with the same input, after the time the network named if it named one.
  - `refresh` has the step renew the credentials at once, whatever `refreshAt` says, store the new ones in the WorkspaceDO and call the adapter again with them. `publish` does this inside the same workflow step. If the stored credentials are no longer the ones that were refused, another refresh has replaced them, and they are used as they are. A refresh that the network refuses, or new credentials that are refused too, mean `reconnect`.
  - `fail` ends the target with the message.
  - `reconnect` ends it and marks the channel, if the channel still has the connection that was refused. The step says which connection it was refused with, by the `connectedAt` that it read with the credentials, and `target.end` compares: the end of a delivery can be recorded after the person has connected the account again, and marking the channel then would fail every later delivery without trying an access that is good.
  - `uncertain` ends it with the message, which asks the person to look at the account. The workflow does not run the step again by itself. If the person finds nothing and presses "Retry", the step runs again from the recorded progress, and sends.
- A step can also fail with what is no `ProviderError`: a bug in pigy, or what the `fetch` of the adapter threw that is no failure of a network, which an adapter passes on as it is. It has none of the kinds, and the workflow must not read one into it. It logs the failure, and the step is one whose outcome is not known, like a step that was cut off. The target then ends as `uncertain`, with a text that says that pigy cannot tell how far it got and asks the person to look. It is not run again by itself: a bug would be met again, and what it leaves behind is unknown. A person who asks for another try gets one from the recorded progress, where an adapter that can look does.
- Before a step is run again, the run before it has to be over: a request that is still on its way to a network, or still being worked on there, shows nowhere yet. So a target has one run at a time, and the backoff after `retry` starts at a minute, which is longer than an adapter waits for an answer.
- After `retry`, the step is run again when the time has come that the network named, and not before a minute is over. Where the network names none, the waits double from a minute: 1, 2, 4, 8 and 16 minutes. There is an end to it: a step is run six times at most, which gives up on a network that stays out of reach after half an hour, and a network that names a time more than an hour away is not waited for at all. The target then ends in `error`, with what the adapter said and how often it was tried, and the person tries again when they see fit. A delivery that waited for hours would hold up everything behind it on its channel. `apps/worker/src/publish/retry.ts` is the whole policy.
- The deliveries to one channel run one at a time. A target takes its first step only when every target of the same channel that began before it has ended, and until then it waits its turn in the WorkspaceDO, which starts the workflows. An adapter tells the posts of a delivery from everything else on the account by what its first step recorded: Mastodon's by the status that was the account's newest then. Two deliveries to one account that begin together, "Hi" with the reply "a" and "Hi" with the reply "b", record the same status, and the second takes the "Hi" of the first for its own. It replies to it with "b", so one thread holds parts of both, and deleting either post in pigy deletes the first status of the other. No adapter can prevent that. One at a time, each delivery records where the account stands after the one before it has ended. The rule is kept per channel, because that is what a WorkspaceDO sees. An account that is connected as two channels, in two workspaces, is not covered: nothing coordinates the two workspaces, so their deliveries to it can overlap. That goes wrong only if both publish the same first part to the account at the same time.
- A target has ended, for that rule, when it is done, or when it has failed and is not taken up again. A failed target that "Retry" can still continue has not ended: it goes on from what it recorded when it began, and what has gone to the channel since is newer than that. On Mastodon only a target without a published part is concerned, because a later part is found as the reply to the part before it, which no other delivery has.
- Later targets pass a failed one. A target in `error` or `uncertain` does not hold up the queue of its channel, whatever it has published: nobody may ever look at it, and from phase 5 the posts that are scheduled behind it would pile up without a word. The price is paid by a target that has published no part and is not under way: one that failed, and one that was tried again since and waits its turn. From the moment that another delivery to its channel has passed its checks and is about to make its first request to the network, it can no longer go on from what it recorded. The workflow of the other says so to the WorkspaceDO, in a step of its own after `prepare` and before the first step of the adapter, and the WorkspaceDO drops the progress of every other target of the channel that has no recorded part, whatever its status. A delivery that ends before that point drops nothing: its channel needs connecting again, its post does not pass `validateContent`, the limits of the account could not be asked, or pigy has no adapter or no keys. It has put nothing on the account that another could take for its own. Neither does a delivery that is tried again with nothing left to send, because an attempt before it recorded every part and only its end was lost: it skips the step. A delivery that only has replies left to send does drop the progress of the others, though on Mastodon none of them could take a reply for its first part: the rule does not rest on what the later parts of a post are on a network.
- What "Retry" guarantees follows from that. It does not send again what was recorded. A part that landed unseen, which is one that reached the network without pigy getting the answer, it finds where the adapter can look, unless another delivery to the same account has got as far as asking the network in between, whether or not it posted anything: then the retry starts over as a new delivery, no longer finds a first part that landed unseen, and that part may be posted twice. A delivery can end as `error` with a first part unseen in three ways: the network stayed out of reach through every retry after the request that got through, the look that follows a lost answer was answered with a 429 that names a time more than an hour away, which `retry.ts` does not wait for, or the network refused the credentials on that look. A target that nothing has passed goes on from its progress, and finds such a part. A target that has published a part keeps its progress whatever passes it.
- A step may ask for a wait before the next one, which is how Threads gets the time to prepare a post, and how media will get the time to be processed.
- The progress lists the published parts one by one. "Retry" starts a new run from the progress that was recorded, with the same key. A delivery that starts over has the same key too: it is still the delivery of that target, and a network that remembers the key answers with the post it made for it, which is the one thing that can still spare a second post.
- The key names the delivery: the ID of the target. It is what Mastodon's idempotency keys are made from, so publishing a post a second time on purpose takes a new key. That rests on the ID of a target never being used again, which holds for the app: it makes up a new ID for every target. A client that deletes a post and adds a target under the same ID, to the same account and within the hour that Mastodon remembers a key, is answered with the first post and sees the second as sent. It harms nobody but its own workspace. A key that the server makes for each target, and keeps through its retries, would close that, and belongs with the REST API of phase 6 if its clients are to choose IDs.

How the WorkspaceDO and the workflow share the work. `apps/worker/src/workspace/store.ts` and `object.ts` are the one, `apps/worker/src/publish/workflow.ts` the other:

- **The queue is the targets.** There is no table for it. A target that is `queued` waits, in the order of `queuedAt`, which no two targets of a channel share: the WorkspaceDO runs every mutation at a later time than the one before. `startDeliveries` begins, for every channel without a target that is `sending`, the one that has waited longest. That and the mutator it runs, `target.start`, which refuses while another target of the channel is `sending`, are the only place where a delivery begins.
- **An alarm starts the workflows.** Every change of a workspace ends with a look at whether a delivery can begin, and if so the alarm of the object is set to now, in the same write as the change. The alarm marks the targets `sending`, creates their runs, and notes for each that it has. A run that the platform does not create is logged and left for the next alarm, a minute later: it does not keep the runs of the other deliveries from being created, and no change brings the alarm forward for it. Otherwise every keystroke of a client would cost an alarm, a request to the platform and a line in the log for as long as Workflows is down. If the object stops in between, the alarm runs again and creates what is missing: the platform takes an ID once, and a run that is there under the ID of a delivery is that delivery's own. The ID is made of the workspace, the target and the time at which the workspace began the delivery, which is the time of the mutation that made the target `sending` and so no other delivery's. The target and its attempt would not do: the runs of all workspaces share their IDs, a client makes up the ID of a target, which is unique within its workspace only, and a target that is deleted with its post and added again under the same ID begins at its first attempt again. A delivery would then find the run of another under its ID, take it for its own, and never be carried out.
- **The object watches its runs.** A workflow tells the workspace how a delivery ended, as its last step. A run that cannot, because the platform gave up on a step of it, or somebody terminated it, would leave its target `sending` for good, with every later post to the channel behind it and nothing that a person could do. So while a delivery is under way, the alarm comes back every minute and asks the platform for the status of each run. A run that is over without having ended its delivery has its target ended as `uncertain`.
- **A run reports what it is, and is refused when it is not.** Every report names the target and the attempt. A report on a target that is not `sending` in that attempt is refused, and the run stops: the delivery was ended otherwise, by a disconnect or by the watch above, and may have begun anew. That is the guard in the mutators, `currentTarget` in `packages/core`.
- **A report is carried out once.** A step of a workflow is run again when its answer was lost, and a call that was given up on can arrive after the ones that followed it. A report that was carried out twice in the wrong order would put a delivery back to where it had fewer parts. So every call that changes the workspace comes with a key, and the object carries a call with a key out once: it keeps the outcome under the key, in the transaction of the change, and answers a repeat with it. The key is the ID of the run, what the call is for, and a digest of what it says. The name of a step is not enough: a run that somebody restarts takes its steps again from the first, with other things to say. `mutateWorkspace` takes such a key from any caller, which is what the REST API of phase 6 needs for the `Idempotency-Key` of a request.
- **What goes wrong in a step is its result.** A step that talks to a network catches what the adapter throws and returns it, as a description: the kind, the message, how long to wait. The workflow reads it and decides. An error that is thrown out of a step reaches the workflow without its class, and the platform runs such a step again on its own schedule, which is not the network's. The platform's own retries are left for a step that was cut off: its time was up, the Worker went away under it, or the workspace could not be asked for what the step needs before it does anything.
- **What the platform throws is not caught.** The workflow ends a delivery only for what it has seen fail itself. When the platform stops a run, to pause it, to restart it or because it has given up on a step, that arrives in the workflow as an error like any other, and taking it for a failure of the delivery would end a delivery that is only being moved. It is thrown on, and the watch above ends the delivery if the run is over.
- **Credentials.** A step asks the WorkspaceDO for the sealed credentials of its channel and opens them where it calls the adapter, every time it is run. Nothing of them is in what the run was started with or in what a step returns, which the platform stores and shows. A run is started with the workspace, the target and the attempt, and its first step returns the text of the post, which every step after it is handed, as the contract of an adapter asks.
- **A refresh** is asked for by the step that the network refused, with the credentials that were refused. It is carried out only if those are still the ones that the workspace holds, and what it returns is stored only in their place. One at a time per channel follows from one delivery at a time per channel: nothing else refreshes yet. Section 6 says what changes when something does. On some networks a refresh ends the credentials that it started from, so what it returns must not be lost: when the WorkspaceDO does not take the new credentials, the step hands them over again, the same sealed text, up to four times within half a minute. If the WorkspaceDO still does not take them, the step goes on with them and the log says so: they are good for that step, the next one reads the old ones, and on such a network the account then has to be connected again. Ending the step instead would only bring that forward.

What happens to a delivery when something is taken from under it:

- **The post.** A post that is `sending` is not deleted: `post.delete` is refused until its last target has ended. Deleted in the middle, it would leave posts on the networks that nothing in pigy knows of. It cannot be edited from the moment it is published, so every step is handed the same content.
- **The channel.** Disconnecting removes the channel at once, as before, and ends what was to go to it, in the same change: a target that is `queued` or `sending` ends in `error`, with the parts that it has published. The run finds out at its next step, where the workspace has no credentials for it or refuses its report, and stops. The request that was on its way is refused by the network, which has taken the token back, or carried out: such a part is on the network with no result in pigy. A target that had ended stays, with the ID of a channel that is gone, and cannot be tried again.
- **The WorkspaceDO.** Everything that it knows of a delivery is in its database, so it can leave memory at any time. A run that cannot reach it tries again for hours.
- **The Worker.** A deploy or a move in the middle of a step makes the platform run the step again, a minute later at the earliest, with the results of the steps before. That is the case that an adapter is built for.

An account that is connected as two channels, in two workspaces, stays as it was: nothing coordinates their deliveries, and nothing was added. Keeping them apart takes a lock per account that every WorkspaceDO goes through, for a case that needs two people to publish the same first part to a shared account in the same moment, and whose outcome is a thread that both can see and delete.

Avoiding duplicates when a step is run again. A step may have reached the network with only its answer lost, and it may be run again a moment or days later. So an adapter does not rely on what a network remembers for a while. Before a request that publishes, the recorded progress holds what a later run needs to find out whether the request was carried out, and a step that does not find it there records it first and sends nothing. A step that finds it asks the network:

| Network | Recorded before the request | A step that is run again |
| --- | --- | --- |
| Mastodon | The account's ID, its newest status and the visibility that every part is posted with, by a first step that sends nothing. For a later part, the part before it | Looks through the account's statuses that are newer than that for one with the text of the part that replies to the part before it, or to nothing for the first part. In the text, the case of a mention does not count, and neither does its domain if that is one of the instance's own, which the first step also records. The domain of another instance counts. The status also has to have the recorded visibility, and nothing besides its text: no media, poll, quote or content warning. Takes it for the part if it is there, posts if it is not. The `Idempotency-Key`, made from target and part, is sent as well: Mastodon remembers it for an hour |
| Bluesky | The record key, generated by a step of its own | Writes the same record under the same key |
| Threads | The container ID, by the step that creates the container | Reads the status of the container before it publishes. `PUBLISHED`: an earlier run has published it, so the step publishes nothing and finds the post among the account's own. `EXPIRED`, which a container is that was not published within 24 hours: the step publishes nothing and creates a new container. That is a step of its own, so the new ID is recorded before anything is published with it. `FINISHED`: it publishes. Meta does not document what publishing a published container answers, so a step never does that knowingly (to verify, section 19) |
| LinkedIn | Nothing that would help: LinkedIn lets pigy read no posts and takes no key | Sends. Because that is not safe, a request that ends without a clear answer is not retried: the step fails with `uncertain`, and a person looks. Inside about ten minutes LinkedIn refuses the same content again, which the adapter can take for success (to verify) |

What this guarantees: no part is published twice, however late a step is run again, as long as the run before it is over and what it published is still on the network as it was published. A status that the person has edited or deleted in the meantime is not found, and is posted again.

The rule by which Mastodon's adapter finds a status cannot take another post for the one it looks for unless that post says the same in the same place to the same readers, has nothing but its text, and is newer than the delivery: the person posted the text in the meantime, by hand or with another app. The two would have been duplicates. It is never the post of another delivery to the same channel, because those run one at a time. Without that rule the claim would not hold, and for an account that two workspaces have connected it does not: see above.

The text of a status is not the text that was sent. Mastodon drops the whitespace around it, and it writes every mention of an account that it finds the way the account is written: on mastodon.example, `@ADA@mastodon.example` is saved as `@ada`, and `@gargron@mastodon.social` as `@Gargron@mastodon.social`. Which accounts a server finds, only the server knows, so the adapter does not rewrite as Mastodon does. It compares the two texts with every mention in lower case, and without its domain if that is the instance's own, which are the two things Mastodon changes in a mention it has found. A status that differs from a part only in the case of a mention, or in naming the instance where the part does not, is therefore taken for it: both mention the same account. A mention of the same name on another instance is somebody else, and keeps its domain, so such a status is not taken.

The visibility is settled by the first step and not left to Mastodon, so that a step knows what it looks for: the one the adapter was made with, or else the account's own setting, read from the account. A status with the same text for other readers is not the post, and taking a status for the account alone as a public part would leave the post unpublished. Mastodon makes "unlisted" of what an account that its moderators have limited posts as "public", so for such an account the first step records "unlisted".

A step reads one list of 40 statuses. If the account has posted more than that since, the step posts nothing and notes how far it has looked, and the next step goes on from there, so a post is never sent before everything newer has been looked at. A status that is not newer than the recorded one is never looked at, also where a server that does not know `min_id` lists it: it is from before the delivery, however much it reads like a part.

What `uncertain` does not cover is a step that is cut off after its request went out and before any outcome was recorded. A workflow runs such a step again by itself, and an adapter that cannot look sends a second time without ever having failed. Only LinkedIn is of that kind. Its pull request has to settle it: the WorkspaceDO can note that a step has begun before the adapter is called, and treat a step that began and left no outcome as `uncertain`.

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
- The device remembers who was signed in on it and which workspaces they have, in `localStorage`, and which of the two it showed last: section 7. That lets the app show the local copy before the server has answered, and without a connection. It lets nobody in: the session cookie does that, and the server checks it. The app asks the server when the person goes from one screen to another, in the background and not more often than every two seconds, and the sync socket is refused within five minutes of a session ending. A link that is only hovered, which the router loads ahead, is no reason to ask. When the answer is that the session is over, the app leaves for the sign-in page and the local copy goes: section 16. So somebody whose session has ended can see the data that was already on the device until the device has reached the server once, and never anything newer.

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
- **Errors**: every error response is `{ "error": name, "message": text }`. The name follows from the status: `UnauthorizedError` for 401 and 403, `NotFoundError` for 404, `LimitReachedError` for 429, `InvalidInputError` for every other 4xx, `UnexpectedError` for 5xx. An `InvalidInputError` that is about one field of the request also has `"field"`, the name of that field, with dots between the parts of a nested one, so that a form can show the message next to the input. The app's own routes outside `/api/v1` answer the same way.
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
| Sync | Vitest in the Workers runtime | Two clients converge, the offline outbox replays once, snapshot fallback works, one user cannot reach another's workspace, credentials never appear in sync messages. The server is tested with a client written for the tests, and the client of the app is tested against the real workspace object |
| Sync client | Vitest | The rules of SYNC.md for a client, against a server that the tests play: pending mutations on top of patches, confirmation and rejection, the outbox and what it merges, starting over, every close code, several tabs |
| End to end | Playwright against the local Worker, built as for production except that sign-in is simulated | Simulated Google sign-in, allowlist refusal, sandbox onboarding, connecting four simulated accounts, cross-post with override, thread and image, schedule and fast-forward, offline draft then sync, several tabs and devices, installability checks, phone viewports |

**No real network in CI.** In test runs, any outbound request to a host that is not simulated throws, so a test that reaches for a real service fails. The build that the end-to-end tests run against has no `fetch` that leads outside: sign-in and the sandboxes are answered inside the Worker, and what a live workspace asks of a network is answered by a guard, `apps/worker/src/outbound.ts`, with an error.

**Keeping the simulators honest.** The adapter conformance spec can also run against the real services with dedicated test accounts. That run is manual or nightly, never part of pull request CI, and it deletes what it posts. If the real service and the simulator disagree, the simulator is fixed.

The run is started by `pnpm --filter @pigy/providers conformance:live <network>`, with the credentials of the test account in the environment. The script is the only way to start it, and refuses in CI. It posts with the least visibility the network has: on Mastodon, posts that only the account itself sees. In CI the same specification also runs against the simulator with the harness of the live run, which has one account and no way to look into the network, so that the live run does not break unnoticed between the times somebody starts it.

The conformance suite runs in Node, like the other tests of the packages, and not in the Workers runtime as an earlier draft of this plan had it. The adapters use nothing but web-standard APIs, the live run needs Node to reach the network, and the pipeline tests run the same adapters in the Workers runtime.

**CI (GitHub Actions)**: lint, typecheck, unit and Workers-runtime tests, Playwright with traces on failure, build. From phase 11, merges to `main` also apply D1 migrations and deploy.

## 16. Security

- Channel tokens are encrypted at rest with a key held as a Worker secret, with a key version for rotation. The same goes for what else pigy keeps of secrets that are not its own: its registrations with Mastodon instances, and what a connection that has begun needs to finish. The details follow this list.
- OAuth uses state and PKCE everywhere. The state of a connection is kept on the server, is good once, and only in the session that began. Cookie-authenticated writes and the WebSocket handshake check the origin.
- A workspace is reached only through the Worker, which looks it up by its ID and the signed-in user together. The Durable Object never sees the request of the client: the Worker makes a new one. The object also remembers which workspace and owner it was first used for and refuses any other, so a mistake in the Worker's routing cannot hand one person's data to another.
- Mastodon instance domains and asset URLs come from users, so they are validated, HTTPS only, and size-capped. An adapter follows no redirects, gives up on a host that does not answer, and reads a bounded amount of every answer. It takes for a network out of reach only what a `fetch` fails with when no answer comes, a `TypeError` or a request whose time is up. Anything else that the `fetch` it was given throws, such as the refusal of a simulated world that belongs to another workspace, is passed on and logged as a failure of pigy's, not reported as a server to try again later. What a network says in an error may reach a message, a log or the screen only without the secrets of the request.
- The addresses of avatars and profiles come from the networks. Only HTTPS addresses are passed on. The address that a page sends the browser to for a connection comes from an adapter: it has to be HTTPS, or an address of the app itself.
- The simulated networks are part of the production build. Section 7 says what keeps them to their simulated world.
- Media links for Threads are signed and expire.
- Signing out deletes what the device holds of the person: the local copies of both workspaces in IndexedDB, what it remembers of the session, and the choice between live and sandbox, in every tab. If there are changes that were not synced, in either workspace, the app says so first and asks.
- So does learning that the session has ended, by expiry or because an invitation was withdrawn. There is one exception. A session ends without the person's doing, and a copy can hold changes that were made offline and never synced: deleting it would lose work that nobody chose to lose. Such a copy is kept. It is not shown to anybody, and the sign-in page says that it is there, whose it is and how many changes it holds. They are synced when the same person signs in again. They are deleted when somebody else signs in on the device, or when whoever is at the device says so on the sign-in page.
- A content security policy, and an audit trail of publishes per workspace.

**Sealing.** `apps/worker/src/vault.ts` seals a value before it is stored and opens it when it is needed, with AES-256-GCM and a new random nonce each time.

- The keys are the Worker secret `CREDENTIAL_KEYS`: a list of `<version>:<key>`. The key with the highest version seals, and each key opens what it sealed. A sealed value begins with the version of its key.
- A key is replaced by adding one with a higher version and keeping the old one. What the old key sealed is sealed again only when it is next written, so the old key stays for as long as anything is left that it sealed. Dropping it earlier costs a new registration with each Mastodon instance, which happens by itself, and a new connection of each channel that it sealed. Sealing the credentials of a channel again when they are read, so that an old key runs out of use, belongs to the step of the publishing workflow that opens them, `accessOf` in `apps/worker/src/publish/workflow.ts`. It is not built: until it is, an old key is dropped only when no channel is left that it sealed, and a channel whose key is gone fails its next post and asks to be connected again.
- A value is sealed for the place it is stored in: the workspace, network and account of a channel, the scope and domain of a registration, and for a connection that has begun its state together with the session, the workspace and the network that its row names. It does not open in another place, so somebody who can write to a database and has no key cannot give one channel the credentials of another, or hand the connection that one session began to another session, workspace or network.
- The Worker seals and opens, where it calls an adapter: in the routes that connect and disconnect, and in the steps of the publishing workflow. For the credentials of a channel that is one small module, `apps/worker/src/channels/credentials.ts`, and no other code calls the vault for them. The `WorkspaceDO` stores the credentials of a channel as it gets them and has no part in it. Credentials in the clear exist in memory only, between an adapter and the vault, and are in no log, no error, no sync message, no answer and no state of a workflow.
- A sealed value is kept out of the logs like the secret in it, and so is the hash of a session. The one way that they got there is an error of the database: Drizzle puts the values that a statement was run with into the error of a statement that fails. So the error handling of the app logs such an error as the statement and the reason, without the values, wherever in the causes of an error it is, for every route: `loggable` in `apps/worker/src/errors.ts`.
- Without keys nothing can be sealed, and then nothing is stored instead: no account can be connected, and the request to begin is refused before anything is asked of a network. A build for development and tests has a key from the repository for that case, so that a fresh clone needs no setup. It is not part of a production build, which is checked for it. A route uses it only where the app is reached locally. A step of the publishing workflow is reached at no address, so in a build that has the key it opens with it what a route sealed: `vaultWithoutRequest`.

## 17. Phases

Each phase ends with something that works and is covered by tests. Sizes are relative: S, M, L.

| # | Phase | Size | Done when |
| --- | --- | --- | --- |
| 0 | Foundations | S | Monorepo, a hello-world Worker with the React shell running in the local Workers runtime, CI green on lint, typecheck, tests, build and a Playwright smoke test |
| 1 | Sign-in and invite-only access | M | Google sign-in works, a non-invited email is refused, admins manage the allowlist, simulated Google sign-in drives the tests |
| 2 | Local-first core | L | The client store is chosen by a spike. Drafts can be created and edited offline, sync across tabs and devices, and the app installs as a PWA |
| 3 | Networks, simulators, sandbox | L | All four simulators and adapters exist. A text post publishes now to all four, in the sandbox and for real. Conformance and pipeline tests pass |
| 4 | Per-network text and threads | M | Live character counters, per-network overrides, thread editor, link cards, mentions and hashtags |
| 5 | Scheduling and queue | M | Exact-time scheduling, weekly slots, add to queue, reorder, pause, queue and calendar views |
| 6 | API keys and REST API | M | Keys can be created and revoked, the API passes its tests in both environments, OpenAPI docs are served |
| 7 | Images | M | Upload, alt text, per-network variants, published to all four |
| 8 | Video | L | Chunked upload, client-side checks, each network's upload and processing flow |
| 9 | Phone features | M | Push notifications, in-app inbox, share target, install prompts |
| 10 | Engagement stats | S | Stats collected and shown on sent posts |
| 11 | Hardening and launch | M | Deployment from CI, security review, reconnect flows, logging and alerts, backups checked, setup guide, friends invited |

Phase 2 is built in three steps. 2a is the server side: workspaces, the `WorkspaceDO`, the mutators, and the sync protocol with its tests. 2b is the client: the sync store, IndexedDB, the offline outbox, the tabs of a browser, and the drafts screen. 2c is the PWA shell: the service worker, the manifest, starting the app without a network, and installing it. Until 2c the data is there without a network and the app itself is not: a page that is open goes on working offline, and loading it takes the server.

Phase 3 is built in steps too. 3a is in the packages only: the provider interface, what the simulators share, and Mastodon as the first network, with its adapter, its simulator and the conformance suite. The steps after it put that to use in the Worker:

- 3b-1, the server side of channels: the synced table `channel` with its sealed credentials, the routes that connect and disconnect an account, the simulated world of each sandbox, and the guard that keeps the end-to-end build off the network. Section 6 has the routes and what was decided.
- 3b-2, the publishing pipeline, server side: targets and their results as synced tables, the mutators that choose channels, publish and retry, the workflow, and the queue of each channel in the `WorkspaceDO`. It adds the limits of an account to its channel, sets `needs_reconnect`, reads the credentials of a channel inside each step, makes the time of the server move forward only, and gives `mutateWorkspace` a key for callers that try again. It also has the routes that the sandbox screens read: the feed of a simulated world and its faults. Sections 6, 7 and 8 have what was decided. There is no screen for any of it yet.
- 3b-3, the web side, in two steps. 3b-3a: the Live/Sandbox switch and the Channels screen, with connecting, reconnecting and disconnecting. Sections 6 and 7 have what was decided. 3b-3b, after the publishing pipeline: publishing from the composer, the simulated feeds and the failure panel, and with them the decision whether a new sandbox comes with accounts and drafts.

Then Bluesky, LinkedIn and Threads follow, each the way Mastodon was built.

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

Mastodon and Bluesky need no developer registration. VAPID keys, the Bluesky signing key and the token encryption key are generated during setup and stored as Worker secrets. The token encryption key is `CREDENTIAL_KEYS`, in the form `1:<key>`, with the output of `openssl rand -base64 32` as the key.

## 19. Risks and things to verify

| Risk | Mitigation |
| --- | --- |
| The client store is our own code, where a library would have had other users to find its bugs | It is small, and its rules are those of SYNC.md, which are tested one by one in `packages/core` and against the real workspace object. Section 4 says why it is not TanStack DB |
| A deleted post is brought back by making a new one with the same text | Enough while a draft is only text. From phase 4 a post has more than a client can put back by hand, such as targets, media and a place in the queue: undo then needs a mutator of its own, or deletion that waits |
| atproto OAuth libraries are written for Node and may not run on Workers | Spike at the start of the Bluesky work. Candidates: `@atcute/oauth-node-client`, then `@bskyprism/atproto-oauth-client-cloudflare-workers`. Last resort: Bluesky app passwords |
| Threads is limited to testers | Fine for friends. Opening it up needs Meta's app review |
| LinkedIn tokens die after 60 days | Reminder a week before, one-tap reconnect |
| No LinkedIn stats | Shown as unavailable. Revisit together with company pages, which need the same approval |
| Video rejected by one network after upload | Client-side checks against the limits of the selected networks before upload |
| Simulators drift from the real APIs | Live conformance run, nightly or before releases |
| The first version is large | Phases are ordered so pigy is useful after phase 3 |

To confirm when the relevant phase starts:

- Whether Threads reply chains need the `threads_manage_replies` permission.
- For Threads, what a publishing step that is run again relies on, see section 8. Meta documents that the status of a container is read with `GET /{container-id}?fields=status,error_message`, that a container which is not published within 24 hours is `EXPIRED`, and that a published one is `PUBLISHED`. It does not document the rest:
  - What publishing a container that is already published answers: the post again, a second post, or an error.
  - How the post of a published container is found. The status names no post. The step would look through the account's posts, `GET /{user-id}/threads`, and through its replies, which Meta lists apart from them, for one with the text of the part in the same place, as Mastodon's adapter does. Then the first step has to record where the account's posts stand, and the rule of one delivery at a time per channel applies here too.
  - Whether a container still says `PUBLISHED` when it is read days after it was published, or says `EXPIRED` or is gone by then. If it does not, the step cannot tell a part that was published from one that was not, and has to fail with `uncertain`.
  - Whether a request to publish that Threads is still working on shows as `PUBLISHED` or as `FINISHED`. The workflow waits before it runs a step again, as for Mastodon.
- Whether Bluesky video upload works with the OAuth scopes pigy requests.
- LinkedIn's behaviour on duplicate content, and the current API version string.
- How a LinkedIn step that was cut off after it sent is kept from being run again, see the end of section 8.
- Decided in phase 3b-2, see section 8: the deliveries to one channel are kept to one at a time by the `WorkspaceDO`, whose targets are the queue. Later deliveries pass a failed target, and a "Retry" of one that had published no part then starts over. An account that is connected as two channels in two workspaces gets nothing new: nothing keeps the deliveries of the two apart.
- Current media size and duration limits per network.
- Workflows in the Workers Vitest integration were confirmed in phase 3b-2: they work, with the engine of the local runtime, and `reset()` clears their runs between tests. A run can be paused, resumed and restarted from a test, its waits can be skipped, and its steps and their results read. One caveat: a test and a step of a workflow must not wake each other with a promise, or the test run hangs without a timeout. AGENTS.md has the rule. WebSockets to Durable Objects were confirmed in phase 2a: they work, hibernation included.
- Not confirmed, because nothing is deployed yet: what the Workflows service answers for a run that does not exist. The watch of the `WorkspaceDO` takes a failure that says "not found" for a run that is gone, as the local runtime says it, and any other failure for a service that is in trouble. If the service words it otherwise, a delivery whose run was deleted by hand stays `sending`: `#isOver` in `apps/worker/src/workspace/object.ts`.
- Not confirmed either: that a run whose step is cut off by a deploy is taken up again as the documentation of Workflows says, with the results of the steps before. The tests pause, resume and restart runs, which is as close as the local runtime gets.
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
- Mastodon gives out the same token again for the same client, account and scopes. If one Mastodon account is connected to two workspaces, disconnecting one revokes the token of the other, which then has to be connected again. Phase 3b-1 has decided to accept that: section 6 says why. What is left to confirm is that Mastodon does give out the same token, which the simulator assumes.
- That the adapter finds a status which it has posted. It goes by the list of the account's own statuses, walked forward with `min_id`, and by the source of a status, which has to be the text that was sent, without the whitespace around it and with nothing changed but the case of a mention and the domain of one that names the instance itself. Both are as the documentation and Mastodon's code have them. Three cases are known in which Mastodon changes more, and such a part is posted again when its answer is lost: a mention under a domain that stands for another, which Mastodon replaces by that one, a mention of an account whose server answers for it under another name, and a text like `@a@b.example@c`, which can be saved as `@a@c`. A live run does not show whether they hold: inside the hour Mastodon answers a repeated request by its key as well, and a live run cannot wait an hour. To confirm by hand: lose an answer, wait, and run the step again.
- That the account's own setting for the visibility of its statuses is `source.privacy` in the answer to `verify_credentials`, also for a token with the scope `profile` alone, and that a limited account says `limited` there. Both are from Mastodon's code. An account that is limited in the middle of a delivery posts the parts that follow as "unlisted", where the step looks for the visibility it recorded: such a part is posted again when its answer is lost.
- That every server pigy posts to lists a status with `visibility`, `spoiler_text` and `media_attachments`. A step fails, and posts nothing, at a server that leaves one of them out.
- That a request to post which Mastodon is still working on shows neither in the list nor under its key. This is why the workflow waits before it runs a step again.
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
- Threads publishing, and the status of a container: https://developers.facebook.com/docs/threads/posts and https://developers.facebook.com/docs/threads/troubleshooting
- atproto OAuth: https://atproto.com/guides/oauth and https://docs.bsky.app/docs/advanced-guides/oauth-client
- Bluesky video: https://docs.bsky.app/docs/tutorials/video
- LinkedIn access tiers: https://learn.microsoft.com/en-us/linkedin/marketing/increasing-access
- Google OpenID Connect: https://developers.google.com/identity/openid-connect/openid-connect
- oauth4webapi: https://github.com/panva/oauth4webapi
- Sessions: https://lucia-auth.com and https://auth.pilcrowonpaper.com/sessions
- TanStack DB, which the spike of phase 2b tried: https://tanstack.com/db/latest/docs/overview and https://tanstack.com/db/latest/docs/guides/offline-transactions
- Web Locks and BroadcastChannel: https://developer.mozilla.org/en-US/docs/Web/API/Web_Locks_API and https://developer.mozilla.org/en-US/docs/Web/API/BroadcastChannel
- Cloudflare limits: https://developers.cloudflare.com/workers/platform/limits and https://developers.cloudflare.com/durable-objects/platform/limits
- Workers Vitest integration: https://developers.cloudflare.com/workers/testing/vitest-integration/test-apis and https://developers.cloudflare.com/workers/testing/vitest-integration/known-issues/
