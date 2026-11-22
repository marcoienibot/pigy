# Setting up pigy

What whoever runs a pigy does by hand, in order. Each step ends with a way to check it.

This guide says what to do. Why things are as they are is in two places, which stay the reference and which this guide points to: `AGENTS.md`, "Deployment", for what each secret is and what a deploy relies on, and `PLAN.md`, section 18, for what has to be registered where.

Nothing here has been done against a real Cloudflare account yet: pigy was built and tested locally, against simulated services. Where a step rests on what the documentation of a service says and nobody has tried, it says "to check". Section 8 has the list of what the first deployment has to confirm.

Commands run from the root of the repository unless they say otherwise. `wrangler` is the one that the repository installs: `pnpm --filter @pigy/worker exec wrangler …`, written as `wrangler …` below. `<host>` is the host of your pigy, such as `pigy.<your-subdomain>.workers.dev`.

## 1. What you need

- A Cloudflare account with the Workers Paid plan. The publishing workflow needs it: on the free plan a step of a workflow may use 10 milliseconds of CPU time, which is less than opening credentials and reading an answer take. `AGENTS.md`, "Deployment".
- A Google Cloud project, for the OAuth client that people sign in with.
- For LinkedIn and Threads, an application at each. Both can wait: without them the sandbox works in full, and Mastodon and Bluesky connect for real.
- Node.js 22 and pnpm 12 on your machine, as in `README.md`, and `openssl`.

## 2. The Cloudflare account

1. Create the account, and subscribe to Workers Paid under Workers & Pages → Plans.
2. Choose the `workers.dev` subdomain of the account, under Workers & Pages. It is set once and is part of the address of your pigy.
3. `wrangler login`

Check: `wrangler whoami` names the account.

## 3. The first deploy

By hand, from your machine. The deploys after it can come from CI, section 6.

```sh
wrangler r2 bucket create pigy-media
pnpm install
pnpm build
pnpm --filter @pigy/web exec wrangler deploy
wrangler d1 migrations apply DB --remote
```

Always deploy right after `pnpm build`. `pnpm e2e` and `pnpm preview:e2e` make a build with a simulated sign-in that signs anybody in as anybody, and each build points `wrangler deploy` at itself.

The deploy creates everything that pigy runs on but the bucket of the images, which the first command makes, once. This is what `apps/worker/wrangler.jsonc` asks for, line by line, and nothing else:

- The Worker `pigy`, with the compatibility flag `global_fetch_strictly_public` and its version as the binding `VERSION`, which `/api/health` answers with.
- The web app as the static assets of the Worker, bound as `ASSETS`. A path that has no file gets the app shell, and the paths under `/api/`, `/connect/`, `/sim/`, `/sync/` and `/assets/` go to the Worker first.
- A D1 database named `pigy`, bound as `DB`. It is empty until the migrations of `apps/worker/migrations` are applied, which is the last command.
- Two Durable Object classes with SQLite storage: `WorkspaceDO`, bound as `WORKSPACE`, and `SimWorldDO`, bound as `SIM_WORLD`.
- The workflow `pigy-publish`, of the class `PublishWorkflow`, bound as `PUBLISH`. Workflows are part of the Workers Paid plan as pigy uses them, section 1.
- A rate limiter, bound as `API_RATE_LIMITER`, which counts the requests of each key of the public API: 120 in 60 seconds. Its namespace is `1001`, a number of the account's own choosing that no other rate limiter of the account may use. To check, if the account has other Workers: that none of them binds a rate limiter with that number.
- A second one, bound as `POLICY_REPORT_LIMITER`, which counts the reports of the content security policy that each address sends: 20 requests in 60 seconds, namespace `1002`, which no other limiter of the account may use either.
- The R2 bucket `pigy-media`, bound as `MEDIA`: the images that people attach to their posts, as pigy keeps them, and their small pictures. It gets no public address and no custom domain: every byte of it is served by the Worker. A lifecycle rule of the bucket that aborts a multipart upload which is not complete after eight days is worth adding in its settings, `PLAN.md` section 19: pigy gives such an upload up after a week by itself and asks the bucket to drop its parts for eight days after that. The rule is for an upload that the bucket did not drop then: pigy stops asking, and says so in the log.
- Cloudflare Images, bound as `IMAGES`, which makes the small pictures and the smaller images that a network takes. It needs nothing set up, and is billed by the transformation.
- Workers Logs for what pigy writes, with the invocation logs and the traces off, section 9.

No KV namespace, no queue and no route of a zone: the configuration binds none.

Check:

- `curl https://<host>/api/health` answers `{"status":"ok","version":"…"}`.
- `wrangler d1 migrations list DB --remote` lists nothing left to apply.
- `wrangler r2 bucket list` names `pigy-media`.
- `https://<host>/` shows the sign-in page, which says that sign-in is not set up. That is the next step.

To check, because nobody has run it: that `wrangler d1 migrations apply DB --remote` finds the database without an ID in `wrangler.jsonc`. Wrangler 4.162 looks a database up by its name where the configuration has no ID. If yours asks for one, `wrangler d1 list` has it, and it goes into `d1_databases` of `apps/worker/wrangler.jsonc` as `database_id`.

## 4. The secrets

Each is set with `wrangler secret put <NAME>`, which asks for the value. A secret takes effect at once, without a deploy. `AGENTS.md`, "Deployment", says of each what pigy does without it.

Do them in this order: the first three are what it takes to sign in.

| Secret | Value |
| --- | --- |
| `ADMIN_EMAILS` | Your Google email address. Several are separated by commas. These people can always sign in, and are admins |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | The OAuth client of step 4.1 |
| `CREDENTIAL_KEYS` | `1:<key>`, where the key is the output of `openssl rand -base64 32` |
| `BLUESKY_CLIENT_KEYS` | `1:<key>`, where the key is the output of the `openssl` command below |
| `VAPID_PRIVATE_KEY` | The output of the same `openssl` command, by itself, without `1:` |
| `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET` | The application of step 4.2 |
| `THREADS_APP_ID`, `THREADS_APP_SECRET` | The app of step 4.3 |

The command for a key of Bluesky and for the VAPID key, run once for each:

```sh
openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 | openssl pkcs8 -topk8 -nocrypt -outform DER | openssl base64 -A
```

**Keep a copy of `CREDENTIAL_KEYS`, `BLUESKY_CLIENT_KEYS` and `VAPID_PRIVATE_KEY` somewhere safe**, such as a password manager. Cloudflare does not show a secret again. Without the first, every connected account has to be connected again. Without the second, every Bluesky account. Without the third, every device has to turn its notifications on again. `AGENTS.md` has how each is replaced: "Replace the key that seals credentials" and "Replace the key that pigy signs with as a client of Bluesky".

Check: `wrangler secret list` names all of them, and after the first three you can sign in at `https://<host>/` with the address of `ADMIN_EMAILS`.

### 4.1 The Google OAuth client

In the Google Cloud console, under APIs & Services:

1. Set up the OAuth consent screen, for external users, and publish it: "In production". In "Testing", only the test users that you list can sign in. pigy asks for the basic scopes, which need no review by Google.
2. Create credentials → OAuth client ID → Web application, with the authorized redirect address `https://<host>/api/auth/google/callback`.
3. The client ID and the client secret are the two secrets.

### 4.2 The LinkedIn application

`AGENTS.md`, "Deployment", the entry for `LINKEDIN_CLIENT_ID`, and `PLAN.md` section 18. In short: an application at https://www.linkedin.com/developers/apps, linked to a LinkedIn Page, with the products "Share on LinkedIn" and "Sign In with LinkedIn using OpenID Connect" and the redirect address `https://<host>/connect/linkedin/callback`, character by character.

### 4.3 The Threads app

`AGENTS.md`, "Deployment", the entry for `THREADS_APP_ID`, and `PLAN.md` section 18. In short: an app at https://developers.facebook.com/apps with the use case "Access the Threads API", its six permissions, and the redirect callback address `https://<host>/connect/threads/callback`. The two secrets are the Threads app ID and the Threads app secret of the use case, not those of the Meta app around it. Until Meta has reviewed the app, every person who posts to Threads has to be added as a Threads tester and accept the invitation in the settings of their Threads account. The fields for an uninstall and a delete callback address are entered as `AGENTS.md` says, and nothing answers at them yet.

## 5. Invite people

Sign in, and add addresses under Settings → Access. Somebody who is not invited sees a page that says that pigy is invite-only.

## 6. Deploying from CI

The CI workflow, `.github/workflows/ci.yml`, deploys what is pushed to `main` once every check has passed, and when it is started by hand on `main` ("Run workflow"). Until you switch that on it deploys nothing, and says so in the summary of its run.

To switch it on, in the settings of the repository on GitHub:

1. Environments → New environment, named `production`. Under "Deployment branches and tags", allow `main` alone. The secrets below are then out of reach of a pull request, which can change the workflow that it runs.
2. In that environment, add two secrets:
   - `CLOUDFLARE_ACCOUNT_ID`: the ID of your account, which `wrangler whoami` shows.
   - `CLOUDFLARE_API_TOKEN`: a token that you make in the Cloudflare dashboard under My Profile → API Tokens, from the template "Edit Cloudflare Workers", limited to your account, with "D1: Edit" added to it. To check, at the first run: that the template covers Workflows, the rate limiter, the R2 bucket and Images. If the deploy is refused for one of them, the token lacks a permission, and the error names it.
3. Secrets and variables → Actions → Variables → New repository variable: `DEPLOY`, with the value `true`.

Check: the next push to `main` has a job "deploy" that ends green, and `curl https://<host>/api/health` answers with a new `version`.

What the job does, in order: it asks GitHub whether its commit is still the newest of `main`, builds with `pnpm build`, checks that what `wrangler` would deploy is that build, applies the migrations of D1, and deploys. It does not set the secrets of the Worker: those are yours, section 4. One deploy runs at a time, and a run whose commit is no longer the newest of `main` deploys nothing: the run of the newer commit deploys it with that one, or, where that commit says `[no deploy]`, a deploy by hand does. A run that cannot get an answer from GitHub fails, and deploys nothing either: start it again with "Re-run jobs". The two secrets of the environment are handed to the two steps that call Cloudflare and to no other: the install of the dependencies, the build and the checks never see them.

Three things that the job cannot see for you, from `AGENTS.md`, "Deployment":

- **A change to the steps of the publishing workflow** is deployed when nothing is being sent, or it keeps the old names working for one deploy. The pull request of such a change says so. To merge it without deploying, put `[no deploy]` into the message of the merge commit, and deploy later by hand, with "Run workflow", at a moment when nothing is being sent. `[no deploy]` holds only until the next push to `main`: that push deploys everything up to its own commit, the change that waited among it. So deploy the change by hand before you merge anything else, or put `[no deploy]` into the next merge commit as well. Only the newest commit of a push is read for the marker: a push of several commits is held by the message of its last one.
- **A migration of D1 is applied before the code that needs it**, and stays applied if the deploy then fails. So a migration only adds what the code before it can ignore: `AGENTS.md`, "Change the database schema".
- **A new path prefix of the Worker** takes two releases: `AGENTS.md`, "A new path of the Worker".

## 7. After the first deploy: what to try

In this order. Each is something that only a deployed pigy can show.

1. Sign in with Google, on a desktop and on a phone. Sign out. Sign in with an address that is not invited, and see the invite-only page.
2. The sandbox: connect a simulated account of each network on the Channels screen, publish a post, and find it on the Simulator screen.
3. Switch to live. Connect one real account per network: Mastodon and Bluesky need nothing more, LinkedIn and Threads need steps 4.2 and 4.3. Bluesky cannot be tried before this point at all: it reads pigy's client metadata from `https://<host>/connect/bluesky/client-metadata.json`.
4. Publish a post to each, and a thread. Find them on the networks, and on the Sent screen. Attach a photo from a phone to a post for Mastodon and Bluesky, describe it, and find it there with its description and standing up as it was taken.
5. Schedule a post for a few minutes ahead, close the app, and see it go out.
6. Install pigy on a phone: from the menu of Chrome on Android, and with "Add to Home Screen" in Safari on iOS. Open it without a connection.
7. Turn "Notifications on this device" on in Settings, on the phone. In the sandbox, arm a failure on Simulator → Failures and publish: the phone shows a notification, and pressing it leads to the post.
8. Share a link from another app to pigy on Android.
9. Deploy a change, and see the phone take the new version the next time the app is started.
10. Look at the headers: `curl -sI https://<host>/` has `content-security-policy`, ending in `report-to csp; report-uri /api/policy-reports`, and `reporting-endpoints`, `curl -sI https://<host>/api/health` has `strict-transport-security`, and `curl -sI https://<host>/assets/nothing.js` answers 404 with `cache-control: no-store`. In the console of the browser, on any screen, no message names the content security policy.
11. Reports of the policy: on a screen of the app, in the console of Chrome and then of Firefox, run `document.head.append(Object.assign(document.createElement("script"), { textContent: "1" }))`. The console says that the policy refused it, and within two minutes Observability has a line of the kind `policy` with `blocked` `inline` and the path of the screen as `page`, one for each browser. `PLAN.md` section 19, "Hardening (phase 11b)", has why this has to be tried here: the browser of the tests never sent its report of the Reporting API.

## 8. What was never verified against the real services

pigy has not met a real Cloudflare, a real network or a real phone. `PLAN.md` section 19 has every assumption, by the phase that made it. Go through:

- "To confirm when the relevant phase starts": the Workflows service on a deployed Worker, and how a deploy spreads.
- The lists that begin "Open since phase 9" (push messages and phones), "Open since phase 3a" (Mastodon), "3c" (Bluesky), "3d" (LinkedIn) and "3e" (Threads), and "Scheduling (phase 5)".
- "Launch (phase 11a)": what this guide and the headers assume.

The live conformance run of each network confirms most of what its list has: `AGENTS.md`, "Run the conformance suite against a real network". It posts to a real account, so it takes an account that is there for the purpose.

## 9. Logs, alerts, and what to watch

pigy sets up no alerting service of its own: whoever runs it is told of errors by what Cloudflare offers for Workers Logs, which is set up by hand, below under "Being told". Look at the logs after a deploy as well, and when somebody says that something did not work.

**Where.** In the Cloudflare dashboard: Workers & Pages → pigy → Observability. Or live, in a terminal: `wrangler tail pigy`. Workers Logs keeps what it has for some days: the dashboard says how many on your plan.

**What is there.** Only what pigy writes itself: one line of JSON for everything that went wrong, from `apps/worker/src/log.ts`. Each line has:

- `level`: `error` is for you to look at, a bug or something that is not set up. `warn` is how something ended that pigy has dealt with, such as a network that refused an access: the person was told on a screen.
- `kind`: `request` (a route answered with a 500), `configuration` (a secret is missing or not valid), `sign-in`, `access`, `connection`, `renewal`, `stats`, `delivery`, `schedule`, `push`, `media` (the bucket or Images failed for an image), `sync`, `alarm`, `policy`. The table below says what each is.
- `message`, in words, and where it applies `route`, `step`, `workspaceId`, `channelId`, `targetId`, `postId`, `mediaId`, `network`, `host`, `status`, and for `policy` the fields of a report: `directive`, `blocked`, `page`, `disposition`, `count`.
- `error`: the error with its stack and the errors that caused it. Of anything else that an error carries, a line says only what kind of thing it is, such as `[object URLSearchParams]`: a library puts there what it compared, which can be the code of a callback or a token.

A line never holds a secret, the text of a post, or the address of a person. To check, in the dashboard: that the fields of a line can be filtered by. If they cannot, the lines are still searched as text.

**What to watch**, kind by kind. A query in the Query Builder of Observability is a filter on the fields of a line: `level = "error" AND kind = "delivery"`. To check: that the fields can be filtered by, which rests on Workers Logs reading a line of JSON that is logged as text, `PLAN.md` section 19. If they cannot, search the lines as text for `"kind":"delivery"` and `"level":"error"`, which is how they are written. Save each query that you use, with a name, so that it is one click the next time.

| `kind` | At `error` | At `warn` | Query |
| --- | --- | --- | --- |
| `request` | A route answered with a 500: a bug. `route` names it by its pattern | Never | `kind = "request"` |
| `configuration` | A secret is missing or not valid, and the message names it | Never | `kind = "configuration"` |
| `sign-in` | Google could not be reached, or answered what pigy did not expect | Somebody cancelled, took too long, or came back with a callback that is not theirs | `kind = "sign-in" AND level = "error"` |
| `access` | Never | A workspace was not told that it was frozen or thawed, or could not read whether it is: it makes up for it by itself. Many in a row are D1 in trouble | `kind = "access"` |
| `connection` | Connecting or disconnecting an account failed for a reason of pigy's own | A network refused, or the person declined | `kind = "connection" AND level = "error"` |
| `renewal` | An access could not be renewed for a reason of pigy's own. A Threads access that is not renewed for weeks ends | A network refused, and the account asks to be connected again | `kind = "renewal" AND level = "error"` |
| `stats` | The stats of a delivery could not be read or stored for a reason of pigy's own. The read is tried again later, and the Sent screen shows the counts read before | The access of a channel did not open to read the stats with | `kind = "stats" AND level = "error"` |
| `delivery` | The workflow of a delivery was not created, could not be asked how it is, or "ended without a word": one after a deploy is the deploy, several are not | A network refused a post: the person was told on the Sent screen | `kind = "delivery" AND level = "error"` |
| `schedule` | A due post was not taken up, or one that was put aside was not deleted: a bug | Never | `kind = "schedule"` |
| `push` | A push service did not take a message or did not answer, which costs that device that message, or the messages of a workspace were not sent. One now and then is a push service; many are a bug, or a key that the push services do not take | Never | `kind = "push"`, grouped by `host` |
| `media` | The bucket or Cloudflare Images failed for an image: an upload that was not taken in, the images of a delivery that could not be made ready, or what the alarm does with images by the clock, such as an upload that the bucket did not drop. One now and then is the platform; many are a bug | No small picture could be made of an image | `kind = "media" AND level = "error"` |
| `sync` | A mutation or a message failed: a bug | Never | `kind = "sync"` |
| `alarm` | A workspace could not set its alarm. Nothing is published or renewed in it until it is next used | Never | `kind = "alarm"` |
| `policy` | Never | The content security policy refused something on a page, as a browser reported it. Most are extensions of a browser, whose scheme `blocked` names. One of the app's own, `blocked = "inline"` or the address of pigy on a screen that everybody uses, is a bug | `kind = "policy"`, grouped by `directive`, `blocked` and `page` |

The query to look at every day, or to be told of: `level = "error"`, counted and grouped by `kind`, over the last 24 hours. Every line at `error` is worth a look.

And outside the log: the runs of the workflow, under Workers & Pages → Workflows → pigy-publish, for a run that is failed or stuck.

**Being told.** Not verified: nobody has done this on an account yet. As of late 2026 Cloudflare has custom alerts on the data of Workers, "Monitors", in beta, under Observability → Alerts: <https://developers.cloudflare.com/notifications/monitors/>. A monitor runs a query of the SQL API over a dataset of Workers events on a schedule, compares its result with a threshold, and sends an email, a webhook or a PagerDuty alert. The one to make:

1. Observability → Alerts → create a monitor, with the dataset of the events of Workers, for the Worker `pigy`.
2. A threshold monitor whose query counts the lines with `level` `error` in the window, as the column `value`, and that fires when it is above 0. Where the dataset has the fields of a line apart, that is a filter on `level`. Where it has the line as text, the filter is that the message contains `"level":"error"`. To check: which of the two it is, in the preview of the query, which charts up to seven days.
3. A window of an hour, so that a burst is one email and not sixty.
4. Delivered by email, to you.

A second monitor for `kind` `policy`, at a threshold of some tens a day, says when the refusals rise beyond the noise of extensions. Not needed at first.

To check, once made: that its preview shows the lines at `error` of the last days, if there are any, and that its email arrives. For the second, set the threshold to fire at 0 or more, which any window does, wait for the email, and set it back to above 0.

If Monitors are not there for the account, or not out of beta: save the query of the daily look and run it by hand. The budget alerts of Workers, which tell of what the account spends, are another thing and are on by themselves.

Do not use Logpush or a Tail Worker to send the logs to a service that alerts, unless that service is given the lines of pigy's log and nothing else: what Cloudflare pushes of a request has its address with its query, which holds the code of a callback, and the requests that the Worker makes, which hold the token of a Threads account: the next paragraph.

**What is off, and has to stay off.** `apps/worker/wrangler.jsonc`, `observability`:

- Traces. A trace records the requests that the Worker makes, and the token of a Threads account is in the address of every request that reads from Threads: `PLAN.md` section 16. Do not turn traces on, here or in the dashboard, and do not attach a Tail Worker or a Logpush job that records outbound requests.
- Invocation logs, which record every request that the Worker is called with. The callback of a sign-in and of a connection carries its code in its address. The configuration takes query strings out of whatever is recorded, so turning invocation logs on would record the path and the status of each request and no code. That is yours to decide. To check first: that the dashboard shows the address of a callback without its query, and no cookie.

## 10. Backups

What is known, and what to check. pigy has no backup of its own.

- **D1** holds who may sign in, the sessions, the push subscriptions and the registrations with Mastodon servers. Cloudflare keeps its history by itself, Time Travel: a database can be restored to any minute of the last 30 days on the paid plan, with `wrangler d1 time-travel restore pigy --timestamp=<time>`. To check: `wrangler d1 time-travel info pigy` answers with a bookmark. For a copy of your own: `wrangler d1 export pigy --remote --output=pigy.sql`. The file holds sealed secrets and the addresses of the people you invited: keep it as you keep the keys.
- **The workspaces** are the posts, the channels with their sealed credentials, the schedules and the inbox. Each is the SQLite database of a Durable Object. Cloudflare keeps 30 days of history for such a database, point-in-time recovery, but only the object itself can ask for it, from code: nothing in pigy does, and there is no command that restores or exports a workspace. So today a workspace that is damaged cannot be brought back by you. What softens that: a device that has opened a workspace holds a copy of its synced rows, and the posts that went out are on the networks. An export of a workspace, and a way to restore one, are `PLAN.md` section 21.
- **The images** are in the bucket `pigy-media`, under the IDs of their workspaces. pigy makes no copy of them, and deletes the bytes of an image by itself 30 days after its posts were sent, keeping its small picture. A post that went out has its images on the networks.
- **The secrets** are backed up by you: section 4. A restored database is worth nothing without the `CREDENTIAL_KEYS` that sealed what is in it.
- **The runs of the publishing workflow** are kept by Cloudflare for some days and are no data to back up: `AGENTS.md`, "Deployment".

## 11. A custom domain

`PLAN.md` section 20 has what moving to another address means. pigy takes its address from the request, so nothing in the code or the secrets changes, but `APP_URL` where you have set it, which nothing needs before Threads publishes images. In order:

1. Add the domain to the Worker: Workers & Pages → pigy → Settings → Domains & Routes → Custom domain.
2. Add `https://<new host>/api/auth/google/callback` to the Google client, `https://<new host>/connect/linkedin/callback` to the LinkedIn application and `https://<new host>/connect/threads/callback` to the Threads app, and keep the old ones until nobody uses the old address.
3. Bluesky channels are connected again, at the new address: pigy is another client of Bluesky there.
4. Each phone installs pigy again from the new address and turns its notifications on again there. The device signs in again, and its local copy starts empty: sync what it holds at the old address first.
5. A domain of your own is a zone of Cloudflare with settings of its own. Leave off what changes a page on its way to the browser: Rocket Loader, email address obfuscation and automatic rewrites of HTML. The content security policy allows the one script that is written into the page by the hash of its exact text, and a page that was changed loses it.

Check: steps 1, 3, 6 and 10 of section 7, at the new address.
