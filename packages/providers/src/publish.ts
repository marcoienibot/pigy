import type { PostContent } from "@pigy/core";
import { ProviderError } from "./errors.ts";
import type { Json, Provider, PublishProgress } from "./provider.ts";

/** Where a caller has the credentials of an account from. */
export type CredentialSource = {
  /**
   * The credentials of the account as they are now. They are asked for
   * every time a step is run, also when it is run again: a post can take
   * longer than credentials last, and a refresh replaces them.
   */
  credentials: () => Promise<Json>;
  /**
   * Renews the credentials now, because a call failed with `refresh`: the
   * network refused `refused`. Returns the credentials to make the call
   * again with. `Provider.refresh` has the rules: one refresh at a time
   * per account, and none if `refused` are no longer the stored
   * credentials. It fails as `Provider.refresh` does, with `reconnect`
   * when the network will not renew.
   *
   * A caller may count on what is returned being good for the call at
   * hand. It may not count on `credentials` returning the same from then
   * on. A source stores what a refresh returns before it hands it out,
   * and tries again where that fails, because on some networks a refresh
   * ends the credentials that it started from: what is not stored is
   * lost. A source that cannot store them returns them all the same, and
   * logs that. They are then good for this call and for no later one, and
   * the account may have to be connected again.
   */
  refresh: (refused: Json) => Promise<Json>;
};

/** What a post is published with. */
export type PublishJob = CredentialSource & {
  content: PostContent;
  /** See `PublishRequest.key`. */
  key: string;
};

/**
 * Calls a method of a provider with the credentials of `source`, and
 * returns what it returns.
 *
 * A call that fails with `refresh` is made a second time, with the
 * credentials that `source.refresh` returns. The network has refused the
 * first request, so nothing was done. If the network refuses those too,
 * nothing but a new connection helps: the call fails with `reconnect`.
 */
export async function withCredentials<Result>(
  source: CredentialSource,
  call: (credentials: Json) => Promise<Result>,
): Promise<Result> {
  const credentials = await source.credentials();
  try {
    return await call(credentials);
  } catch (error) {
    if (!(error instanceof ProviderError) || error.kind !== "refresh") {
      throw error;
    }
  }
  const renewed = await source.refresh(credentials);
  try {
    return await call(renewed);
  } catch (error) {
    if (error instanceof ProviderError && error.kind === "refresh") {
      // The network takes neither the old credentials nor the new.
      throw new ProviderError("reconnect", error.message, {
        status: error.status,
        cause: error,
      });
    }
    throw error;
  }
}

/**
 * How the steps of a post are run. In a Cloudflare Workflow these are
 * `step.do` and `step.sleep`, in a test plain functions.
 */
export type PublishRunner = {
  /**
   * Runs `step` and returns its result, once it is recorded under `name`.
   * It decides what happens when the step fails, by the kind of the
   * `ProviderError`: whether the step is run again, and after how long.
   * `Provider.publishStep` says what it has to keep to. A `refresh` never
   * gets this far: `publish` sees to it.
   *
   * A step can also fail with what is no `ProviderError`, which `publish`
   * passes on as it is: a bug, in pigy or in what the adapter was made
   * with. It has no kind to go by. The runner logs it, and the step is one
   * whose outcome is not known, like a step that was cut off.
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
 *
 * A step that fails with `refresh` is run a second time within the same
 * run of the runner, with the credentials that `job.refresh` returns:
 * `withCredentials` has the rule.
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
    const request = { content: job.content, key: job.key, progress };
    progress = await runner.run(`publish-${step}`, () =>
      withCredentials(job, (credentials) =>
        provider.publishStep({ ...request, credentials }),
      ),
    );
  }
  return progress;
}
