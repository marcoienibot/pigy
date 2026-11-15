import type { PostContent } from "@pigy/core";
import type { Json, Provider, PublishProgress } from "./provider.ts";

/** What a post is published with. The same for all of its steps. */
export type PublishJob = {
  credentials: Json;
  content: PostContent;
  /** See `PublishRequest.key`. */
  key: string;
};

/**
 * How the steps of a post are run. In a Cloudflare Workflow these are
 * `step.do` and `step.sleep`, in a test plain functions.
 */
export type PublishRunner = {
  /**
   * Runs `step` and returns its result, once it is recorded under `name`.
   * It decides what happens when the step fails: whether it is run again,
   * and after how long.
   */
  run: (
    name: string,
    step: () => Promise<PublishProgress>,
  ) => Promise<PublishProgress>;
  /** Waits for `seconds`. */
  sleep: (name: string, seconds: number) => Promise<void>;
};

/**
 * Publishes a post, step by step, and returns the final progress: every
 * part with its ID on the network.
 *
 * `from` is the progress of an earlier attempt that stopped halfway. The
 * parts it lists are not sent again.
 *
 * The names passed to the runner are the same for the same position in the
 * sequence of steps, which is what a workflow goes by when it replays.
 */
export async function publish(
  provider: Provider,
  job: PublishJob,
  runner: PublishRunner,
  from: PublishProgress | null = null,
): Promise<PublishProgress> {
  let progress = from;
  for (let step = 1; !progress?.done; step++) {
    if (progress && progress.waitSeconds > 0) {
      await runner.sleep(`wait-${step}`, progress.waitSeconds);
    }
    const before = progress;
    progress = await runner.run(`publish-${step}`, () =>
      provider.publishStep({ ...job, progress: before }),
    );
  }
  return progress;
}
