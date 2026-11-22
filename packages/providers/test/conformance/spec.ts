import {
  countCharacters,
  type Limits,
  limitsSchema,
  type PostContent,
  validateContent,
} from "@pigy/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  type CredentialSource,
  type Json,
  type Provider,
  ProviderError,
  type PublishProgress,
  type PublishRunner,
  publish,
  withCredentials,
} from "../../src/index.ts";
import { type Leftover, removeAll } from "./cleanup.ts";

/**
 * What every provider must do, whatever its network. It is written once
 * and run once per network: against the network's simulator in CI, and
 * against the real network by hand, see AGENTS.md. A network joins by
 * describing itself as a `Harness`.
 *
 * A live run does what can be done with one real account and no browser.
 * What takes a simulated world is skipped there: consenting, arming a
 * fault, moving the clock, counting what is published.
 */

/** What only a simulated network can do. */
export type Simulation = {
  /**
   * Answers the consent page at `url` for the test account and returns the
   * parameters that the network sends to the callback address.
   */
  consent(url: string, answer: "allow" | "deny"): Promise<URLSearchParams>;
  /**
   * Arms a fault for the next request that publishes or, with "connect",
   * for the next request that completes a connection once the network has
   * taken the code of the callback.
   */
  arm(
    kind:
      | "rate-limit"
      | "server-error"
      | "lost-response"
      | "token-revoked"
      | "token-expired",
    during?: "publish" | "connect",
  ): void;
  /** The texts of the posts in the world, oldest first. */
  published(): string[];
  /**
   * How many requests have asked the network to publish so far, whether or
   * not it did. Looking for a post is not among them.
   */
  publishRequests(): number;
  now(): Date;
  /** Moves the world's clock forward. */
  advance(milliseconds: number): void;
};

/** A provider and a test account to run it with. */
export type Harness = {
  provider: Provider;
  /** The callback address to connect with. */
  redirectUri: string;
  /** What a person types to say where the account lives, if the network asks. */
  identifier: string | undefined;
  /**
   * How the network publishes a thread: as a chain of replies, or with its
   * parts joined into one post. PLAN.md section 6 has it per network.
   */
  thread: "chain" | "joined";
  /**
   * Credentials of the test account that work. On a network whose access
   * is renewed, the tests renew them where the network asks, and use what
   * the refresh returned from then on: `accessOf`.
   */
  credentials: Json;
  /** Credentials of the right form that the network refuses. */
  refusedCredentials: Json;
  /**
   * Whether the network has a way to give an access back, so that
   * disconnecting ends it.
   */
  revokes: boolean;
  /**
   * True where the provider renews its access by the caller's timer
   * alone, and never fails with `refresh`: nothing that the network
   * refuses is cured by renewing. Threads renews a token only while the
   * token is good.
   */
  refreshOnlyByTimer?: boolean;
  /** The secrets in both, which no message may contain. */
  secrets: string[];
  /** Text that marks the posts of this run, and makes them unlike others. */
  tag: string;
  /** Waits between two steps: for real, or by moving a simulated clock. */
  sleep(seconds: number): Promise<void>;
  /** Undefined in a live run. */
  simulation: Simulation | undefined;
  /**
   * Hears of every refresh that a test makes, with what it returned. A
   * live run renews the credentials that it is given, and a network that
   * replaces the refresh token, as Bluesky does, ends the session when the
   * old one comes again: the next test has to begin with these.
   */
  renewed?(credentials: Json): void;
};

// Between two steps of a post, a workflow records the progress. This is
// what that does to it, and it must survive it.
const recorded = <Value>(value: Value): Value =>
  JSON.parse(JSON.stringify(value)) as Value;

const sources = new WeakMap<Harness, CredentialSource>();

/**
 * The credentials of the test account as a caller keeps them: what a
 * refresh returns takes the place of what it started from, and is used
 * from then on, also by whoever made the harness: `Harness.renewed`. A
 * network that renews by replacing the refresh token, as Bluesky does,
 * refuses the old one for good.
 */
export function accessOf(harness: Harness): CredentialSource {
  const known = sources.get(harness);
  if (known) return known;
  let current = harness.credentials;
  const source: CredentialSource = {
    credentials: async () => current,
    refresh: async (refused) => {
      // Another refresh has replaced them.
      if (refused !== current) return current;
      if (!harness.provider.refresh) {
        throw new Error(
          "A provider that cannot refresh has asked for a refresh",
        );
      }
      current = (await harness.provider.refresh(refused)).credentials;
      harness.renewed?.(current);
      return current;
    },
  };
  sources.set(harness, source);
  return source;
}

/** The error that `action` fails with, which must be a ProviderError. */
async function failure(action: () => Promise<unknown>): Promise<ProviderError> {
  try {
    await action();
  } catch (error) {
    if (error instanceof ProviderError) return error;
    throw error;
  }
  throw new Error("Expected a ProviderError, and nothing failed");
}

/** Fails unless `whole` holds every one of `parts`, in their order. */
function expectInOrder(whole: string, parts: string[]) {
  let from = 0;
  for (const part of parts) {
    const found = whole.indexOf(part, from);
    expect(found, `"${part}" after position ${from}`).toBeGreaterThanOrEqual(0);
    from = found + part.length;
  }
}

/**
 * What a provider does that cannot look for what it has sent, when it
 * cannot tell whether a post was published: it fails with `uncertain`, and
 * does not ask to try again. Only a provider that says so with
 * `repeatsSafely` may: one that can look has to.
 *
 * LinkedIn's is the first that gets here. The tests that call this fail
 * for an adapter of its kind that asks to try again instead, and so sends
 * a second time: its pull request has shown that.
 */
function expectUncertain(provider: Provider, error: unknown) {
  if (!(error instanceof ProviderError)) throw error;
  expect(error.kind).toBe("uncertain");
  expect(provider.repeatsSafely).toBe(false);
}

/**
 * Runs the specification for the provider that `setup` returns. `setup` is
 * called for every test: a simulated harness makes a new world each time,
 * so that tests cannot disturb each other.
 */
export function describeProvider(name: string, setup: () => Promise<Harness>) {
  describe(name, () => {
    // What the tests published, to delete afterwards. A live run must not
    // leave anything behind, and here the deleting is tested in CI too.
    const cleanup: Leftover[] = [];
    let keys = 0;

    /** Calls `call` with the credentials of the test account. */
    const withAccess = <Result>(
      harness: Harness,
      call: (credentials: Json) => Promise<Result>,
    ) => withCredentials(accessOf(harness), call);

    afterEach(() => removeAll(cleanup.splice(0)));

    /** The runner of a test: runs each step once and waits as told. */
    const runnerOf = (harness: Harness): PublishRunner => ({
      run: (_name, step) => step(),
      sleep: (_name, seconds) => harness.sleep(seconds),
    });

    /**
     * Publishes `texts` as the parts of one post and returns the progress.
     * Whatever gets published is deleted after the test, also when the
     * test fails halfway.
     */
    async function publishParts(
      harness: Harness,
      texts: string[],
      options: {
        runner?: PublishRunner;
        from?: PublishProgress | null;
        key?: string;
      } = {},
    ) {
      const { provider } = harness;
      const inner = options.runner ?? runnerOf(harness);
      const seen = new Set(options.from?.parts.map(({ id }) => id));
      const runner: PublishRunner = {
        sleep: inner.sleep,
        run: (stepName, step) =>
          inner.run(stepName, async () => {
            const progress = await step();
            for (const { id, url } of progress.parts) {
              if (seen.has(id)) continue;
              seen.add(id);
              cleanup.push({
                id,
                url,
                remove: () =>
                  withAccess(harness, (credentials) =>
                    provider.deletePost(credentials, id),
                  ),
              });
            }
            return progress;
          }),
      };
      const content: PostContent = { parts: texts.map((text) => ({ text })) };
      const key = options.key ?? `${harness.tag}-${++keys}`;
      const progress = await publish(
        provider,
        { ...accessOf(harness), content, key },
        runner,
        options.from ?? null,
      );
      return { progress, key, content };
    }

    /**
     * A runner for a workflow that does not give up: it runs a step again
     * for as long as the step asks it to, two hours later each time. That
     * is longer than any network remembers a request: Mastodon keeps a key
     * for an hour, LinkedIn tells a repeated post for ten minutes.
     */
    const patientRunner = (
      harness: Harness,
      simulation: Simulation,
      retried: (error: ProviderError) => void,
    ): PublishRunner => ({
      sleep: (_name, seconds) => harness.sleep(seconds),
      run: async (_name, step) => {
        // A provider that asks again and again must not hang the test.
        for (let run = 1; ; run++) {
          try {
            return await step();
          } catch (error) {
            if (!(error instanceof ProviderError)) throw error;
            if (error.kind !== "retry" || run === 10) throw error;
            simulation.advance(2 * 60 * 60 * 1000);
            retried(error);
          }
        }
      },
    });

    /**
     * A text that is `characters` long, as the network of `limits` counts.
     * It holds what networks count in ways of their own: a link, a mention
     * with a domain and an emoji made of several code points. The mention
     * is of nobody: its domain cannot exist.
     */
    function textOfLength(
      harness: Harness,
      limits: Limits,
      characters: number,
    ) {
      const start = `${harness.tag} https://example.com/a/rather/long/path?with=a&query=string @nobody@pigy.invalid \u{1F469}\u200D\u{1F680}`;
      const text = `${start} ${"a".repeat(characters - countCharacters(limits, start) - 1)}`;
      // The padding is plain letters, which every network counts as one
      // each. This makes sure of it.
      expect(countCharacters(limits, text)).toBe(characters);
      return text;
    }

    describe("connecting", () => {
      it("begins with an address to send the person to and a state to remember by", async () => {
        const { provider, redirectUri, identifier } = await setup();
        const first = await provider.beginConnect({ redirectUri, identifier });
        const second = await provider.beginConnect({ redirectUri, identifier });
        expect(new URL(first.url).protocol).toBe("https:");
        expect(first.state).not.toBe("");
        // The state must be unguessable, so it is new every time.
        expect(second.state).not.toBe(first.state);
        // The caller stores what it is given as JSON.
        expect(recorded(first.pending)).toEqual(first.pending);
      });

      it("refuses a callback for something it did not begin", async () => {
        const { provider } = await setup();
        const error = await failure(() =>
          provider.completeConnect({
            pending: { made: "up" },
            params: new URLSearchParams({ code: "code", state: "state" }),
          }),
        );
        expect(error.kind).toBe("fail");
      });

      it("connects the account that consented", async ({ skip }) => {
        const { provider, redirectUri, identifier, simulation } = await setup();
        if (!simulation) return skip("Consenting takes a browser");
        const start = await provider.beginConnect({ redirectUri, identifier });
        const { account, access } = await provider.completeConnect({
          pending: recorded(start.pending),
          params: await simulation.consent(start.url, "allow"),
        });

        expect(account.id).not.toBe("");
        expect(account.handle).not.toBe("");
        expect(account.name).not.toBe("");
        for (const url of [account.avatarUrl, account.profileUrl]) {
          // These end up in a page. Only HTTPS addresses may.
          if (url !== null) expect(new URL(url).protocol).toBe("https:");
        }
        expect(recorded(access.credentials)).toEqual(access.credentials);
        // Only a provider that can refresh says when to.
        expect(access.refreshAt !== null).toBe(provider.refresh !== undefined);
        // An end that is named is still to come: LinkedIn's is the first
        // access with one.
        if (access.expiresAt) {
          expect(access.expiresAt.getTime()).toBeGreaterThan(
            simulation.now().getTime(),
          );
        }
        // The credentials are good for the account.
        expect((await provider.limits(access.credentials)).network).toBe(
          provider.network,
        );
      });

      it("refuses a callback that carries another state", async ({ skip }) => {
        const { provider, redirectUri, identifier, simulation } = await setup();
        if (!simulation) return skip("Consenting takes a browser");
        const start = await provider.beginConnect({ redirectUri, identifier });
        const params = await simulation.consent(start.url, "allow");
        // What an attacker does who wants their own code redeemed in
        // somebody else's browser.
        params.set("state", "another");
        const error = await failure(() =>
          provider.completeConnect({ pending: start.pending, params }),
        );
        expect(error.kind).toBe("fail");
        // Nobody declined: the person consented, and the callback is not
        // theirs.
        expect(error.declined).toBe(false);
      });

      it("fails for good when the network fails while it connects", async ({
        skip,
      }) => {
        const { provider, redirectUri, identifier, simulation } = await setup();
        if (!simulation) return skip("Consenting takes a browser");
        const start = await provider.beginConnect({ redirectUri, identifier });
        const callback = {
          pending: start.pending,
          params: await simulation.consent(start.url, "allow"),
        };
        simulation.arm("server-error", "connect");
        // Not "retry", though the network may be fine a moment later: the
        // code of the callback is spent.
        expect(
          (await failure(() => provider.completeConnect(callback))).kind,
        ).toBe("fail");
        // Which is why a second call with the same callback cannot do
        // better, with nothing wrong on the network.
        expect(
          (await failure(() => provider.completeConnect(callback))).kind,
        ).toBe("fail");
      });

      it("says so when the person declined", async ({ skip }) => {
        const { provider, redirectUri, identifier, simulation } = await setup();
        if (!simulation) return skip("Consenting takes a browser");
        const start = await provider.beginConnect({ redirectUri, identifier });
        const error = await failure(async () =>
          provider.completeConnect({
            pending: start.pending,
            params: await simulation.consent(start.url, "deny"),
          }),
        );
        expect(error.kind).toBe("fail");
        // What lets a caller report a change of mind and not a failure.
        expect(error.declined).toBe(true);
      });
    });

    describe("limits and validation", () => {
      it("tells what the account may post", async () => {
        const { provider, credentials } = await setup();
        const limits = await provider.limits(credentials);
        expect(limitsSchema.parse(limits)).toEqual(limits);
        expect(limits.network).toBe(provider.network);
      });

      it("reports content that has no text", async () => {
        const { provider, credentials } = await setup();
        const limits = await provider.limits(credentials);
        expect(
          validateContent(limits, { parts: [{ text: "one" }, { text: " " }] }),
        ).toMatchObject([{ part: 1, code: "empty" }]);
      });

      it("counts like the network: the limit fits, one more does not", async () => {
        const harness = await setup();
        const limits = await harness.provider.limits(harness.credentials);
        const text = textOfLength(harness, limits, limits.maxCharacters);
        // Exactly the limit: nothing is wrong with it, and the network
        // takes it.
        expect(validateContent(limits, { parts: [{ text }] })).toEqual([]);
        const { progress } = await publishParts(harness, [text]);
        expect(progress.done).toBe(true);

        // One more: the validation reports it, and the network refuses it
        // if it is sent all the same. The two count alike.
        const longer = `${text}a`;
        expect(
          validateContent(limits, { parts: [{ text: longer }] }),
        ).toMatchObject([{ part: 0, code: "too_long" }]);
        const before = harness.simulation?.published();
        const error = await failure(() => publishParts(harness, [longer]));
        expect(error.kind).toBe("fail");
        expect(harness.simulation?.published()).toEqual(before);
      });
    });

    describe("publishing", () => {
      it("publishes a post of one part", async () => {
        const harness = await setup();
        const text = `${harness.tag} A post of one part, with a link: https://example.com/a?b=c`;
        const { progress } = await publishParts(harness, [text]);

        expect(progress).toMatchObject({ done: true, waitSeconds: 0 });
        expect(progress.parts).toHaveLength(1);
        const [part] = progress.parts;
        expect(part?.id).not.toBe("");
        if (part?.url) expect(new URL(part.url).protocol).toBe("https:");
        if (harness.simulation) {
          expect(harness.simulation.published()).toEqual([text]);
        }

        if (part && harness.provider.readPost) {
          const post = await harness.provider.readPost(
            harness.credentials,
            part.id,
          );
          expect(post).toMatchObject({ id: part.id, text, replyToId: null });
        }
      });

      it("publishes a thread in order, part by part", async () => {
        const harness = await setup();
        const texts = ["first", "second", "third"].map(
          (part) => `${harness.tag} The ${part} part of a thread`,
        );
        // Looks at the progress after every step, as a workflow that
        // reports it would.
        let last: PublishProgress | null = null;
        let steps = 0;
        const { progress } = await publishParts(harness, texts, {
          runner: {
            sleep: (_name, seconds) => harness.sleep(seconds),
            run: async (_name, step) => {
              const next = recorded(await step());
              // The progress is stored where a secret must not be, with
              // the adapter's own notes in it.
              for (const secret of harness.secrets) {
                expect(JSON.stringify(next)).not.toContain(secret);
              }
              // A part that was reported stays as it was reported.
              expect(next.parts.slice(0, last?.parts.length ?? 0)).toEqual(
                last?.parts ?? [],
              );
              if (harness.thread === "chain") {
                // One request that changes something per step: at most
                // one part more.
                expect(
                  next.parts.length - (last?.parts.length ?? 0),
                ).toBeLessThanOrEqual(1);
              }
              expect(next.done).toBe(next.parts.length === texts.length);
              // A provider that never finishes must not hang the test.
              expect(++steps).toBeLessThan(50);
              last = next;
              return next;
            },
          },
        });

        expect(progress.parts).toHaveLength(texts.length);
        const ids = progress.parts.map(({ id }) => id);
        const { readPost } = harness.provider;
        if (harness.thread === "chain") {
          expect(new Set(ids).size).toBe(texts.length);
          if (harness.simulation) {
            expect(harness.simulation.published()).toEqual(texts);
          }
          for (const [index, id] of ids.entries()) {
            if (!readPost) break;
            // Each part replies to the one before it.
            expect(await readPost(harness.credentials, id)).toMatchObject({
              text: texts[index],
              replyToId: index === 0 ? null : ids[index - 1],
            });
          }
        } else {
          // One post holds all the parts, as on LinkedIn. An adapter that
          // publishes the first part alone and returns its ID for every
          // part fails below, where the text is looked at.
          expect(new Set(ids).size).toBe(1);
          if (harness.simulation) {
            // The text is taken from the network's side, because a provider
            // that joins the parts may not be able to read a post back.
            const whole = harness.simulation.published();
            expect(whole).toHaveLength(1);
            expectInOrder(whole[0] ?? "", texts);
          }
          if (ids[0] && readPost) {
            const post = await readPost(harness.credentials, ids[0]);
            expectInOrder(post?.text ?? "", texts);
          }
        }
      });

      it("continues a thread from the recorded progress, and sends no part twice", async ({
        skip,
      }) => {
        const harness = await setup();
        if (harness.thread === "joined") {
          return skip("A joined thread is published whole or not at all");
        }
        const texts = ["first", "second"].map(
          (part) => `${harness.tag} The ${part} part of a thread that stops`,
        );
        // The first attempt stops as soon as a part is published, as if
        // the next step had failed for good.
        const key = `${harness.tag}-stopped`;
        const stop = new Error("stop");
        const records: PublishProgress[] = [];
        await expect(
          publishParts(harness, texts, {
            key,
            runner: {
              sleep: (_name, seconds) => harness.sleep(seconds),
              run: async (_name, step) => {
                if (records.at(-1)?.parts.length) throw stop;
                const progress = recorded(await step());
                records.push(progress);
                return progress;
              },
            },
          }),
        ).rejects.toBe(stop);
        const halfway = records.at(-1) ?? null;
        expect(halfway).toMatchObject({ done: false, parts: [{}] });

        // The second attempt comes when no network remembers the first any
        // more. Until then a network may answer a part that is sent again
        // with the post it has, which would hide that it was sent again.
        const { simulation } = harness;
        simulation?.advance(2 * 60 * 60 * 1000);
        const requestsBefore = simulation?.publishRequests() ?? 0;

        // It is given what was recorded.
        const { progress } = await publishParts(harness, texts, {
          key,
          from: halfway,
        });
        expect(progress.done).toBe(true);
        expect(progress.parts).toHaveLength(2);
        expect(progress.parts[0]).toEqual(halfway?.parts[0]);
        if (simulation) {
          expect(simulation.published()).toEqual(texts);
          // The network was asked for the second part and for nothing
          // else. A part that is recorded is not even looked for again.
          expect(simulation.publishRequests() - requestsBefore).toBe(1);
        }
      });

      it("publishes nothing twice when every step is run twice", async ({
        skip,
      }) => {
        const harness = await setup();
        // A provider that says so promises nothing for a step that is run
        // twice: its caller sees to it that none is. `publishStep` of the
        // contract, rule 3.
        if (!harness.provider.repeatsSafely) {
          return skip("The steps of this provider are never run twice");
        }
        const texts = ["first", "second"].map(
          (part) => `${harness.tag} The ${part} part of a thread, sent twice`,
        );
        const { progress } = await publishParts(harness, texts, {
          runner: {
            sleep: (_name, seconds) => harness.sleep(seconds),
            // What a workflow does when it cannot tell whether a step went
            // through: it runs the step again, with the same input.
            run: async (_name, step) => {
              const first = await step();
              const second = await step();
              // The second run finds what the first one published.
              expect(second.parts).toEqual(first.parts);
              return second;
            },
          },
        });
        expect(progress.done).toBe(true);
        if (harness.simulation) {
          expect(harness.simulation.published()).toHaveLength(
            harness.thread === "chain" ? texts.length : 1,
          );
        }
      });

      it("publishes nothing twice when an answer is lost and the step is run again hours later", async ({
        skip,
      }) => {
        const harness = await setup();
        const { simulation } = harness;
        if (!simulation) return skip("Losing an answer takes a simulation");
        const texts = ["first", "second"].map(
          (part) =>
            `${harness.tag} The ${part} part of a thread whose answers are lost`,
        );
        // The network carries out every request that publishes a post of
        // the thread, and the answer to each is lost.
        const posts = harness.thread === "chain" ? texts.length : 1;
        const errors: ProviderError[] = [];
        simulation.arm("lost-response");
        let progress: PublishProgress;
        try {
          ({ progress } = await publishParts(harness, texts, {
            runner: patientRunner(harness, simulation, (error) => {
              errors.push(error);
              // For the post after this one. The step that is run again now
              // has nothing to send, so it must leave this fault armed.
              if (errors.length < posts) simulation.arm("lost-response");
            }),
          }));
        } catch (error) {
          expectUncertain(harness.provider, error);
          expect(simulation.published()).toHaveLength(1);
          return;
        }
        // Each step that published failed once, in a way that asks for
        // another try.
        expect(errors).toHaveLength(posts);
        expect(progress.done).toBe(true);
        expect(progress.parts).toHaveLength(texts.length);
        // Every post is there once.
        if (harness.thread === "chain") {
          expect(simulation.published()).toEqual(texts);
        } else {
          expect(simulation.published()).toHaveLength(1);
        }
      });

      // What `tellsDeliveriesApart` promises, both ways: a delivery that
      // another has passed finds its own first part where it landed
      // unseen, and does not take the part of the other for its own where
      // it never arrived.
      // `it.for` and not `it.each`: it hands the test its context, which
      // has `skip`.
      it.for([
        ["finds its own first part, whose answer was lost,", "lost-response"],
        ["posts a first part that never arrived", "server-error"],
      ] as const)(
        "%s after another delivery has posted the same, where it says that it tells deliveries apart",
        async ([_name, fault], { skip }) => {
          const harness = await setup();
          const { simulation, provider } = harness;
          if (!simulation) return skip("Arming a fault takes a simulation");
          // A provider that does not tell deliveries apart is not asked
          // to: a caller has such a delivery begin anew, as the contract
          // says.
          if (!provider.tellsDeliveriesApart) {
            return skip("The provider does not tell deliveries apart");
          }
          const text = `${harness.tag} A first part that two deliveries share`;
          // The first delivery stops where a workflow gives up on a network
          // that asks to be tried again. What it recorded up to then is all
          // that is left of it.
          let kept: PublishProgress | null = null;
          const stopped = new Error("The workflow gave up");
          simulation.arm(fault);
          const first = publishParts(harness, [text], {
            key: `${harness.tag}-passed`,
            runner: {
              sleep: (_name, seconds) => harness.sleep(seconds),
              run: async (_name, step) => {
                try {
                  kept = recorded(await step());
                  return kept;
                } catch (error) {
                  if (!(error instanceof ProviderError)) throw error;
                  // The fault is what failed the step, and nothing else.
                  expect(error.kind).toBe("retry");
                  throw stopped;
                }
              },
            },
          });
          await expect(first).rejects.toBe(stopped);
          // The part is there if only the answer was lost.
          const landed = fault === "lost-response" ? [text] : [];
          expect(simulation.published()).toEqual(landed);

          // Another delivery to the account goes out whole meanwhile, with
          // the same text. Later, if only by a moment, as one delivery
          // after another is: a provider may name what it posts by the
          // time, as Bluesky's does with its record keys, and with the
          // clock stopped two deliveries can come by the same name, once
          // in a thousand runs.
          simulation.advance(1);
          const other = await publishParts(harness, [text]);
          expect(simulation.published()).toEqual([...landed, text]);

          // Hours later the first is taken up from what it recorded.
          simulation.advance(2 * 60 * 60 * 1000);
          const { progress } = await publishParts(harness, [text], {
            key: `${harness.tag}-passed`,
            from: kept,
          });
          expect(progress.done).toBe(true);
          // Each delivery has a post of its own, and there is no third: the
          // first did not take the post of the other for its part, and it
          // did not post again what its first run had posted.
          expect(progress.parts[0]?.id).not.toBe(other.progress.parts[0]?.id);
          expect(simulation.published()).toEqual([text, text]);
        },
      );

      it("publishes once what never arrived, also when an older post reads the same", async ({
        skip,
      }) => {
        const harness = await setup();
        const { simulation } = harness;
        if (!simulation) return skip("Arming a fault takes a simulation");
        const text = `${harness.tag} A post that is published again on purpose`;
        const older = await publishParts(harness, [text]);
        // Long enough for a network to take the second for a post of its
        // own and not for a repetition of the first.
        simulation.advance(24 * 60 * 60 * 1000);

        // The network fails before it publishes anything.
        simulation.arm("server-error");
        const errors: ProviderError[] = [];
        let progress: PublishProgress;
        try {
          ({ progress } = await publishParts(harness, [text], {
            runner: patientRunner(harness, simulation, (error) => {
              errors.push(error);
            }),
          }));
        } catch (error) {
          expectUncertain(harness.provider, error);
          expect(simulation.published()).toEqual([text]);
          return;
        }
        expect(errors).toHaveLength(1);
        expect(progress.done).toBe(true);
        // A second delivery is a second post. The step that was run again
        // found nothing of its own, and did not take the older post for it.
        expect(progress.parts[0]?.id).not.toBe(older.progress.parts[0]?.id);
        expect(simulation.published()).toEqual([text, text]);
      });
    });

    describe("reading and deleting", () => {
      it("deletes a post, and is fine with a post that is gone", async () => {
        const harness = await setup();
        const { provider, credentials, simulation } = harness;
        const { progress } = await publishParts(harness, [
          `${harness.tag} A post to delete`,
        ]);
        const id = progress.parts[0]?.id ?? "";

        await provider.deletePost(credentials, id);
        if (simulation) expect(simulation.published()).toEqual([]);
        if (provider.readPost) {
          expect(await provider.readPost(credentials, id)).toBeNull();
        }
        // Deleting is repeated when its answer was lost.
        await provider.deletePost(credentials, id);
      });
    });

    describe("errors", () => {
      const content: PostContent = { parts: [{ text: "Never published" }] };

      it("asks for a new connection when the network refuses the credentials", async () => {
        const harness = await setup();
        const { refusedCredentials, secrets } = harness;
        // All the way, with what a caller does about the refusal: a
        // provider whose access can be renewed asks for a refresh first,
        // which the network refuses too.
        const error = await failure(() =>
          publishParts({ ...harness, credentials: refusedCredentials }, [
            "Never published",
          ]),
        );
        expect(error.kind).toBe("reconnect");
        for (const secret of secrets)
          expect(error.message).not.toContain(secret);
        expect(harness.simulation?.published() ?? []).toEqual([]);
      });

      it("asks for a new connection when the stored credentials are not its own", async () => {
        const { provider } = await setup();
        const error = await failure(() =>
          provider.publishStep({
            credentials: { not: "credentials" },
            content,
            key: "key",
            progress: null,
          }),
        );
        expect(error.kind).toBe("reconnect");
      });

      it("asks to try again later when the network limits the requests", async ({
        skip,
      }) => {
        const harness = await setup();
        const { simulation } = harness;
        if (!simulation) return skip("Arming a fault takes a simulation");
        simulation.arm("rate-limit");
        const error = await failure(() => publishParts(harness, ["Too soon"]));
        expect(error.kind).toBe("retry");
        // If the network says when, it is a time to come.
        if (error.retryAt) {
          expect(error.retryAt.getTime()).toBeGreaterThan(
            simulation.now().getTime(),
          );
        }
        expect(simulation.published()).toEqual([]);
      });

      it("asks to try again when the network fails, or says that it cannot tell where it cannot look", async ({
        skip,
      }) => {
        const harness = await setup();
        const { simulation } = harness;
        if (!simulation) return skip("Arming a fault takes a simulation");
        simulation.arm("server-error");
        const error = await failure(() => publishParts(harness, ["Down"]));
        // A provider that can find out later whether the network published
        // before it failed asks to try again. One that cannot, as
        // LinkedIn's, must not: a network that fails says nothing of how
        // far it got, and a second request could be a second post.
        expect(error.kind).toBe(
          harness.provider.repeatsSafely ? "retry" : "uncertain",
        );
        expect(simulation.published()).toEqual([]);
      });

      it("asks for a new connection when the access was taken back", async ({
        skip,
      }) => {
        const harness = await setup();
        const { simulation, secrets } = harness;
        if (!simulation) return skip("Arming a fault takes a simulation");
        simulation.arm("token-revoked");
        // Not once, but from now on.
        for (let attempt = 0; attempt < 2; attempt++) {
          const error = await failure(() => publishParts(harness, ["Revoked"]));
          expect(error.kind).toBe("reconnect");
          for (const secret of secrets) {
            expect(error.message).not.toContain(secret);
          }
        }
        expect(simulation.published()).toEqual([]);
      });

      it("renews the access when the network refuses it before its time", async ({
        skip,
      }) => {
        const harness = await setup();
        const { provider, simulation } = harness;
        if (!simulation) return skip("Arming a fault takes a simulation");
        if (!provider.refresh) {
          return skip("The access to this network is not renewed");
        }
        if (harness.refreshOnlyByTimer) {
          return skip("The network renews no access that it refuses");
        }
        const text = `${harness.tag} A post after a token that ended early`;
        simulation.arm("token-expired");
        // The step that was refused renews the access and is made again
        // with the new one: nothing else asks the person.
        const { progress } = await publishParts(harness, [text]);
        expect(progress.done).toBe(true);
        expect(simulation.published()).toEqual([text]);
        // What the refresh returned is what the account is reached with now.
        expect(await accessOf(harness).credentials()).not.toEqual(
          harness.credentials,
        );
      });
    });

    describe("access over time", () => {
      it("keeps the access for as long as it said", async ({ skip }) => {
        const harness = await setup();
        const { provider, redirectUri, identifier, simulation } = harness;
        if (!simulation) return skip("Consenting takes a browser");
        const start = await provider.beginConnect({ redirectUri, identifier });
        const { access } = await provider.completeConnect({
          pending: start.pending,
          params: await simulation.consent(start.url, "allow"),
        });
        const text = `${harness.tag} A post made much later`;
        const publishWith = (credentials: Json) =>
          publishParts({ ...harness, credentials }, [text]);
        const day = 24 * 60 * 60 * 1000;

        // Three cases, for three kinds of access: Bluesky's and Threads'
        // are renewed, LinkedIn's ends, Mastodon's lasts. The first fails
        // for an adapter whose refresh returns credentials that do not
        // work, which the pull request for Bluesky has shown, and for one
        // whose refresh does not put the end off or comes too early for
        // the network, which the one for Threads has. The second fails
        // for an adapter that names an end which the network does not
        // keep, which the one for LinkedIn has.
        if (provider.refresh && access.refreshAt) {
          // Refreshed when it is due, the access goes on.
          simulation.advance(
            access.refreshAt.getTime() - simulation.now().getTime(),
          );
          const renewed = await provider.refresh(access.credentials);
          expect((await publishWith(renewed.credentials)).progress.done).toBe(
            true,
          );
          // Where the access has an end, the refresh came before it and
          // has put it off: past the end that was named first, what the
          // refresh returned is still good. Threads' is the first access
          // that is renewed and ends.
          if (access.expiresAt) {
            expect(access.refreshAt.getTime()).toBeLessThan(
              access.expiresAt.getTime(),
            );
            expect(renewed.expiresAt?.getTime()).toBeGreaterThan(
              access.expiresAt.getTime(),
            );
            await removeAll(cleanup.splice(0));
            simulation.advance(
              access.expiresAt.getTime() - simulation.now().getTime() + 60_000,
            );
            expect((await publishWith(renewed.credentials)).progress.done).toBe(
              true,
            );
          }
        } else if (access.expiresAt) {
          // Up to its end the access is good: an end that the network
          // reaches sooner is not the end.
          simulation.advance(
            access.expiresAt.getTime() - simulation.now().getTime() - 60_000,
          );
          expect((await publishWith(access.credentials)).progress.done).toBe(
            true,
          );
          // Deleted while the access is good: past its end nothing can,
          // the cleanup after the test included.
          await removeAll(cleanup.splice(0));
          // Past its end, the person has to connect again.
          simulation.advance(day);
          expect(
            (await failure(() => publishWith(access.credentials))).kind,
          ).toBe("reconnect");
        } else {
          // No end was named, so there is none.
          simulation.advance(365 * day);
          expect((await publishWith(access.credentials)).progress.done).toBe(
            true,
          );
        }
      });

      it("gives the access back when the account is disconnected", async ({
        skip,
      }) => {
        const harness = await setup();
        if (!harness.simulation) {
          return skip("It would end the access that the live run is given");
        }
        if (!harness.revokes) {
          // A network that has no way to take an access back: the
          // provider says so, which is what lets a caller tell the person
          // to end the access themselves. Threads' is the first, and its
          // pull request has shown that this fails for a provider that
          // says nothing.
          const refusal = await failure(() =>
            harness.provider.disconnect(harness.credentials),
          );
          expect(refusal.kind).toBe("fail");
          // And the access is as good as before.
          const text = `${harness.tag} A post after a disconnect`;
          expect((await publishParts(harness, [text])).progress.done).toBe(
            true,
          );
          return;
        }
        await harness.provider.disconnect(harness.credentials);
        const error = await failure(() => publishParts(harness, ["Gone"]));
        expect(error.kind).toBe("reconnect");
        expect(harness.simulation.published()).toEqual([]);
      });

      it("ends one connection and no other when it gives an access back, where it says that every connection has its own", async ({
        skip,
      }) => {
        const harness = await setup();
        const { provider, redirectUri, identifier, simulation } = harness;
        if (!simulation) return skip("Consenting takes a browser");
        if (!provider.accessPerConnection) {
          // A caller never gives back an access there that it has not
          // kept: the contract says so.
          return skip("Every connection of the account has the same access");
        }
        const connect = async () => {
          const start = await provider.beginConnect({
            redirectUri,
            identifier,
          });
          const { access } = await provider.completeConnect({
            pending: start.pending,
            params: await simulation.consent(start.url, "allow"),
          });
          return access.credentials;
        };
        // The same account, connected twice: a channel that is in use, and
        // a connection after it that the caller could not keep.
        const kept = await connect();
        const dropped = await connect();
        const publishWith = (credentials: Json, text: string) =>
          publishParts({ ...harness, credentials }, [`${harness.tag} ${text}`]);

        await provider.disconnect(dropped);

        if (harness.revokes) {
          const error = await failure(() => publishWith(dropped, "Gone"));
          expect(error.kind).toBe("reconnect");
        }
        // The connection from before goes on.
        expect((await publishWith(kept, "Still here")).progress.done).toBe(
          true,
        );
        expect(simulation.published()).toEqual([`${harness.tag} Still here`]);
      });
    });
  });
}
