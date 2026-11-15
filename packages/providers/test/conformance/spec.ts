import {
  countCharacters,
  type Limits,
  limitsSchema,
  type PostContent,
  validateContent,
} from "@pigy/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  type Json,
  type Provider,
  ProviderError,
  type PublishProgress,
  type PublishRunner,
  publish,
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
  /** Arms a fault for the next request that publishes. */
  arm(
    kind: "rate-limit" | "server-error" | "lost-response" | "token-revoked",
  ): void;
  /** The texts of the posts in the world, oldest first. */
  published(): string[];
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
  /** Credentials of the test account that work. */
  credentials: Json;
  /** Credentials of the right form that the network refuses. */
  refusedCredentials: Json;
  /**
   * Whether the network has a way to give an access back, so that
   * disconnecting ends it.
   */
  revokes: boolean;
  /** The secrets in both, which no message may contain. */
  secrets: string[];
  /** Text that marks the posts of this run, and makes them unlike others. */
  tag: string;
  /** Waits between two steps: for real, or by moving a simulated clock. */
  sleep(seconds: number): Promise<void>;
  /** Undefined in a live run. */
  simulation: Simulation | undefined;
};

// Between two steps of a post, a workflow records the progress. This is
// what that does to it, and it must survive it.
const recorded = <Value>(value: Value): Value =>
  JSON.parse(JSON.stringify(value)) as Value;

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
      const { provider, credentials } = harness;
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
                remove: () => provider.deletePost(credentials, id),
              });
            }
            return progress;
          }),
      };
      const content: PostContent = { parts: texts.map((text) => ({ text })) };
      const key = options.key ?? `${harness.tag}-${++keys}`;
      const progress = await publish(
        provider,
        { credentials: async () => credentials, content, key },
        runner,
        options.from ?? null,
      );
      return { progress, key, content };
    }

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
          // One post holds all the parts.
          expect(new Set(ids).size).toBe(1);
          if (harness.simulation) {
            expect(harness.simulation.published()).toHaveLength(1);
          }
          const post =
            ids[0] && readPost
              ? await readPost(harness.credentials, ids[0])
              : null;
          let position = -1;
          for (const text of post ? texts : []) {
            const found = post?.text.indexOf(text, position + 1) ?? -1;
            expect(found).toBeGreaterThan(position);
            position = found;
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

        // The second attempt is given what was recorded.
        const { progress } = await publishParts(harness, texts, {
          key,
          from: halfway,
        });
        expect(progress.done).toBe(true);
        expect(progress.parts).toHaveLength(2);
        expect(progress.parts[0]).toEqual(halfway?.parts[0]);
        if (harness.simulation) {
          expect(harness.simulation.published()).toEqual(texts);
        }
      });

      it("publishes nothing twice when every step is run twice", async () => {
        const harness = await setup();
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

      it("publishes nothing twice when the answer to a step is lost", async ({
        skip,
      }) => {
        const harness = await setup();
        const { simulation } = harness;
        if (!simulation) return skip("Losing an answer takes a simulation");
        const text = `${harness.tag} A post whose first answer is lost`;
        simulation.arm("lost-response");
        const errors: ProviderError[] = [];
        const { progress } = await publishParts(harness, [text], {
          runner: {
            sleep: (_name, seconds) => harness.sleep(seconds),
            run: async (_name, step) => {
              for (;;) {
                try {
                  return await step();
                } catch (error) {
                  if (!(error instanceof ProviderError)) throw error;
                  if (error.kind !== "retry") throw error;
                  errors.push(error);
                }
              }
            },
          },
        });
        // The step failed once, in a way that asks for another try.
        expect(errors).toHaveLength(1);
        expect(progress.done).toBe(true);
        // The network carried out both requests and has one post.
        expect(simulation.published()).toEqual([text]);
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
        const { provider, refusedCredentials, secrets, tag } = await setup();
        const error = await failure(() =>
          provider.publishStep({
            credentials: refusedCredentials,
            content,
            key: `${tag}-refused`,
            progress: null,
          }),
        );
        expect(error.kind).toBe("reconnect");
        for (const secret of secrets)
          expect(error.message).not.toContain(secret);
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

      it("asks to try again when the network fails", async ({ skip }) => {
        const harness = await setup();
        const { simulation } = harness;
        if (!simulation) return skip("Arming a fault takes a simulation");
        simulation.arm("server-error");
        const error = await failure(() => publishParts(harness, ["Down"]));
        expect(error.kind).toBe("retry");
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

        if (provider.refresh && access.refreshAt) {
          // Refreshed when it is due, the access goes on.
          simulation.advance(
            access.refreshAt.getTime() - simulation.now().getTime(),
          );
          const renewed = await provider.refresh(access.credentials);
          expect((await publishWith(renewed.credentials)).progress.done).toBe(
            true,
          );
        } else if (access.expiresAt) {
          // Past its end, the person has to connect again.
          simulation.advance(
            access.expiresAt.getTime() - simulation.now().getTime() + day,
          );
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
        await harness.provider.disconnect(harness.credentials);
        if (!harness.revokes) return;
        const error = await failure(() => publishParts(harness, ["Gone"]));
        expect(error.kind).toBe("reconnect");
        expect(harness.simulation.published()).toEqual([]);
      });
    });
  });
}
