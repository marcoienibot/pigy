import {
  canonicalTimeZone,
  defaultSettings,
  type MutatorArgs,
  type MutatorName,
  type Network,
  networks,
  ownParts,
  ownTextMutations,
  partsFor,
  type RejectionCode,
  type Row,
  settingsId,
  uuidv7,
  validateContent,
} from "@pigy/core";
import {
  type ApiChannel,
  type ApiMode,
  type ApiPost,
  type ApiPostingSchedule,
  apiDays,
  apiTime,
  type CreatePostRequest,
  defaultApiPageSize,
  type ListPostsQuery,
  type MovePostRequest,
  maxApiAnswerTextLength,
  type PutPostingScheduleRequest,
  type UpdatePostRequest,
} from "@pigy/core/api";
import { and, desc, eq, exists, isNull, sql } from "drizzle-orm";
import type { DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite";
import { posts, postTargets } from "./schema.ts";
import { findRows, readRow, readRows } from "./synced.ts";

/**
 * What the public API does in a workspace, inside its Durable Object: the
 * reads, and the writes, each of which is one call however many mutations
 * it takes. `PLAN.md` section 12 has the design.
 *
 * - Every change is made with the mutators that the app's clients use, in
 *   the order that an editor would, so the API can make nothing that the
 *   app could not, and the clients that are connected see it as they see
 *   each other's changes.
 * - A call is all or nothing. The store runs `carryOut` in a transaction,
 *   and a refusal, which is thrown, undoes what the call has done so far:
 *   `ApiRefusal`.
 * - What goes out is checked as the editor checks it before it offers to
 *   publish: `publishable`. A draft is not checked: it may hold anything.
 *
 * Everything that crosses into the object and out of it is plain data: a
 * call as the Worker has parsed it, and an answer with its status.
 */

/** A call of the API, as the Worker hands it to the object. */
export type ApiCall =
  | { op: "listChannels" }
  | { op: "getChannel"; id: string }
  | { op: "listPosts"; query: ListPostsQuery }
  | { op: "getPost"; id: string }
  | { op: "createPost"; body: CreatePostRequest }
  | { op: "updatePost"; id: string; body: UpdatePostRequest }
  | { op: "deletePost"; id: string }
  | { op: "movePost"; id: string; body: MovePostRequest }
  | { op: "getPostingSchedule" }
  | { op: "putPostingSchedule"; body: PutPostingScheduleRequest };

/**
 * How a call ended: the status, and the body of a success or the refusal.
 * `replayed` says that the call was not carried out now: it came with a
 * key that it had come with before, and this is what is said of it today.
 */
export type ApiAnswer = (
  | { ok: true; status: number; body: unknown }
  | { ok: false; status: number; message: string; field?: string }
) & { replayed?: true };

/**
 * What is kept of a write that came with an `Idempotency-Key`, for the
 * repeats of it: a small record, whatever the size of the post.
 *
 * - Of a success, the status and the read that makes the body of a
 *   repeat, `read`, or null for an answer without a body. The body itself
 *   is not kept. It can be megabytes, more than a row of the database
 *   holds, and it would be parsed by a later version of the Worker with
 *   the shape of that day. So a repeat is answered with the status of
 *   the first answer and with the post, or the posting schedule, as it is
 *   when the repeat comes.
 * - Of a refusal, all of it, which is a status and a few words.
 */
export type KeptApiAnswer =
  | { ok: true; status: number; read: ApiRead | null }
  | { ok: false; status: number; message: string; field?: string };

/** The reads that make the body of a repeat. */
type ApiRead = Extract<ApiCall, { op: "getPost" | "getPostingSchedule" }>;

/** The longest message of a refusal that is kept. None is as long. */
const maxKeptMessageLength = 1000;

/** What to keep of the write `call`, which was answered with `answer`. */
export function keptOf(call: ApiCall, answer: ApiAnswer): KeptApiAnswer {
  if (!answer.ok) {
    const { status, field } = answer;
    const message = answer.message.slice(0, maxKeptMessageLength);
    return {
      ok: false,
      status,
      message,
      ...(field !== undefined && { field }),
    };
  }
  const { status } = answer;
  switch (call.op) {
    case "createPost":
      // The one thing of the answer that nothing else says.
      return {
        ok: true,
        status,
        read: { op: "getPost", id: (answer.body as ApiPost).id },
      };
    case "updatePost":
    case "movePost":
      return { ok: true, status, read: { op: "getPost", id: call.id } };
    case "putPostingSchedule":
      return { ok: true, status, read: { op: "getPostingSchedule" } };
    default:
      return { ok: true, status, read: null };
  }
}

/**
 * The answer to a repeat of the call that `kept` is kept of. A post that
 * is gone by now is said to be: the repeat of the request that made it is
 * a 404 then, and makes no second post.
 */
export function replayOf(kept: KeptApiAnswer, bench: ApiBench): ApiAnswer {
  if (!kept.ok) return { ...kept, replayed: true };
  if (kept.read === null) {
    return { ok: true, status: kept.status, body: null, replayed: true };
  }
  try {
    const { body } = carryOut(kept.read, bench) as ApiAnswer & { ok: true };
    return { ok: true, status: kept.status, body, replayed: true };
  } catch (error) {
    if (!(error instanceof ApiRefusal)) throw error;
    return { ...error.answer, replayed: true };
  }
}

/**
 * Thrown to refuse a call. The store undoes what the call did and answers
 * with `answer`.
 */
export class ApiRefusal extends Error {
  readonly answer: ApiAnswer & { ok: false };

  constructor(status: number, message: string, field?: string) {
    super(message);
    this.answer = {
      ok: false,
      status,
      message,
      ...(field !== undefined && { field }),
    };
  }
}

/** What the store hands a call to work with. */
export type ApiBench = {
  db: DrizzleSqliteDODatabase;
  /** The time of the call, in milliseconds since the Unix epoch. */
  now: number;
  /** Runs a mutator. Returns why it was refused, or null. */
  mutate(
    name: string,
    args: unknown,
  ): { code: RejectionCode; message: string } | null;
  /**
   * Marks the push messages that wait to be sent, for `dropPushesSince`.
   */
  pushMark(): number;
  /**
   * Takes back the push messages that were queued for the notification
   * `notificationId` since `mark`: the devices are not told a second time
   * of what the call has only made anew.
   */
  dropPushesSince(mark: number, notificationId: string): void;
};

/** The status that the refusal of a mutator is answered with. */
function statusOf(code: RejectionCode): number {
  switch (code) {
    case "not_found":
      return 404;
    // The post is not in a state for what was asked.
    case "not_a_draft":
    case "not_scheduled":
    case "sending":
    case "already_exists":
    case "not_failed":
    case "not_current":
      return 409;
    default:
      return 400;
  }
}

const networkNames: { readonly [N in Network]: string } = {
  bluesky: "Bluesky",
  linkedin: "LinkedIn",
  mastodon: "Mastodon",
  threads: "Threads",
};

/** Carries out `call`, or throws an `ApiRefusal`. */
export function carryOut(call: ApiCall, bench: ApiBench): ApiAnswer {
  const { db } = bench;
  const newId = () => uuidv7(new Date(bench.now));
  const ok = (body: unknown, status = 200): ApiAnswer => ({
    ok: true,
    status,
    body,
  });

  /** Runs a mutation, which the mutator has to take. */
  const run = (mutation: { name: MutatorName; args: unknown }): void => {
    const refusal = bench.mutate(mutation.name, mutation.args);
    if (!refusal) return;
    // A bug of the mutator, which the store has logged. It is no refusal
    // of the request: thrown as it is, the call has not happened, nothing
    // is kept under its key, and its repeat is carried out once the bug
    // is gone. As a refusal it would be answered as a 500 for as long as
    // the key is kept.
    if (refusal.code === "internal_error") {
      throw new Error(`The mutator ${mutation.name} failed`);
    }
    throw new ApiRefusal(statusOf(refusal.code), refusal.message);
  };
  const mutate = <Name extends MutatorName>(
    name: Name,
    args: MutatorArgs<Name>,
  ): void => run({ name, args });

  /** The post with this ID. One that was put aside is as good as gone. */
  const postOf = (id: string): Row<"post"> => {
    const post = readRow(db, "post", id);
    if (!post || post.trashedAt !== null) {
      throw new ApiRefusal(404, "There is no such post");
    }
    return post;
  };

  const targetsOf = (postId: string) =>
    findRows(db, "post_target", "postId", postId).sort((a, b) =>
      a.id < b.id ? -1 : 1,
    );

  const channelResource = (channel: Row<"channel">): ApiChannel => {
    const { limits } = channel;
    return {
      id: channel.id,
      service: channel.network,
      serviceId: channel.accountId,
      name: channel.name,
      handle: channel.handle,
      avatarUrl: channel.avatarUrl,
      profileUrl: channel.profileUrl,
      status: channel.status,
      connectedAt: apiTime(channel.connectedAt),
      expiresAt: channel.expiresAt === null ? null : apiTime(channel.expiresAt),
      limits: limits && {
        maxCharacters: limits.maxCharacters,
        ...("charactersPerUrl" in limits && {
          charactersPerUrl: limits.charactersPerUrl,
        }),
        ...("maxBytes" in limits && { maxBytes: limits.maxBytes }),
      },
    };
  };

  const modeOf = (post: Row<"post">): ApiMode | null => {
    if (post.mode === "custom") return "customScheduled";
    if (post.mode === "queue") return "addToQueue";
    return post.status === "draft" ? null : "shareNow";
  };

  const lengthOf = (parts: { text: string }[]) =>
    parts.reduce((length, { text }) => length + text.length, 0);

  /**
   * How many characters the answer of a post has room for besides the
   * post's own text: `maxApiAnswerTextLength` has what this is for.
   */
  const roomAfter = (parts: Row<"post_part">[]) => ({
    left: maxApiAnswerTextLength - lengthOf(ownParts(parts)),
  });

  /**
   * The post as the API says it. `room` is what is left of the answer for
   * the texts that accounts have of their own, and is used up here.
   */
  const postResource = (
    post: Row<"post">,
    parts = findRows(db, "post_part", "postId", post.id),
    room = roomAfter(parts),
  ): ApiPost => {
    const [first, ...thread] = ownParts(parts);
    const targets = targetsOf(post.id);
    return {
      id: post.id,
      status: post.status,
      text: first?.text ?? "",
      metadata: { thread: thread.map(({ text }) => ({ text })) },
      channelIds: targets.map(({ channelId }) => channelId),
      mode: modeOf(post),
      dueAt: post.dueAt === null ? null : apiTime(post.dueAt),
      heldAt: post.heldAt === null ? null : apiTime(post.heldAt),
      createdAt: apiTime(post.createdAt),
      updatedAt: apiTime(post.updatedAt),
      targets: targets.map((target) => {
        const customized = parts.some((part) => part.targetId === target.id);
        const gets = partsFor(parts, target.id);
        const [text, ...further] = gets;
        const published = findRows(
          db,
          "target_part_result",
          "targetId",
          target.id,
        ).find(({ partId }) => partId === text?.id);
        // The text of an account is said where the account has one of
        // its own, and where the answer has room for it. Every other
        // account gets the text of the post, which the post says once.
        const own = customized && lengthOf(gets) <= room.left;
        if (own) room.left -= lengthOf(gets);
        return {
          channelId: target.channelId,
          service: readRow(db, "channel", target.channelId)?.network ?? null,
          status: target.status,
          text: own ? (text?.text ?? "") : null,
          thread: own ? further.map((part) => ({ text: part.text })) : null,
          customized,
          link: published?.url ?? null,
          remoteId: published?.remoteId ?? null,
          error: target.error,
          disconnected: target.disconnected,
          sentAt: target.sentAt === null ? null : apiTime(target.sentAt),
          // Engagement comes with phase 10.
          metrics: null,
        };
      }),
    };
  };

  /** The channel `id`, which a request has named in `channelIds`. */
  const chosenChannel = (id: string): Row<"channel"> => {
    const channel = readRow(db, "channel", id);
    if (!channel) {
      throw new ApiRefusal(
        400,
        `channelIds: ${id} is not a channel of this workspace`,
        "channelIds",
      );
    }
    return channel;
  };

  /**
   * Gives the channels of `service` that the post goes to the text
   * `texts` in place of the post's own, as "Customize" does in the editor.
   * A text that they had before is replaced.
   */
  const customize = (postId: string, service: Network, texts: string[]) => {
    const chosen = targetsOf(postId).filter(
      ({ channelId }) => readRow(db, "channel", channelId)?.network === service,
    );
    if (chosen.length === 0) {
      throw new ApiRefusal(
        400,
        `metadata.${service}: The post goes to no ${networkNames[service]} channel`,
        `metadata.${service}`,
      );
    }
    for (const { channelId } of chosen) {
      mutate("target.followPost", { postId, channelId });
      // In as many steps as a client would take for a text of this length.
      ownTextMutations(postId, channelId, texts, newId).forEach(run);
    }
  };

  /**
   * Refuses unless the post `postId` is one that the editor would offer
   * to publish: `compose` of the web app has the same rules. It goes
   * somewhere, to no account that needs connecting again, no part of a
   * text that an account gets is empty, and every account takes the text
   * that it gets, by `validateContent` with the limits of the account.
   * The refusal names the field of the request that the text came from.
   */
  const publishable = (postId: string): void => {
    const targets = targetsOf(postId);
    if (targets.length === 0) {
      throw new ApiRefusal(
        400,
        "channelIds: Choose at least one channel to publish to",
        "channelIds",
      );
    }
    const parts = findRows(db, "post_part", "postId", postId);
    for (const target of targets) {
      const channel = readRow(db, "channel", target.channelId);
      // A target of a post that has not gone out has its channel.
      if (!channel) continue;
      if (channel.status === "needs_reconnect") {
        throw new ApiRefusal(
          400,
          `channelIds: ${channel.handle} has to be connected again in the app first`,
          "channelIds",
        );
      }
      const customized = parts.some((part) => part.targetId === target.id);
      const base = customized ? `metadata.${channel.network}` : "metadata";
      const fieldOf = (part: number | null) =>
        part === null || part === 0
          ? customized
            ? `${base}.text`
            : "text"
          : `${base}.thread.${part - 1}.text`;
      const content = {
        parts: partsFor(parts, target.id).map(({ text }) => ({ text })),
      };
      const empty = content.parts.findIndex(({ text }) => text.trim() === "");
      const issue =
        empty >= 0
          ? {
              part: empty,
              message:
                content.parts.length === 1
                  ? "The post has no text."
                  : `Part ${empty + 1} has no text.`,
            }
          : channel.limits && validateContent(channel.limits, content)[0];
      if (issue) {
        const field = fieldOf(issue.part);
        throw new ApiRefusal(
          400,
          `${field}: ${issue.message} (${channel.handle})`,
          field,
        );
      }
    }
  };

  /**
   * Gives a post that passes the checks its time, by `mode`. `dueAt` is
   * the time of a post with a time of its own, in milliseconds since the
   * Unix epoch.
   */
  const share = (id: string, mode: ApiMode, dueAt: number | undefined) => {
    publishable(id);
    switch (mode) {
      case "shareNow":
        return mutate("post.publish", { id });
      case "addToQueue":
        return mutate("post.enqueue", { id, first: false });
      case "shareNext":
        return mutate("post.enqueue", { id, first: true });
      case "customScheduled":
        return mutate("post.schedule", { id, dueAt: dueAt ?? Number.NaN });
    }
  };

  /** The posts of the queue, in its order. */
  const queue = () =>
    findRows(db, "post", "status", "scheduled")
      .filter((post) => post.mode === "queue" && post.trashedAt === null)
      .sort(
        (a, b) =>
          (a.queuePosition ?? 0) - (b.queuePosition ?? 0) ||
          (a.id < b.id ? -1 : 1),
      );

  /** The time that a request names, which the Worker has checked. */
  const timeOf = (dueAt: string | undefined) =>
    dueAt === undefined ? undefined : new Date(dueAt).getTime();

  const settingsOf = () =>
    readRow(db, "settings", settingsId) ?? defaultSettings;

  const clock = (minute: number) =>
    `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;

  const postingSchedule = (): ApiPostingSchedule => {
    const settings = settingsOf();
    const slots = readRows(db, "schedule_slot");
    return {
      timeZone: settings.timeZone,
      paused: settings.queuePaused,
      schedule: apiDays.map((day, weekday) => ({
        day,
        times: slots
          .filter((slot) => slot.weekday === weekday)
          .map(({ minute }) => minute)
          .sort((a, b) => a - b)
          .map(clock),
      })),
    };
  };

  switch (call.op) {
    case "listChannels":
      return ok({
        channels: readRows(db, "channel")
          .sort(
            (a, b) => a.connectedAt - b.connectedAt || (a.id < b.id ? -1 : 1),
          )
          .map(channelResource),
      });

    case "getChannel": {
      const channel = readRow(db, "channel", call.id);
      if (!channel) throw new ApiRefusal(404, "There is no such channel");
      return ok(channelResource(channel));
    }

    case "listPosts": {
      const { status, channelId, after } = call.query;
      const first = call.query.first ?? defaultApiPageSize;
      const from = after === undefined ? undefined : cursorOf(after);
      if (from === null) {
        throw new ApiRefusal(
          400,
          "after: This is not a cursor of a page",
          "after",
        );
      }
      // One more than the page, to know whether another follows. Each
      // status is asked for by itself, so that every question is a walk
      // down an index from the cursor on, and the newest of them all are
      // the page: `postsPage`.
      const statuses = status ? [...new Set(status)] : [undefined];
      const page = statuses
        .flatMap((one) =>
          postsPage(db, {
            status: one,
            channelId,
            from: from ?? undefined,
            limit: first + 1,
          }).all(),
        )
        .sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1))
        .slice(0, first + 1);
      // A page ends before the post that the answer has no room for, so
      // it can have fewer posts than were asked for. It has one at least.
      let room = maxApiAnswerTextLength;
      let taken = 0;
      const shown: ApiPost[] = [];
      for (const { id } of page.slice(0, first)) {
        const post = readRow(db, "post", id);
        if (post) {
          const parts = findRows(db, "post_part", "postId", id);
          const length = lengthOf(parts);
          if (shown.length > 0 && length > room) break;
          shown.push(postResource(post, parts));
          room -= length;
        }
        taken += 1;
      }
      const last = page[taken - 1];
      return ok({
        posts: shown,
        pageInfo: {
          hasNextPage: page.length > taken,
          endCursor: last ? cursorAt(last) : null,
        },
      });
    }

    case "getPost":
      return ok(postResource(postOf(call.id)));

    case "createPost": {
      const { body } = call;
      const postId = newId();
      let partId = newId();
      mutate("post.create", { id: postId, partId, text: body.text });
      for (const { text } of body.metadata?.thread ?? []) {
        const id = newId();
        mutate("part.add", {
          id,
          postId,
          channelId: null,
          afterId: partId,
          mustFollow: true,
          text,
        });
        partId = id;
      }
      for (const channelId of body.channelIds ?? []) {
        chosenChannel(channelId);
        mutate("target.add", { id: newId(), postId, channelId });
      }
      for (const service of networks) {
        const own = body.metadata?.[service];
        if (!own) continue;
        customize(postId, service, [
          own.text ?? body.text,
          ...(own.thread ?? []).map(({ text }) => text),
        ]);
      }
      if (!body.saveToDraft && body.mode) {
        share(postId, body.mode, timeOf(body.dueAt));
      }
      return ok(postResource(postOf(postId)), 201);
    }

    case "updatePost": {
      const { id, body } = call;
      const before = postOf(id);
      if (before.status !== "draft" && before.status !== "scheduled") {
        throw new ApiRefusal(
          409,
          "This post has gone out and can no longer be changed",
        );
      }
      const edits =
        body.text !== undefined ||
        body.channelIds !== undefined ||
        body.metadata !== undefined;
      const scheduled = before.status === "scheduled";
      // The post that this one stood behind in the queue, to put it back.
      const queued = queue();
      const place = queued.findIndex((post) => post.id === id);
      const ahead = place > 0 ? (queued[place - 1]?.id ?? null) : null;
      // What the request leaves of when the post goes out. A request
      // that says what the post has already asks for nothing new: a
      // script may send the whole post with every change.
      const time = timeOf(body.dueAt);
      const keepsPlace =
        scheduled &&
        before.mode === "queue" &&
        !body.saveToDraft &&
        (body.mode === undefined || body.mode === "addToQueue");
      const keepsTime =
        scheduled &&
        before.mode === "custom" &&
        !body.saveToDraft &&
        (body.mode === undefined ||
          (body.mode === "customScheduled" && time === before.dueAt));
      // What the inbox says of a post that is held, and the push messages
      // that wait, to leave both as they are if the post is held still.
      const notice =
        before.heldAt === null ? undefined : readRow(db, "notification", id);
      const pushMark = bench.pushMark();
      // Only a draft is edited, in the app as here: a scheduled post is
      // taken back first, and given its time again below.
      if (scheduled && (edits || body.saveToDraft)) {
        mutate("post.unschedule", { id });
      }

      const own = () => ownParts(findRows(db, "post_part", "postId", id));
      const [first, ...further] = own();
      if (!first) throw new Error(`The post ${id} has no part`);
      if (body.text !== undefined && body.text !== first.text) {
        mutate("part.setText", { id: first.id, text: body.text });
      }
      const thread = body.metadata?.thread;
      if (thread !== undefined) {
        let afterId = first.id;
        thread.forEach(({ text }, index) => {
          const part = further[index];
          if (part) {
            if (part.text !== text)
              mutate("part.setText", { id: part.id, text });
            afterId = part.id;
          } else {
            const partId = newId();
            mutate("part.add", {
              id: partId,
              postId: id,
              channelId: null,
              afterId,
              mustFollow: true,
              text,
            });
            afterId = partId;
          }
        });
        for (const part of further.slice(thread.length)) {
          mutate("part.remove", { id: part.id });
        }
      }
      if (body.channelIds !== undefined) {
        const wanted = new Set(body.channelIds);
        const has = new Set<string>();
        for (const { channelId } of targetsOf(id)) {
          if (wanted.has(channelId)) has.add(channelId);
          else mutate("target.remove", { postId: id, channelId });
        }
        for (const channelId of body.channelIds) {
          if (has.has(channelId)) continue;
          chosenChannel(channelId);
          mutate("target.add", { id: newId(), postId: id, channelId });
        }
      }
      for (const service of networks) {
        const text = body.metadata?.[service];
        if (text === undefined) continue;
        if (text === null) {
          for (const { channelId } of targetsOf(id)) {
            if (readRow(db, "channel", channelId)?.network === service) {
              mutate("target.followPost", { postId: id, channelId });
            }
          }
          continue;
        }
        customize(id, service, [
          text.text ?? own()[0]?.text ?? "",
          ...(text.thread ?? []).map((part) => part.text),
        ]);
      }

      if (body.saveToDraft) {
        // A draft from here on, which the lines above have seen to.
      } else if (keepsPlace) {
        if (edits) {
          // Back into the queue, at its place.
          share(id, "addToQueue", undefined);
          // If the post that was ahead has gone out meanwhile, so have
          // all that were before it: the front is the place then.
          const still = queue().some((post) => post.id === ahead);
          mutate("post.move", { id, afterId: still ? ahead : null });
        }
      } else if (keepsTime) {
        if (edits) {
          // The time that the row has, which can be one that an answer
          // does not say as it is: `apiTime`.
          share(id, "customScheduled", before.dueAt ?? undefined);
        }
      } else if (body.mode) {
        share(id, body.mode, time);
      }

      // A post that was held and is held still, at the time that it had,
      // has only been edited. The mutators took what the inbox said of
      // it away when the post was taken back, and said it anew, unread
      // and with a push message, when it was scheduled again. The devices
      // are not told a second time, and the inbox is left as it was: read
      // if somebody had read it, without the notification if somebody
      // had dismissed it.
      const after = postOf(id);
      if (before.heldAt !== null && keepsTime && after.heldAt !== null) {
        const anew = readRow(db, "notification", id);
        if (anew && anew.createdAt !== notice?.createdAt) {
          bench.dropPushesSince(pushMark, id);
          const seen = { id, createdAt: anew.createdAt };
          if (!notice) mutate("notification.dismiss", seen);
          else if (notice.readAt !== null) {
            mutate("notification.read", { notifications: [seen] });
          }
        }
      }
      return ok(postResource(postOf(id)));
    }

    case "deletePost":
      postOf(call.id);
      mutate("post.delete", { id: call.id });
      return ok(null, 204);

    case "movePost": {
      const { id } = call;
      const { afterId } = call.body;
      postOf(id);
      // The mutator leaves the post where it is when the other one is not
      // in the queue: two devices can reorder at once. A request that
      // names such a post is told so.
      if (
        afterId !== null &&
        (afterId === id || !queue().some((post) => post.id === afterId))
      ) {
        throw new ApiRefusal(
          400,
          "afterId: This is not another post of the queue",
          "afterId",
        );
      }
      mutate("post.move", { id, afterId });
      return ok(postResource(postOf(id)));
    }

    case "getPostingSchedule":
      return ok(postingSchedule());

    case "putPostingSchedule": {
      const { body } = call;
      const before = settingsOf();
      const timeZone =
        body.timeZone === undefined
          ? undefined
          : canonicalTimeZone(body.timeZone);
      if (timeZone === null) {
        throw new ApiRefusal(
          400,
          "timeZone: This is not a time zone that pigy knows",
          "timeZone",
        );
      }
      const slots = readRows(db, "schedule_slot");
      const at = ({ weekday, minute }: { weekday: number; minute: number }) =>
        weekday * 24 * 60 + minute;
      const wanted = new Map(
        body.schedule.flatMap(({ day, times }) =>
          times.map((time) => {
            const slot = {
              weekday: apiDays.indexOf(day),
              minute: Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5)),
            };
            return [at(slot), slot] as const;
          }),
        ),
      );
      const kept = new Set<number>();
      const removed = slots.filter((slot) => {
        if (!wanted.has(at(slot))) return true;
        kept.add(at(slot));
        return false;
      });
      const added = [...wanted].filter(([time]) => !kept.has(time));
      const zoneChanges =
        timeZone !== undefined && timeZone !== before.timeZone;
      const paused = body.paused ?? before.queuePaused;
      // Every change of a slot gives each post of the queue its time
      // anew, which is the one costly thing that a mutator does. While
      // the queue is paused its posts have no time, so the queue is
      // paused for the changes, in this transaction, and its posts are
      // given their times once, when it goes on. They get the times that
      // they would have got: the slots after now, in their order.
      const changes = removed.length > 0 || added.length > 0 || zoneChanges;
      if (changes && !before.queuePaused) {
        mutate("queue.setPaused", { paused: true });
      }
      if (zoneChanges) mutate("settings.setTimeZone", { timeZone });
      for (const { id } of removed) mutate("slot.remove", { id });
      for (const [, slot] of added)
        mutate("slot.add", { id: newId(), ...slot });
      if (settingsOf().queuePaused !== paused) {
        mutate("queue.setPaused", { paused });
      }
      return ok(postingSchedule());
    }
  }
}

/**
 * The question for a page of posts, the newest first: those of `status`,
 * or of every status, that go to `channelId`, or anywhere, after `from`.
 * Posts that somebody put aside are left out.
 *
 * Written so that SQLite walks down an index from where the page begins
 * and stops at its end, without a sort: `post_status_created_at_idx` with
 * a status, `post_created_at_idx` without. That takes one status, because
 * the posts of two are not in one order in the index, and the cursor as
 * one comparison of a row value: written with `or`, SQLite reads every
 * post before the cursor to get to it. A test reads the plan.
 */
export function postsPage(
  db: DrizzleSqliteDODatabase,
  query: {
    status?: Row<"post">["status"] | undefined;
    channelId?: string | undefined;
    from?: { id: string; createdAt: number } | undefined;
    limit: number;
  },
) {
  const { status, channelId, from } = query;
  return db
    .select({ id: posts.id, createdAt: posts.createdAt })
    .from(posts)
    .where(
      and(
        status === undefined ? undefined : eq(posts.status, status),
        isNull(posts.trashedAt),
        channelId === undefined
          ? undefined
          : exists(
              db
                .select({ id: postTargets.id })
                .from(postTargets)
                .where(
                  and(
                    eq(postTargets.postId, posts.id),
                    eq(postTargets.channelId, channelId),
                  ),
                ),
            ),
        from &&
          sql`(${posts.createdAt}, ${posts.id}) < (${from.createdAt}, ${from.id})`,
      ),
    )
    .orderBy(desc(posts.createdAt), desc(posts.id))
    .limit(query.limit);
}

/**
 * The cursor of the page that ends with `post`: where the next one begins,
 * in a form that a query takes as it is.
 */
function cursorAt({ id, createdAt }: { id: string; createdAt: number }) {
  return btoa(`${createdAt}:${id}`)
    .replaceAll("=", "")
    .replaceAll("+", "-")
    .replaceAll("/", "_");
}

/** Where a page that follows the cursor `cursor` begins, or null. */
function cursorOf(cursor: string): { id: string; createdAt: number } | null {
  let text: string;
  try {
    text = atob(cursor.replaceAll("-", "+").replaceAll("_", "/"));
  } catch {
    return null;
  }
  const [, createdAt, id] = /^(\d{1,16}):([0-9a-f-]{36})$/.exec(text) ?? [];
  return createdAt && id ? { createdAt: Number(createdAt), id } : null;
}
