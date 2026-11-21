import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import {
  channelLimits,
  type MutatorArgs,
  type Network,
  type PostContent,
  targetLimits,
  uuidv7,
  validateContent,
} from "@pigy/core";
import {
  type CredentialSource,
  type Provider,
  ProviderError,
  type PublishProgress,
  publish,
  publishProgressSchema,
  withCredentials,
} from "@pigy/providers";
import { openCredentials, sealCredentials } from "../channels/credentials.ts";
import type { AppDependencies, Bindings } from "../env.ts";
import { loggable } from "../errors.ts";
import { blueskyKeysWithoutRequest } from "../network/bluesky-client.ts";
import type { providerOf } from "../network/providers.ts";
import type { Reach } from "../network/reach.ts";
import { clipped } from "../text.ts";
import { type Vault, VaultError, vaultWithoutRequest } from "../vault.ts";
import {
  aboutToSend,
  channelAccess,
  deliveryOf,
  mutateWorkspace,
  recordProgress,
  renewChannelAccess,
  stepBegins,
} from "../workspace/workspaces.ts";
import {
  cutOffMessage,
  type DeliveryParams,
  deliveryParamsSchema,
  lostTrackMessage,
} from "./delivery.ts";
import { retryWaitSeconds } from "./retry.ts";

/**
 * The publishing workflow: one run carries one attempt at the delivery of a
 * post to one channel. The Durable Object of the workspace starts it when
 * the turn of the delivery has come, and hears from it how far it gets.
 * PLAN.md section 8 has the design.
 *
 * A run is a sequence of durable steps:
 *
 * 1. `prepare` asks the workspace what to publish, brings the limits of
 *    the account up to date and checks the post against them.
 * 2. `about-to-send` tells the workspace that the delivery has passed its
 *    checks and will ask the network to publish. From then on the other
 *    deliveries to the channel that have published nothing begin anew when
 *    they are tried again: see `aboutToSend` in src/workspace/store.ts. A
 *    delivery that has nothing left to send skips this step, and so does
 *    one to a network whose adapter tells the deliveries to an account
 *    apart, `tellsDeliveriesApart` of the contract: what the others have
 *    recorded stays good there.
 * 3. `publish` of @pigy/providers drives the adapter of the network: each
 *    of its steps is a step here, `publish-1`, `publish-2` and so on, with
 *    at most one request that changes something on the network. After
 *    each, `record-publish-N` tells the workspace how far the post has
 *    come, so that clients see a thread go out part by part, and so that a
 *    later attempt goes on from there. Where the adapter cannot run a
 *    step again safely, `repeatsSafely` of the contract, as LinkedIn's,
 *    each of these steps first tells the workspace that it begins, and
 *    does not call the adapter if a run of the same step began before:
 *    see `sendingOnce` below.
 * 4. `end` tells the workspace how the delivery ended.
 *
 * What the platform stores of a run is to be taken for readable: what the
 * run was started with, and what each step returned. Neither holds a
 * secret. The credentials of the channel are asked of the workspace inside
 * the step that calls the adapter, opened there, and gone with it.
 */

/** What the workflow takes from outside instead of from globals. */
export type PublishDependencies = Pick<
  AppDependencies,
  "fetch" | "now" | "developmentCredentialKeys" | "developmentBlueskyClientKeys"
> & {
  /** Makes the adapter of a network for a workspace. */
  providerOf: typeof providerOf;
  /**
   * Waits for so many milliseconds, within a step: for a moment in which
   * the workspace cannot be told what has to reach it.
   */
  pause: (milliseconds: number) => Promise<void>;
};

/**
 * How old the limits of a channel may be before a delivery asks the
 * network again, in milliseconds.
 */
export const limitsLifetimeMs = 24 * 60 * 60 * 1000;

/**
 * How long a step waits before it hands renewed credentials to a workspace
 * again that did not take them, in milliseconds: once per entry. The
 * workspace is in the way of a deploy for a moment at most, and a step has
 * minutes.
 */
export const renewalWaitsMs = [1000, 5000, 15_000];

/**
 * A try of a step that talks to a network. What goes wrong in it is its
 * result, so the platform runs it again only when it was cut off: its time
 * was up, the Worker went away under it, or the workspace could not be
 * asked for what it needs. It waits before it does, because the run before
 * has to be over. The time is far more than a step takes: an adapter gives
 * up on a request after half a minute.
 */
const networkStep = {
  retries: { limit: 3, delay: "1 minute", backoff: "exponential" },
  timeout: "5 minutes",
} as const;

/**
 * A step that tells the workspace something. It is safe to repeat, and it
 * is repeated for hours: the workspace is in the way of a deploy for a
 * moment at most, and what a step has published must not go unrecorded.
 */
const bookkeepingStep = {
  retries: { limit: 10, delay: "10 seconds", backoff: "exponential" },
  timeout: "1 minute",
} as const;

/** Why a try of a step did not return what it was to return. */
type Failure =
  /**
   * The network asks to try again. `waitSeconds` is how far away the time
   * is that it named, or null if it named none.
   */
  | { kind: "retry"; message: string; waitSeconds: number | null }
  /** Trying again would fail again. The message is for the person. */
  | { kind: "fail"; message: string }
  /**
   * The network no longer takes the access of the channel. `connection`
   * says which access: the time at which the account was connected, as
   * the workspace had it when the step asked for the credentials, or null
   * if the step had not asked.
   */
  | { kind: "reconnect"; message: string; connection: number | null }
  /** A part may or may not be published. A person has to look. */
  | { kind: "uncertain"; message: string }
  /** The delivery is not this run's any more: it was ended otherwise. */
  | { kind: "superseded" }
  /** Something went wrong that is pigy's own. It is in the log. */
  | { kind: "bug" };

/** What a try of a step returns: what it was to return, or why not. */
type Tried<Value> = { value: Value } | { failure: Failure };

/** Ends the run, in a step or between steps, with the reason. */
class Ended extends Error {
  constructor(
    readonly failure: Failure,
    /** How often the step that failed was run. */
    readonly tries = 1,
  ) {
    super(`The delivery ended: ${failure.kind}`);
  }
}

/**
 * The workspace could not be asked for something that a step needs before
 * it does anything. The step has done nothing then, and the platform runs
 * it again.
 */
class Unasked extends Error {
  constructor(cause: unknown) {
    super("The workspace could not be asked", { cause });
  }
}

/** The delivery was ended while this run was on its way. */
const superseded = () => new Ended({ kind: "superseded" });

/** Ends the delivery as failed, with a reason for the person. */
const refused = (message: string) => new Ended({ kind: "fail", message });

/** What `prepare` hands to the steps after it. */
type Prepared = {
  channel: { id: string; network: Network; accountId: string };
  content: PostContent;
  /** How far the attempts before this one have come. */
  progress: PublishProgress | null;
};

/** How a delivery ends: the arguments of `target.end`, without the target. */
type Ending =
  | { status: "sent" }
  | {
      status: "error" | "uncertain";
      error: string;
      refusedConnection: number | null;
    };

/** What a failure means for the delivery. Not asked for `superseded`. */
function endingOf(failure: Failure, tries: number): Ending {
  const reason = (message: string) =>
    clipped(message, targetLimits.errorLength) || lostTrackMessage;
  switch (failure.kind) {
    case "retry":
      return {
        status: "error",
        error: reason(
          tries > 1
            ? `${failure.message} pigy has tried ${tries} times.`
            : failure.message,
        ),
        refusedConnection: null,
      };
    case "fail":
      return {
        status: "error",
        error: reason(failure.message),
        refusedConnection: null,
      };
    case "reconnect":
      return {
        status: "error",
        error: reason(failure.message),
        refusedConnection: failure.connection,
      };
    case "uncertain":
      return {
        status: "uncertain",
        error: reason(failure.message),
        refusedConnection: null,
      };
    case "superseded":
    case "bug":
      return {
        status: "uncertain",
        error: lostTrackMessage,
        refusedConnection: null,
      };
  }
}

/**
 * What went wrong in a try of a step, from what it threw. Only what an
 * adapter reports is taken for the word of a network. Anything else is a
 * failure of pigy's: it is logged here, where the error still is what it
 * was, and nothing is known of how far the step got.
 *
 * `connection` names the access that the step used: the time at which the
 * account was connected, or null if the step did not ask for credentials.
 */
function failureOf(
  error: unknown,
  now: Date,
  connection: number | null,
): Failure {
  if (error instanceof Ended) return error.failure;
  if (error instanceof ProviderError) {
    const { message } = error;
    switch (error.kind) {
      case "retry":
        return {
          kind: "retry",
          message,
          waitSeconds: error.retryAt
            ? Math.max(
                0,
                Math.ceil((error.retryAt.getTime() - now.getTime()) / 1000),
              )
            : null,
        };
      case "fail":
        return { kind: "fail", message };
      // `withCredentials` has renewed the credentials by the time a
      // `refresh` gets here, and they are refused all the same.
      case "refresh":
      case "reconnect":
        return { kind: "reconnect", message, connection };
      case "uncertain":
        return { kind: "uncertain", message };
    }
  }
  if (error instanceof VaultError) {
    // Its message holds no secret. The credentials were sealed with a key
    // that is gone: a new connection stores new ones.
    console.warn(`The credentials of a channel did not open: ${error.message}`);
    return {
      kind: "reconnect",
      message:
        "pigy can no longer read the access that it was given to this account. Connect the account again.",
      connection,
    };
  }
  console.error("A step of a delivery failed", loggable(error));
  return { kind: "bug" };
}

/** A short text that stands for `value`: the same for the same JSON. */
async function digest(value: unknown): Promise<string> {
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return Array.from(new Uint8Array(hash).subarray(0, 12), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

/** The link to a published part that a client is given, if it has one. */
function linkOf({ publicUrl }: Reach, url: string | null): string | null {
  const link = publicUrl(url);
  return link?.startsWith("https://") && link.length <= channelLimits.urlLength
    ? link
    : null;
}

/**
 * Carries the delivery that `params` names, with the steps of `step`, and
 * tells the workspace how it ended, unless the delivery was ended while it
 * was on its way.
 *
 * It throws what the platform throws into it: a step that failed for good
 * although nothing in it fails as a step, or a run that is being stopped.
 * The run then ends without a word to the workspace, which is what the
 * object of the workspace watches for.
 */
export async function deliver(
  {
    fetch,
    now,
    developmentCredentialKeys,
    developmentBlueskyClientKeys,
    providerOf,
    pause,
  }: PublishDependencies,
  env: Bindings,
  { workspace, targetId, attempt }: DeliveryParams,
  /** The ID of the run, which the workspace gave it: its own alone. */
  runId: string,
  step: WorkflowStep,
): Promise<void> {
  const run = { targetId, attempt };
  /**
   * What names a call of this run to the workspace, which carries a call
   * out once per key: a step that is run again repeats its call, and a
   * call that was given up on can still arrive after the ones that
   * followed it.
   *
   * The key is made of the run, the call and what the call says. The name
   * of a step is not enough: somebody can restart a run, which then begins
   * again at its first step with what the workspace has recorded since. A
   * step of the same name then says something else, and must not be taken
   * for a repeat.
   */
  const key = async (call: string, says: unknown) =>
    `${runId}/${call}/${await digest(says)}`;
  const vault = vaultWithoutRequest(env, developmentCredentialKeys);
  /**
   * The connection whose credentials the step that is running has asked
   * the workspace for last: the time at which the account was connected.
   * A step that the network refuses says which connection was refused,
   * because its word can reach the workspace after the person has
   * connected the account again, and must not count against that.
   */
  let connection: number | null = null;

  /**
   * The step that is running, by its name, and a mark that this run of it
   * has made up for itself: what `sendingOnce` tells a second run of a
   * step by.
   */
  let running = { name: "", mark: "" };

  /** Asks the workspace for what a step needs before it does anything. */
  const asked = async <Answer>(call: () => Promise<Answer>) => {
    try {
      return await call();
    } catch (cause) {
      throw new Unasked(cause);
    }
  };

  /** The adapter of a network, with how the workspace reaches it. */
  const adapterOf = (network: Network) => {
    if (!vault) {
      throw refused(
        "This pigy cannot read the access to its accounts: its keys are missing.",
      );
    }
    const connection = providerOf(network, workspace, {
      env,
      fetch,
      now,
      vault,
      // Renewing an access is signed with them.
      blueskyClientKeys: blueskyKeysWithoutRequest(
        env,
        developmentBlueskyClientKeys,
      ),
    });
    if (!connection) throw refused(`pigy cannot post to ${network} yet.`);
    return { ...connection, vault };
  };

  /**
   * The credentials of a channel, for the steps of this run: asked of the
   * workspace every time, opened where the adapter is called, and renewed
   * when the network says so.
   *
   * One refresh at a time per channel: the deliveries to a channel run
   * one after the other, and nothing else refreshes. A refresh also starts
   * only from the credentials that the workspace holds, and what it
   * returns is stored only in their place.
   */
  const accessOf = (
    channel: Prepared["channel"],
    provider: Provider,
    channelVault: Vault,
  ): CredentialSource => {
    // The sealed text that the credentials of the step were opened from.
    let opened: string | null = null;
    const stored = async () => {
      const access = await asked(() =>
        channelAccess(env.WORKSPACE, workspace, channel.id),
      );
      // Disconnected, which has ended the delivery.
      if (!access) throw superseded();
      connection = access.connectedAt;
      return access;
    };
    const credentials = async () => {
      const access = await stored();
      const open = await openCredentials(
        channelVault,
        workspace,
        access,
        access.credentials,
      );
      opened = access.credentials;
      return open;
    };
    return {
      credentials,
      async refresh(refusedCredentials) {
        const access = await stored();
        // Another refresh has replaced the credentials that the network
        // refused. The ones that are stored now are used as they are.
        if (access.credentials === null || access.credentials !== opened) {
          return credentials();
        }
        if (!provider.refresh) {
          throw new ProviderError(
            "reconnect",
            "The access to this account cannot be renewed. Connect the account again.",
          );
        }
        const renewed = await provider.refresh(refusedCredentials);
        // From here on the credentials that the channel holds may be
        // worth nothing: on some networks a refresh ends the ones it
        // started from. If the new ones do not get into the workspace,
        // the next step reads the old ones, cannot renew them a second
        // time, and the account has to be connected again. So a
        // workspace that does not take them is handed them again, a few
        // times: the same sealed text, and no second refresh.
        let kept: boolean;
        try {
          const sealed = {
            credentials: await sealCredentials(
              channelVault,
              workspace,
              access,
              renewed.credentials,
            ),
            refreshAt: renewed.refreshAt?.getTime() ?? null,
            expiresAt: renewed.expiresAt?.getTime() ?? null,
          };
          for (let tries = 0; ; tries++) {
            try {
              kept = await renewChannelAccess(
                env.WORKSPACE,
                workspace,
                channel.id,
                access.credentials,
                sealed,
              );
              break;
            } catch (error) {
              const wait = renewalWaitsMs[tries];
              if (wait === undefined) throw error;
              // A try that failed may have stored them all the same,
              // with only its answer lost. The next one then finds them
              // in the place of the ones it expects and is answered as
              // not kept, and what the channel holds is read below.
              await pause(wait);
            }
          }
        } catch (error) {
          // Given up. Ending the step here would have it run again with
          // the old credentials. It goes on with what it has, which may
          // be the last that anybody gets out of this access, and the
          // log says what was lost, without anything of it.
          console.error(
            "The renewed credentials of a channel were not stored",
            loggable(error),
          );
          return renewed.credentials;
        }
        // Not kept: the channel holds others by now, or is gone, and the
        // step goes on with what it holds. That is asked outside of what
        // is caught above: a workspace that cannot be asked is no reason
        // to go on with credentials that the channel does not hold. The
        // step fails then, and is run again.
        return kept ? renewed.credentials : credentials();
      },
    };
  };

  /**
   * Runs `body` as a step, and again as a step of its own while the
   * network asks for that and retry.ts goes along. Returns what `body`
   * returns, and throws `Ended` with what went wrong otherwise.
   *
   * A try never fails as a step: what goes wrong in it is what the step
   * returns. An error that is thrown out of a step reaches the workflow
   * as a message without its kind, and the platform would run the step
   * again on its own schedule, whatever the network said.
   */
  const tried = async <Value>(
    name: string,
    body: () => Promise<Value>,
  ): Promise<Value> => {
    for (let tries = 1; ; tries++) {
      const stepName = tries === 1 ? name : `${name}-try-${tries}`;
      const attemptStep = async (): Promise<Tried<Value>> => {
        // Of this try alone: what a step before it asked for is not what
        // this one was refused with.
        connection = null;
        running = { name: stepName, mark: crypto.randomUUID() };
        try {
          return { value: await body() };
        } catch (error) {
          if (error instanceof Unasked) throw error;
          return { failure: failureOf(error, now(), connection) };
        }
      };
      // What a try returns is plain JSON: a `Prepared` or the progress of
      // an adapter. The type of `step.do` cannot follow a result whose
      // type is a parameter, so it is not asked to.
      const outcome = (await step.do(
        stepName,
        networkStep,
        attemptStep as () => Promise<never>,
      )) as Tried<Value>;
      if ("value" in outcome) return outcome.value;
      const { failure } = outcome;
      const wait =
        failure.kind === "retry"
          ? retryWaitSeconds(failure.waitSeconds, tries)
          : null;
      if (wait === null) throw new Ended(failure, tries);
      await step.sleep(`${name}-wait-${tries}`, wait * 1000);
    }
  };

  /**
   * `provider`, with a `publishStep` that is not called a second time for
   * the same step of a run, where the adapter cannot run a step again
   * safely: `repeatsSafely` of the contract, as LinkedIn's.
   *
   * A step of such an adapter that fails says so, with `uncertain` where
   * it cannot tell what became of its request. A step that is cut off
   * after its request went out says nothing: its time was up, or the
   * Worker went away under it. The platform then runs the step again, or
   * somebody restarts the run, and the adapter would send a second time
   * without ever having failed. So before the adapter is called, the
   * workspace notes that the step begins, with the mark of this run of
   * it. A run that finds the mark of another is the second, and ends the
   * delivery as `uncertain`: a person looks, and if they ask for another
   * try, that is a new run with notes of its own.
   *
   * The note is taken last, when the credentials are read and opened and
   * nothing but the adapter is left to call. It is keyed by the run and
   * the name of the step, and by nothing of what the step says, unlike
   * the other calls of a run: a run that is restarted must find what the
   * run before it noted.
   *
   * The price is a delivery that ends as `uncertain` without need, where
   * a step was cut off between the note and its request, or the answer of
   * the workspace was lost and the step is run again for that. Nothing
   * was posted then, and the person who looks finds that.
   */
  const sendingOnce = (provider: Provider): Provider =>
    provider.repeatsSafely
      ? provider
      : {
          ...provider,
          async publishStep(request) {
            const { name, mark } = running;
            const begun = await asked(() =>
              stepBegins(
                env.WORKSPACE,
                workspace,
                run,
                mark,
                `${runId}/begins/${name}`,
              ),
            );
            // Not under way any more: ended otherwise.
            if (!begun.ok) throw superseded();
            if (begun.by !== mark) {
              throw new Ended({ kind: "uncertain", message: cutOffMessage });
            }
            return provider.publishStep(request);
          },
        };

  /** Asks the workspace what to publish, and checks that it can be. */
  const prepare = async (): Promise<Prepared | null> => {
    const delivery = await asked(() =>
      deliveryOf(env.WORKSPACE, workspace, run),
    );
    if (!delivery) return null;
    const { channel, content } = delivery;
    if (channel.needsReconnect) {
      throw refused(
        "This account has to be connected again before pigy can post to it.",
      );
    }
    let { limits } = channel;
    if (
      !limits ||
      now().getTime() - (channel.limitsCheckedAt ?? 0) >= limitsLifetimeMs
    ) {
      const { provider, vault: channelVault } = adapterOf(channel.network);
      limits = await withCredentials(
        accessOf(channel, provider, channelVault),
        (credentials) => provider.limits(credentials),
      );
      const fresh = limits;
      const kept = await asked(async () =>
        mutateWorkspace(
          env.WORKSPACE,
          workspace,
          "channel.setLimits",
          { id: channel.id, limits: fresh },
          await key("limits", fresh),
        ),
      );
      // The channel is gone, and the delivery with it.
      if (!kept.ok) throw superseded();
    }
    // What does not pass is not sent: the network would refuse it, or
    // worse, take it and cut it short.
    const issues = validateContent(limits, content);
    if (issues.length > 0) {
      throw refused(issues.map(({ message }) => message).join(" "));
    }
    return {
      channel: {
        id: channel.id,
        network: channel.network,
        accountId: channel.accountId,
      },
      content,
      progress: publishProgressSchema.nullable().parse(delivery.progress),
    };
  };

  let ending: Ending = { status: "sent" };
  try {
    const prepared = await tried("prepare", prepare);
    // Not this run's delivery any more. Whoever ended it has said so.
    if (!prepared) return;
    const {
      provider,
      reach,
      vault: channelVault,
    } = adapterOf(prepared.channel.network);
    // Nothing has been asked of the network that could publish, and from
    // here on it is. Not earlier: a delivery that ends before this point
    // must leave what the others to its channel have recorded alone.
    //
    // Nor does a delivery that has nothing left to send: an attempt before
    // this one recorded every part and only its end was lost. `publish`
    // asks nothing of the network then.
    //
    // Nor does a delivery whose adapter tells the deliveries to an account
    // apart, as Bluesky's does: it finds a part under a key of the
    // delivery's own, so what this one posts is nothing that another
    // could take for its own. What the others recorded is then the only
    // way to a first part of theirs that landed unseen, and has to stay.
    //
    // The step also says whether this delivery is still under way, and
    // without it nothing asks before the first request: a delivery that
    // is taken up with a key chosen sends its part in its first step,
    // before anything is recorded. It does not send for a delivery that
    // has been ended all the same. While its run is running, a delivery
    // that passed `prepare` can be ended by one thing only, which is the
    // disconnect of its channel: the alarm of the workspace ends a
    // delivery only once its run is over, and no client can end or delete
    // what is `sending`. Disconnecting removes the channel with its
    // credentials, and every step that talks to the network asks the
    // workspace for them first: `accessOf` gets nothing then and stops
    // the step before it sends. What is left is a disconnect that comes
    // while a request is on its way, which the step before does not
    // close either.
    if (!prepared.progress?.done && !provider.tellsDeliveriesApart) {
      const underWay = await step.do("about-to-send", bookkeepingStep, () =>
        aboutToSend(env.WORKSPACE, workspace, run),
      );
      if (!underWay) throw superseded();
    }
    await publish(
      sendingOnce(provider),
      {
        ...accessOf(prepared.channel, provider, channelVault),
        content: prepared.content,
        // What names the delivery to the network, the same in every
        // attempt.
        key: targetId,
      },
      {
        run: async (name, publishStep) => {
          const progress = await tried(name, publishStep);
          const recorded = await step.do(
            `record-${name}`,
            bookkeepingStep,
            async () =>
              recordProgress(
                env.WORKSPACE,
                workspace,
                run,
                progress.parts.map((part) => ({
                  id: uuidv7(now()),
                  remoteId: part.id,
                  url: linkOf(reach, part.url),
                })),
                progress,
                await key("progress", progress),
              ),
          );
          if (!recorded.ok) {
            throw recorded.code === "not_current"
              ? superseded()
              : new Error(`Progress was not recorded: ${recorded.message}`);
          }
          return progress;
        },
        sleep: (name, seconds) => step.sleep(name, seconds * 1000),
      },
      prepared.progress,
    );
  } catch (error) {
    // Only what this code has ended is an end. Anything else comes from
    // the platform: it has given up on a step, or it is stopping the run,
    // to pause it or to start it again, and that must not be taken for a
    // failure of the delivery. It is thrown on. A run that fails that way
    // says nothing to the workspace, whose object finds it out: see
    // `alarm` in src/workspace/object.ts.
    if (!(error instanceof Ended)) throw error;
    if (error.failure.kind === "superseded") return;
    ending = endingOf(error.failure, error.tries);
  }

  const end: MutatorArgs<"target.end"> = { id: targetId, attempt, ...ending };
  await step.do("end", bookkeepingStep, async () => {
    const outcome = await mutateWorkspace(
      env.WORKSPACE,
      workspace,
      "target.end",
      end,
      await key("end", end),
    );
    // Refused if the delivery was ended otherwise in the meantime.
    if (!outcome.ok && outcome.code !== "not_current") {
      console.error(
        `The end of a delivery was not recorded: ${outcome.message}`,
      );
    }
    return outcome.ok;
  });
}

/**
 * The workflow, under the name that wrangler.jsonc binds as `PUBLISH`. A
 * function that returns the class, because the runtime constructs it and
 * there is no other way to hand it what it is built with.
 */
export function publishWorkflow(dependencies: PublishDependencies) {
  return class PublishWorkflow extends WorkflowEntrypoint<
    Bindings,
    DeliveryParams
  > {
    override async run(
      event: Readonly<WorkflowEvent<DeliveryParams>>,
      step: WorkflowStep,
    ): Promise<void> {
      await deliver(
        dependencies,
        this.env,
        deliveryParamsSchema.parse(event.payload),
        event.instanceId,
        step,
      );
    }
  };
}
