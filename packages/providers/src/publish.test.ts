import { describe, expect, it } from "vitest";
import { ProviderError } from "./errors.ts";
import type { Provider, PublishProgress, PublishRequest } from "./provider.ts";
import { type PublishRunner, publish } from "./publish.ts";

const content = { parts: [{ text: "one" }, { text: "two" }] };
const job = {
  credentials: async () => ({ token: "t" }),
  content,
  key: "target-1",
};

/**
 * A provider that takes two steps per part, with a wait in between, the
 * way Threads prepares a post before it publishes it. Only `publishStep`
 * is there: it is all that `publish` uses.
 */
function twoStepProvider() {
  const requests: PublishRequest[] = [];
  const provider = {
    async publishStep(request: PublishRequest): Promise<PublishProgress> {
      requests.push(request);
      const parts = request.progress?.parts ?? [];
      if (request.progress?.state !== "prepared") {
        return { parts, done: false, waitSeconds: 30, state: "prepared" };
      }
      const published = [
        ...parts,
        { id: `post-${parts.length + 1}`, url: null },
      ];
      return {
        parts: published,
        done: published.length === request.content.parts.length,
        waitSeconds: 0,
        state: null,
      };
    },
  } as Provider;
  return { provider, requests };
}

/** A runner that runs every step once and notes what it was asked to do. */
function noting() {
  const log: string[] = [];
  const runner: PublishRunner = {
    run: async (name, step) => {
      log.push(name);
      return step();
    },
    sleep: async (name, seconds) => {
      log.push(`${name}: ${seconds}s`);
    },
  };
  return { log, runner };
}

describe("publish", () => {
  it("runs the steps in order, and waits where a step says so", async () => {
    const { provider } = twoStepProvider();
    const { log, runner } = noting();
    const progress = await publish(provider, job, runner);
    expect(progress).toEqual({
      parts: [
        { id: "post-1", url: null },
        { id: "post-2", url: null },
      ],
      done: true,
      waitSeconds: 0,
      state: null,
    });
    expect(log).toEqual([
      "publish-1",
      "wait-2: 30s",
      "publish-2",
      "publish-3",
      "wait-4: 30s",
      "publish-4",
    ]);
  });

  it("gives every step the job and what the step before returned", async () => {
    const { provider, requests } = twoStepProvider();
    await publish(provider, job, noting().runner);
    expect(requests.map(({ progress }) => progress)).toEqual([
      null,
      { parts: [], done: false, waitSeconds: 30, state: "prepared" },
      {
        parts: [{ id: "post-1", url: null }],
        done: false,
        waitSeconds: 0,
        state: null,
      },
      {
        parts: [{ id: "post-1", url: null }],
        done: false,
        waitSeconds: 30,
        state: "prepared",
      },
    ]);
    for (const request of requests) {
      expect(request).toMatchObject({
        credentials: { token: "t" },
        content,
        key: "target-1",
      });
    }
  });

  it("asks for the credentials every time a step is run", async () => {
    // Credentials are refreshed while a post is on its way, and a step
    // that is run again must not use the ones that have been replaced.
    const { provider, requests } = twoStepProvider();
    let issued = 0;
    await publish(
      provider,
      { ...job, credentials: async () => ({ token: `t${++issued}` }) },
      {
        // Runs the first step twice, as after a failure.
        run: async (name, step) => {
          if (name === "publish-1") await step();
          return step();
        },
        sleep: async () => {},
      },
    );
    expect(requests.map(({ credentials }) => credentials)).toEqual([
      { token: "t1" },
      { token: "t2" },
      { token: "t3" },
      { token: "t4" },
      { token: "t5" },
    ]);
  });

  it("uses what the runner returns, not what the step returned", async () => {
    // A workflow hands back the recorded result of a step. On a replay the
    // step itself is not run at all.
    const { provider, requests } = twoStepProvider();
    const final: PublishProgress = {
      parts: [
        { id: "recorded-1", url: null },
        { id: "recorded-2", url: null },
      ],
      done: true,
      waitSeconds: 0,
      state: null,
    };
    const progress = await publish(provider, job, {
      run: async () => final,
      sleep: async () => {},
    });
    expect(progress).toBe(final);
    expect(requests).toEqual([]);
  });

  it("starts from the progress of an earlier attempt", async () => {
    const { provider, requests } = twoStepProvider();
    const { log, runner } = noting();
    const from: PublishProgress = {
      parts: [{ id: "post-1", url: null }],
      done: false,
      waitSeconds: 0,
      state: null,
    };
    const progress = await publish(provider, job, runner, from);
    expect(progress.parts.map(({ id }) => id)).toEqual(["post-1", "post-2"]);
    expect(requests[0]?.progress).toBe(from);
    expect(log).toEqual(["publish-1", "wait-2: 30s", "publish-2"]);
  });

  it("waits first when the earlier attempt stopped before a wait", async () => {
    const { provider } = twoStepProvider();
    const { log, runner } = noting();
    await publish(provider, job, runner, {
      parts: [{ id: "post-1", url: null }],
      done: false,
      waitSeconds: 30,
      state: "prepared",
    });
    expect(log).toEqual(["wait-1: 30s", "publish-1"]);
  });

  it("runs nothing when everything is published", async () => {
    const { provider, requests } = twoStepProvider();
    const { log, runner } = noting();
    const from: PublishProgress = {
      parts: [
        { id: "post-1", url: null },
        { id: "post-2", url: null },
      ],
      done: true,
      waitSeconds: 0,
      state: null,
    };
    expect(await publish(provider, job, runner, from)).toBe(from);
    expect(requests).toEqual([]);
    expect(log).toEqual([]);
  });

  it("stops at a step that fails, and leaves the rest to the runner", async () => {
    const { provider, requests } = twoStepProvider();
    const failure = new ProviderError("fail", "No");
    let steps = 0;
    await expect(
      publish(provider, job, {
        run: async (_name, step) => {
          if (++steps === 3) throw failure;
          return step();
        },
        sleep: async () => {},
      }),
    ).rejects.toBe(failure);
    // Two steps ran, and none after the one that failed.
    expect(requests).toHaveLength(2);
  });
});
