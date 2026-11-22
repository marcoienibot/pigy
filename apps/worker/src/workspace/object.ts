import { DurableObject } from "cloudflare:workers";
import {
  type Change,
  clientMessageSchema,
  type HelloMessage,
  helloVersionsSchema,
  type MutateMessage,
  type MutatorArgs,
  type PatchMessage,
  pingMessageText,
  pongMessageText,
  type Rejection,
  type SyncErrorCode,
  type SyncErrorMessage,
  syncCloseCodes,
  syncLimits,
  syncProtocolVersion,
  syncSchemaVersion,
} from "@pigy/core";
import { drizzle } from "drizzle-orm/d1";
import type { Bindings } from "../env.ts";
import { type LogKind, log } from "../log.ts";
import { deleteUnder, mediaKeys, noSuchUpload } from "../media/keys.ts";
import {
  deliveryInstanceId,
  lostTrackMessage,
  release,
} from "../publish/delivery.ts";
import { vapidKeyOf, vapidKeyWithoutRequest } from "../push/keys.ts";
import { pushToDevices } from "../push/notify.ts";
import type { ApiAnswer, ApiCall } from "./api.ts";
import {
  type RenewalDependencies,
  renewAccess,
  renewalBrokenMs,
} from "./renewal.ts";
import { metricsBrokenMs, readMetrics } from "./stats.ts";
import {
  type ChannelAccess,
  type ConnectChannelCall,
  type ConnectChannelOutcome,
  callKeySchema,
  type Delivery,
  type DeliveryRun,
  type DisconnectChannelOutcome,
  type DueMedia,
  type FinishedUpload,
  type MediaUpload,
  type MutationOutcome,
  type Patch,
  type RenewedChannelAccess,
  type StartedDelivery,
  type StepBegun,
  type StoredChannelAccess,
  type UploadOutcome,
  type WorkspaceIdentity,
  WorkspaceStore,
  workspaceIdentitySchema,
} from "./store.ts";

/**
 * How long a socket is good for. The session of whoever opened it was
 * checked then and is not checked again, so this is how long somebody whose
 * session has ended, by signing out or by losing their invitation, can go on
 * reading and writing through a socket that was open at the time.
 */
export const socketLifetimeMs = 5 * 60 * 1000;

/**
 * How many sockets a workspace has open at most. One per device is the
 * design, so this is far more than anybody needs. It bounds what a change
 * costs, which is one message per socket.
 */
export const maxSockets = 32;

/**
 * How many rejections the object keeps for a client before it stops taking
 * mutations from it. A rejection is kept until a hello of the client says
 * that it has been seen, so this is what makes a client say hello again
 * that has had many mutations rejected on one socket.
 */
export const maxRejectionsKept = 1000;

/**
 * How often the object looks after the deliveries that are under way, in
 * milliseconds: whether their workflows are still there, and whether one
 * that could not be started can be now.
 */
export const deliveryWatchMs = 60 * 1000;

/**
 * The farthest ahead that the alarm of the object is set, in
 * milliseconds: a year. The runtime refuses a time after the year 2189,
 * and a post can be scheduled for a later one, by the app and by the API.
 */
export const farthestLookMs = 365 * 24 * 60 * 60 * 1000;

/**
 * How many push messages one pass over the queue sends at most, and how
 * long it takes up new ones, in milliseconds: see `#pushPass` of the
 * object. Between two passes the alarm looks after the deliveries and the
 * accesses.
 */
export const pushesPerPass = 20;
export const pushPassMs = 30 * 1000;

/**
 * How many reads of stats one pass makes at most, and how long it takes
 * up new ones, in milliseconds: see `#metricsPass` of the object. What is
 * left waits for the next pass, which comes `metricsPauseMs` later, so
 * that a workspace with hundreds of posts whose stats are due together
 * asks their networks a few at a time.
 */
export const metricsPerPass = 20;
export const metricsPassMs = 30 * 1000;
export const metricsPauseMs = 60 * 1000;

/**
 * The least time between two alarms that are for renewing an access, in
 * milliseconds. Every renewal that does not work puts its channel off for
 * longer than this. It is here so that a mistake in that cannot make the
 * alarm of a workspace run without a pause.
 */
export const renewalPauseMs = 60 * 1000;

/**
 * How many names of the bucket one look of the alarm lists when it looks
 * for bytes that no row names: a list of the bucket takes a thousand at
 * most, and each image that is found takes a request or two besides.
 */
export const mediaSweepList = 200;

/**
 * What the object keeps about a socket. It survives hibernation, and a
 * deploy: a socket can stay open while new code replaces the old. A field
 * that is added here later is therefore missing on the sockets that were
 * open at the time. Whoever adds one gives it a default where it is read, or
 * raises a version, which closes those sockets the next time they are used.
 */
type SocketState = {
  /** Set by the `hello` of the socket. Until then it receives nothing. */
  clientId: string | null;
  /** When the socket stops being good, in milliseconds since the epoch. */
  expiresAt: number;
  /**
   * Higher for a socket that was opened later, among the sockets that the
   * object holds. Their hellos can arrive in another order than they were
   * opened in.
   */
  order: number;
  /**
   * What the server spoke when the socket was opened. A socket can stay open
   * while a deploy replaces the code of the object, and with it the
   * versions that its client agreed to in its hello.
   */
  protocolVersion: number;
  schemaVersion: number;
};

/**
 * The Durable Object of a workspace: the one place where the data of the
 * workspace is stored and changed. Clients keep a copy of it up to date over
 * a WebSocket, in the protocol that SYNC.md describes, and Worker code
 * changes it with `mutate`. Nothing else reaches the object: only the Worker
 * has its binding.
 *
 * The object does not know who is signed in. The Worker checks that before
 * it lets a request through, and tells the object which workspace the
 * request is for.
 *
 * The sockets use the hibernation API, so the object can leave memory while
 * they stay open. Nothing about a socket or about sync is kept in a field
 * for that reason: it is in the database or attached to the socket.
 *
 * A function that returns the class, because the runtime constructs the
 * object and there is no other way to hand it what it is built with.
 */
export function workspaceObject(
  dependencies: RenewalDependencies & {
    /**
     * Stands in for `VAPID_PRIVATE_KEY` when it is not set. Only builds for
     * development and tests pass one.
     */
    developmentVapidKey: string | undefined;
  },
) {
  // `fetch` also carries the push messages to the push services of the
  // devices.
  const { now, fetch, developmentVapidKey } = dependencies;
  return class WorkspaceObject extends DurableObject<Bindings> {
    readonly #store: WorkspaceStore;
    /**
     * The pass over the push messages that is under way, if one is: see
     * `#sendPushes`. In memory, like the pass itself: an object that
     * leaves memory in the middle of one sends what is left of the queue
     * with its next alarm.
     */
    #pushing: Promise<void> | null = null;
    /**
     * Set while the alarm waits for a pass that it has begun beside
     * itself, `#waitAside`: `stand` has it stop waiting, and `rearm` sets
     * anew when it stops by itself, after a change that can have brought
     * a scheduled post nearer. `pushes` says whether a push message that
     * a change queues is a reason to stop: it is while the alarm waits for
     * the stats, and not while it waits for the push messages to be sent.
     * Null unless an alarm waits.
     */
    #aside: { stand(): void; rearm(): void; pushes: boolean } | null = null;
    /**
     * True when the last pass over the push messages stopped at its limit
     * and left messages for the next one, until that begins: see
     * `#nextLookIn`.
     */
    #passStopped = false;
    /**
     * The pass over the stats that are due that is under way, if one is:
     * see `#metricsPass`. In memory, like the pass over the push messages:
     * an object that leaves memory in the middle of one reads what is left
     * with its next alarm.
     */
    #counting: Promise<void> | null = null;
    /**
     * True from the moment a pass over the stats begins until one has
     * read all that were due when it began: a read that is due while this
     * holds is one that a pass has yet to get to, or that it stopped
     * short of, and is come back to in `metricsPauseMs`, see
     * `#nextLookIn`.
     */
    #metricsBehind = false;
    /**
     * True while the alarm runs. It sets the next alarm when it is done,
     * from what it finds then, so a change in the meantime sets none.
     */
    #looking = false;
    /** How often the alarm has begun to run since the object was made. */
    #alarms = 0;

    constructor(ctx: DurableObjectState, env: Bindings) {
      super(ctx, env);
      this.#store = new WorkspaceStore(ctx.storage);
      ctx.blockConcurrencyWhile(() => this.#store.migrate());
      // The runtime answers a ping by itself, without waking the object up.
      ctx.setWebSocketAutoResponse(
        new WebSocketRequestResponsePair(pingMessageText, pongMessageText),
      );
    }

    /**
     * Opens a socket for a client of the workspace that the address names.
     * The Worker makes this request itself, after it has checked the
     * session and that the workspace is the caller's. Nothing in it comes
     * from the client. Answers 403 if the workspace is not the one that the
     * object holds, and 429 if it has too many sockets open.
     */
    override async fetch(request: Request): Promise<Response> {
      const identity = workspaceIdentitySchema.parse(
        Object.fromEntries(new URL(request.url).searchParams),
      );
      if (!this.#store.bind(identity)) {
        return new Response(null, { status: 403 });
      }
      const time = now().getTime();
      // Sockets that are past their time are closed here and do not count.
      const open = this.ctx
        .getWebSockets()
        .filter(
          (socket) =>
            socket.readyState === WebSocket.OPEN &&
            usable(socket, stateOf(socket), time),
        );
      if (open.length >= maxSockets) {
        return new Response(null, { status: 429 });
      }

      // One more than the highest of the sockets that the object holds, in
      // whatever state. The number is not stored anywhere else: it only has
      // to tell apart sockets that are open at the same time.
      const order =
        1 +
        Math.max(
          0,
          ...this.ctx.getWebSockets().map((socket) => stateOf(socket).order),
        );
      const { 0: client, 1: server } = new WebSocketPair();
      this.ctx.acceptWebSocket(server);
      server.serializeAttachment({
        clientId: null,
        expiresAt: time + socketLifetimeMs,
        order,
        protocolVersion: syncProtocolVersion,
        schemaVersion: syncSchemaVersion,
      } satisfies SocketState);
      return new Response(null, { status: 101, webSocket: client });
    }

    /**
     * Runs a mutator for Worker code. The clients that
     * are connected receive the change like any other. A call with a `key`
     * is carried out once, and answered the same way every time it comes.
     * Returns nothing if `workspace` is not the one that the object holds.
     */
    mutate(
      workspace: WorkspaceIdentity,
      name: string,
      args: unknown,
      key?: string,
    ): MutationOutcome | undefined {
      if (!this.#store.bind(workspaceIdentitySchema.parse(workspace))) {
        return undefined;
      }
      const from = this.#store.seq;
      const outcome = this.#store.mutate(
        { name, args },
        now().getTime(),
        callKeySchema.optional().parse(key),
      );
      this.#publish(from);
      return outcome;
    }

    /**
     * Stores an account that somebody has connected as a channel, together
     * with the access to it, which the Worker has sealed. The clients that
     * are connected receive the channel, and never the access. With a key
     * in `call` it is carried out once, and with `handBack` it returns the
     * access that the channel held before, sealed as it was stored. Returns
     * nothing if `workspace` is not the one that the object holds.
     */
    connectChannel(
      workspace: WorkspaceIdentity,
      channel: MutatorArgs<"channel.connect">,
      access: ChannelAccess,
      call: ConnectChannelCall = {},
    ): ConnectChannelOutcome | undefined {
      if (!this.#store.bind(workspaceIdentitySchema.parse(workspace))) {
        return undefined;
      }
      const from = this.#store.seq;
      const outcome = this.#store.connectChannel(
        channel,
        access,
        now().getTime(),
        {
          key: callKeySchema.optional().parse(call.key),
          handBack: call.handBack === true,
        },
      );
      // The access of the channel may name a time to renew it at, which
      // the alarm is set for with every change.
      this.#publish(from);
      return outcome;
    }

    /**
     * Removes a channel and returns the access that it held, sealed as it
     * was stored, for the Worker to give back to the network. The clients
     * that are connected hear that the channel is gone. Returns nothing if
     * `workspace` is not the one that the object holds.
     */
    disconnectChannel(
      workspace: WorkspaceIdentity,
      channelId: string,
    ): DisconnectChannelOutcome | undefined {
      if (!this.#store.bind(workspaceIdentitySchema.parse(workspace))) {
        return undefined;
      }
      const from = this.#store.seq;
      const outcome = this.#store.disconnectChannel(channelId, now().getTime());
      this.#publish(from);
      return outcome;
    }

    /**
     * What it takes to act for the account of a channel, sealed as it was
     * stored, or null if there is no such channel. With `disconnectChannel`
     * this is the only way that the access to an account leaves the object,
     * and both lead to the Worker only. Returns nothing if `workspace` is
     * not the one that the object holds.
     */
    channelAccess(
      workspace: WorkspaceIdentity,
      channelId: string,
    ): StoredChannelAccess | null | undefined {
      if (!this.#store.bind(workspaceIdentitySchema.parse(workspace))) {
        return undefined;
      }
      return this.#store.channelAccess(channelId) ?? null;
    }

    /**
     * What the delivery `run` publishes, for the workflow that carries it,
     * or null if it is not under way any more. Returns nothing if
     * `workspace` is not the one that the object holds.
     */
    delivery(
      workspace: WorkspaceIdentity,
      run: DeliveryRun,
    ): Delivery | null | undefined {
      if (!this.#store.bind(workspaceIdentitySchema.parse(workspace))) {
        return undefined;
      }
      return this.#store.delivery(run) ?? null;
    }

    /**
     * Takes note that the delivery `run` is about to make its first
     * request to the network, which is when the other deliveries to its
     * channel that have published nothing lose what they recorded.
     * Returns whether the delivery is under way, and nothing if
     * `workspace` is not the one that the object holds.
     */
    aboutToSend(
      workspace: WorkspaceIdentity,
      run: DeliveryRun,
    ): boolean | undefined {
      if (!this.#store.bind(workspaceIdentitySchema.parse(workspace))) {
        return undefined;
      }
      return this.#store.aboutToSend(run);
    }

    /**
     * Takes note that a step of the delivery `run` is about to be run,
     * under `key`, and returns the mark of the run of that step that was
     * noted first: `stepBegins` of the store. Returns nothing if
     * `workspace` is not the one that the object holds.
     */
    stepBegins(
      workspace: WorkspaceIdentity,
      run: DeliveryRun,
      mark: string,
      key: string,
    ): StepBegun | undefined {
      if (!this.#store.bind(workspaceIdentitySchema.parse(workspace))) {
        return undefined;
      }
      return this.#store.stepBegins(
        run,
        callKeySchema.parse(mark),
        now().getTime(),
        callKeySchema.parse(key),
      );
    }

    /**
     * Records how far the delivery `run` has come: the parts that are
     * published, which the clients hear of, and the progress to go on
     * from. Carried out once for `key`. Returns nothing if `workspace` is
     * not the one that the object holds.
     */
    recordProgress(
      workspace: WorkspaceIdentity,
      run: DeliveryRun,
      parts: MutatorArgs<"target.progress">["parts"],
      progress: unknown,
      key: string,
    ): MutationOutcome | undefined {
      if (!this.#store.bind(workspaceIdentitySchema.parse(workspace))) {
        return undefined;
      }
      const from = this.#store.seq;
      const outcome = this.#store.recordProgress(
        run,
        parts,
        progress,
        now().getTime(),
        callKeySchema.parse(key),
      );
      this.#publish(from);
      return outcome;
    }

    /**
     * Ends the delivery that `end` names, as `target.end` takes it, and
     * keeps what the next attempt has to know of this one: `endDelivery`
     * of the store. The clients that are connected see the target end.
     * With a `key` it is carried out once. Returns nothing if `workspace`
     * is not the one that the object holds.
     */
    endDelivery(
      workspace: WorkspaceIdentity,
      end: MutatorArgs<"target.end">,
      key?: string,
    ): MutationOutcome | undefined {
      if (!this.#store.bind(workspaceIdentitySchema.parse(workspace))) {
        return undefined;
      }
      const from = this.#store.seq;
      const outcome = this.#store.endDelivery(
        end,
        now().getTime(),
        callKeySchema.optional().parse(key),
      );
      this.#publish(from);
      return outcome;
    }

    /**
     * Carries out a call of the public API: `api` of the store. The
     * clients that are connected see what it changed. With `repeat` it is
     * carried out once for its key. Returns nothing if `workspace` is not
     * the one that the object holds.
     */
    api(
      workspace: WorkspaceIdentity,
      call: ApiCall,
      repeat?: { key: string; fingerprint: string },
    ): ApiAnswer | undefined {
      if (!this.#store.bind(workspaceIdentitySchema.parse(workspace))) {
        return undefined;
      }
      const from = this.#store.seq;
      try {
        return this.#store.api(
          call,
          now().getTime(),
          repeat && {
            key: callKeySchema.parse(repeat.key),
            fingerprint: callKeySchema.parse(repeat.fingerprint),
          },
        );
      } finally {
        // A read changes nothing, and neither does a write that was
        // refused or that was a repeat. A script that asks every few
        // seconds would otherwise cost what a change costs each time: the
        // changes are read, the next look is worked out and the runtime
        // is asked for the alarm. Every change of a mutator has a number.
        if (this.#store.seq !== from) this.#publish(from);
      }
    }

    /**
     * How far the upload of an image has come, with how many bytes of
     * images the workspace holds, or null if there is no such image.
     * Returns nothing if `workspace` is not the one that the object
     * holds.
     */
    mediaUpload(
      workspace: WorkspaceIdentity,
      mediaId: string,
    ): { upload: MediaUpload; held: number } | null | undefined {
      if (!this.#store.bind(workspaceIdentitySchema.parse(workspace))) {
        return undefined;
      }
      const upload = this.#store.mediaUpload(mediaId);
      return upload ? { upload, held: this.#store.mediaBytes } : null;
    }

    /**
     * Notes the upload in the bucket that the bytes of an image arrive
     * through, unless the image has one: `beginUpload` of the store.
     * Returns how far the upload that counts has come, null if there is
     * no such image, and nothing if `workspace` is not the one that the
     * object holds.
     */
    beginUpload(
      workspace: WorkspaceIdentity,
      mediaId: string,
      uploadId: string,
    ): MediaUpload | null | undefined {
      if (!this.#store.bind(workspaceIdentitySchema.parse(workspace))) {
        return undefined;
      }
      return this.#store.beginUpload(mediaId, uploadId) ?? null;
    }

    /**
     * Notes a part of an upload that the bucket has: `uploadedPart` of
     * the store. Returns how far the upload has come, null if it is not
     * the upload of the image any more, and nothing if `workspace` is not
     * the one that the object holds.
     */
    uploadedPart(
      workspace: WorkspaceIdentity,
      mediaId: string,
      uploadId: string,
      part: { partNumber: number; etag: string },
    ): MediaUpload | null | undefined {
      if (!this.#store.bind(workspaceIdentitySchema.parse(workspace))) {
        return undefined;
      }
      return this.#store.uploadedPart(mediaId, uploadId, part) ?? null;
    }

    /**
     * Ends the upload of an image with what the Worker found in its
     * bytes, or with why it has none. The clients that are connected see
     * the image as `ready` or `failed`. With a `key` it is carried out
     * once. Returns what was done, with the status that the row has
     * afterwards, and nothing if `workspace` is not the one that the
     * object holds.
     */
    finishUpload(
      workspace: WorkspaceIdentity,
      mediaId: string,
      outcome: UploadOutcome,
      key?: string,
    ): FinishedUpload | undefined {
      if (!this.#store.bind(workspaceIdentitySchema.parse(workspace))) {
        return undefined;
      }
      const from = this.#store.seq;
      const ended = this.#store.finishUpload(
        mediaId,
        outcome,
        now().getTime(),
        callKeySchema.optional().parse(key),
      );
      this.#publish(from);
      return ended;
    }

    /**
     * Stores the credentials that a refresh returned, sealed, in place of
     * `expected`, the ones that it started from, and returns whether it
     * did: not if the channel holds others by now. Returns nothing if
     * `workspace` is not the one that the object holds.
     */
    renewChannelAccess(
      workspace: WorkspaceIdentity,
      channelId: string,
      expected: string,
      access: RenewedChannelAccess,
    ): boolean | undefined {
      if (!this.#store.bind(workspaceIdentitySchema.parse(workspace))) {
        return undefined;
      }
      const from = this.#store.seq;
      const renewed = this.#store.renewChannelAccess(
        channelId,
        expected,
        access,
        now().getTime(),
      );
      this.#publish(from);
      return renewed;
    }

    /**
     * Looks after what the workspace does by itself. It takes up the
     * scheduled posts whose time has come, and deletes the ones that
     * were put aside a day ago. It ends the deliveries whose
     * workflow is over without having said so, and begins the ones whose
     * turn has come, each as a run of the publishing workflow. Then it
     * renews the access of every channel whose time for that has come,
     * and begins the deliveries that waited for one of those. Then it
     * keeps the inbox, looks after the images, `#keepMedia`, and looks
     * through the bucket for bytes that no row names, `#sweepMedia`. Last
     * it sends the push messages that wait, `#sendPushes`, and reads the
     * stats of the deliveries whose time for that has come,
     * `#metricsPass`: both beside itself, so that neither keeps a delivery
     * or a scheduled post waiting, `#waitAside`. A renewal, an image and a
     * look through the bucket that come due while it waits for them wait
     * with it: see `#untilNextPost`.
     *
     * It runs at the moment that `#nextLookIn` names: when the next
     * scheduled post is due, soon after anything changes that can make a
     * delivery begin or that queues a push message, every
     * `deliveryWatchMs` while a delivery is under way or a push message
     * waits, and when the next access, the inbox, an image, a look
     * through the bucket or the stats of a delivery are due.
     *
     * What goes wrong in looking after them does not fail the alarm: it
     * is logged, and tried again the next time. The one thing that does
     * is that the next alarm could not be set. Nothing would look after
     * the workspace then, until something else woke its object, so the
     * alarm fails and leaves it to the runtime to run it again, which it
     * does some times, with a growing pause.
     */
    override async alarm(): Promise<void> {
      this.#looking = true;
      this.#alarms += 1;
      try {
        // Each by itself: a platform that does not say how its runs are
        // doing must not keep the next delivery from beginning, and
        // neither may a post that cannot be taken up. The accesses come
        // last: a post that waits to go out is more urgent than an access
        // that is good for weeks. The runtime runs one alarm of an object
        // at a time, and deliveries begin here alone, so none begins
        // while an access is being renewed. One access goes before the
        // post all the same: one whose renewal is overdue, which the
        // deliveries to its channel have kept waiting. No delivery begins
        // there before it was renewed, and the ones that waited for that
        // begin last, in the same alarm.
        // The runs that this alarm could not create, which its second
        // look at the deliveries does not try again: the next alarm does.
        const uncreated = new Set<string>();
        // True if the accesses that are due were not all turned to,
        // because a delivery was ready to begin: the next alarm takes
        // the rest, and comes at once.
        let unfinished = false;
        // True if the alarm stopped waiting for the push messages to be
        // sent, because a delivery asked to begin: it comes back at once.
        let stoodAside = false;
        // The channels whose access this alarm turned to, or undefined
        // if it did not get to say: see `#nextLookIn`.
        let renewed: ReadonlySet<string> | undefined;
        for (const [look, kind, failed] of [
          [
            () => this.#publishDue(),
            "schedule",
            "The scheduled posts of a workspace were not taken up",
          ],
          [
            () => this.#watchDeliveries(),
            "delivery",
            "The deliveries of a workspace were not looked after",
          ],
          [
            () => this.#startDeliveries(uncreated),
            "delivery",
            "The deliveries of a workspace were not looked after",
          ],
          [
            async () => {
              const turnedTo = new Set<string>();
              unfinished = await this.#renewAccesses(turnedTo);
              renewed = turnedTo;
            },
            "renewal",
            "The accesses of a workspace were not renewed",
          ],
          [
            // Only for a delivery that can begin now: one that waited for
            // its access, or that became ready while an access was
            // renewed.
            async () => {
              if (this.#store.deliveriesNeed(now().getTime()) === "begin") {
                await this.#startDeliveries(uncreated);
              }
            },
            "delivery",
            "The deliveries of a workspace were not looked after",
          ],
          [
            // Before the messages are sent: what these say is queued too.
            () => this.#keepInbox(),
            "push",
            "The inbox of a workspace was not kept",
          ],
          [
            // After the deliveries, and bounded: so many images in a
            // look, each a request or two to the bucket. Before the stats
            // are begun, so that the images wait for none of them.
            () => this.#keepMedia(),
            "media",
            "The images of a workspace were not looked after",
          ],
          [
            // After the images, whose deletions ask for it, and bounded:
            // one list of the bucket in a look. Before the stats are
            // begun, as the images are.
            () => this.#sweepMedia(),
            "media",
            "The bucket of a workspace was not looked through",
          ],
          [
            // Begun before the push messages are, and read beside them.
            () => this.#beginMetricsPass(),
            "stats",
            "The stats of a workspace were not read",
          ],
          [
            // Last, with the stats: these wait for the push services and
            // the networks, and leave as soon as a delivery asks to begin.
            async () => {
              stoodAside = await this.#sendPushes();
            },
            "push",
            "The push messages of a workspace were not sent",
          ],
          [
            async () => {
              if (!stoodAside && this.#counting) {
                stoodAside = await this.#waitAside(this.#counting, {
                  pushes: true,
                });
              }
            },
            "stats",
            "The stats of a workspace were not read",
          ],
        ] as const satisfies readonly (readonly [
          () => unknown,
          LogKind,
          string,
        ])[]) {
          try {
            await look();
          } catch (error) {
            log.error(kind, failed, this.#store.where, error);
          }
        }
        // Nothing is awaited between the last look above and this one, so
        // nothing can have come in between: the sending of the push
        // messages is over, or the alarm stood aside, and says so. And
        // nothing else has set the alarm while this one ran, `#looking`,
        // so none is set, and the runtime does not have to be asked.
        const wait = this.#nextLookIn("alarm", {
          unfinished,
          renewed,
          stoodAside,
        });
        const set =
          wait === null
            ? undefined
            : // By the clock of the runtime, which alarms go by.
              this.ctx.storage.setAlarm(Date.now() + wait);
        // From here on a change sets the alarm for itself again.
        this.#looking = false;
        try {
          await set;
        } catch (error) {
          log.error(
            "alarm",
            "The next look at a workspace was not set",
            this.#store.where,
            error,
          );
          // Without its secrets: this goes into the log of the runtime.
          throw new Error("The next look at a workspace was not set");
        }
      } finally {
        this.#looking = false;
      }
    }

    /** The key that push messages are signed with, as it is configured. */
    #vapidKey(): string | undefined {
      return vapidKeyWithoutRequest(this.env, developmentVapidKey);
    }

    /**
     * What the inbox takes by the clock: telling of an access that ends
     * within a week, and removing what is old.
     */
    async #keepInbox(): Promise<void> {
      const from = this.#store.seq;
      try {
        this.#store.warnOfExpiry(now().getTime());
        this.#store.pruneNotifications(now().getTime());
      } finally {
        this.#publish(from);
      }
    }

    /**
     * What the images take by the clock, `mediaDue` of the store, for
     * `mediaPerPass` images of each kind at most:
     *
     * - An upload that was not finished within `uploadLifetimeMs` is
     *   given up: the row says `failed`, and the bucket is told to drop
     *   its parts.
     * - An image that has been in no part for `unattachedMs` is deleted,
     *   with everything that the bucket has of it, and then its row. An
     *   upload that it was on its way in is given up first.
     * - An image whose posts were all sent `originalLifetimeMs` ago
     *   loses its bytes, what was made of them for the networks and the
     *   file as it was sent, if a completion left that, and keeps its
     *   small picture: PLAN.md section 10.
     *
     * The row first and the bucket after, and each image only once it is
     * claimed: `claimMedia` of the store looks at it again in the
     * transaction of the mutator that says what happens to it, and
     * leaves one alone that is something else by then, an upload that
     * was finished meanwhile, an image that a device has put into a
     * draft. The alarm goes through the images with the bucket, and
     * devices change them in the meantime. Only what a claim then says is
     * gone is deleted. If the bucket fails after that, bytes are left
     * that no row names: the log says which, and nothing serves them.
     *
     * The parts of an upload that was given up are the exception: the
     * bucket bills them for as long as it has them, and nothing else
     * names them. So the row keeps the upload until the bucket has
     * dropped them or says that it has no such upload, and the bucket is
     * asked again an hour after it failed, for eight days: by then a
     * lifecycle rule of the bucket has dropped them, and the row lets go
     * of the upload, with a line in the log. A row in no part is deleted
     * only after that.
     *
     * Each image is tried by itself, so one that fails does not keep the
     * others.
     */
    async #keepMedia(): Promise<void> {
      const { id: workspaceId } = this.#store.identity;
      const bucket = this.env.MEDIA;
      const due = this.#store.mediaDue(now().getTime());
      const each = async (
        images: DueMedia[],
        look: (
          image: DueMedia,
          keys: ReturnType<typeof mediaKeys>,
        ) => Promise<void>,
      ) => {
        for (const image of images) {
          const from = this.#store.seq;
          try {
            await look(image, mediaKeys(workspaceId, image.id));
          } catch (error) {
            log.error(
              "media",
              "An image of a workspace was not looked after",
              { ...this.#store.where, mediaId: image.id },
              error,
            );
          } finally {
            this.#publish(from);
          }
        }
      };
      /**
       * Has the bucket drop the parts of the upload `uploadId` of an image
       * whose upload was given up. Returns whether the bucket has none of
       * them any more: it dropped them, or has no such upload, because it
       * was finished, dropped before, or never begun.
       */
      const drop = async (
        id: string,
        uploadId: string | null,
        key: string,
      ): Promise<boolean> => {
        if (uploadId !== null) {
          try {
            await bucket.resumeMultipartUpload(key, uploadId).abort();
          } catch (error) {
            if (noSuchUpload(error)) {
              // Gone: nothing is left to drop.
            } else if (this.#store.dropUploadAgain(id, now().getTime())) {
              log.error(
                "media",
                "The upload of an image was not dropped, and is asked for again in an hour",
                { ...this.#store.where, mediaId: id },
                error,
              );
              return false;
            } else {
              // Asked for eight days: a lifecycle rule of the bucket has
              // dropped the parts by now, if the bucket has one, and the
              // bucket may never say so in the way that `noSuchUpload`
              // reads. Once, and the row lets go of the upload.
              log.error(
                "media",
                "The upload of an image was not dropped in eight days, and is not asked for again: the parts stay unless a lifecycle rule of the bucket drops them",
                { ...this.#store.where, mediaId: id },
                error,
              );
            }
          }
        }
        this.#store.uploadDropped(id);
        return true;
      };
      // Every deletion from the bucket asks for a look through it a day
      // later, for what a deletion that failed may have left.
      const sweep = () => this.#store.askForSweep(now().getTime());
      await each(due.abandoned, async (image, keys) => {
        const claimed = this.#store.claimMedia(
          "abandoned",
          image.id,
          now().getTime(),
        );
        if (claimed?.done !== "given up") return;
        sweep();
        await drop(image.id, claimed.uploadId, keys.upload);
        // A file that the parts made, by a completion that did not get
        // to say how it ended.
        await deleteUnder(bucket, keys.prefix);
      });
      await each(due.unaborted, async (image, keys) => {
        if (!(await drop(image.id, image.uploadId, keys.upload))) return;
        // One in no part waited for this.
        const claimed = this.#store.claimMedia(
          "unattached",
          image.id,
          now().getTime(),
        );
        if (claimed?.done === "deleted") {
          sweep();
          await deleteUnder(bucket, keys.prefix);
        }
      });
      await each(due.unattached, async (image, keys) => {
        let claimed = this.#store.claimMedia(
          "unattached",
          image.id,
          now().getTime(),
        );
        if (claimed?.done === "given up") {
          if (!(await drop(image.id, claimed.uploadId, keys.upload))) return;
          claimed = this.#store.claimMedia(
            "unattached",
            image.id,
            now().getTime(),
          );
        }
        if (claimed?.done === "deleted") {
          sweep();
          await deleteUnder(bucket, keys.prefix);
        }
      });
      await each(due.outlived, async (image, keys) => {
        const claimed = this.#store.claimMedia(
          "outlived",
          image.id,
          now().getTime(),
        );
        if (claimed?.done !== "expired") return;
        sweep();
        // And the file as the device sent it, with what the camera wrote
        // next to the picture: the completion deletes it, and leaves it
        // where the bucket failed it.
        await bucket.delete([keys.original, keys.upload]);
        await deleteUnder(bucket, keys.variants);
      });
    }

    /**
     * Looks through what the bucket has of the workspace for bytes that
     * no row names, when that is asked for, `mediaSweep` of the store,
     * and deletes them: of an image that has no row any more, or whose
     * upload failed, everything, and of one whose row says that its bytes
     * are gone, those bytes. The alarm claims a row first and deletes from
     * the bucket after, so a bucket that fails in between leaves such
     * bytes: every deletion asks for a look, a day later, `askForSweep`.
     *
     * One list of the bucket in a look, `mediaSweepList` names at most,
     * and the next look goes on after the last of them: the bucket of a
     * workspace is gone through in as many looks as it takes. An image
     * has no bytes without its row, which an upload asks the object for
     * before it sends any, so nothing is deleted that a row is about to
     * name.
     */
    async #sweepMedia(): Promise<void> {
      const { at, after } = this.#store.mediaSweep;
      if (at === null || at > now().getTime()) return;
      const { id: workspaceId } = this.#store.identity;
      const bucket = this.env.MEDIA;
      const prefix = `${workspaceId}/`;
      const listed = await bucket.list({
        prefix,
        limit: mediaSweepList,
        ...(after !== null && { startAfter: after }),
      });
      const ids = [
        ...new Set(
          listed.objects.map(
            ({ key }) => key.slice(prefix.length).split("/")[0] ?? "",
          ),
        ),
      ].filter((id) => id !== "");
      for (const [mediaId, what] of this.#store.unnamedMedia(ids)) {
        const keys = mediaKeys(workspaceId, mediaId);
        log.warn(
          "media",
          "The bucket had bytes of an image that no row names: they are deleted now",
          { ...this.#store.where, mediaId },
        );
        if (what === "all") {
          await deleteUnder(bucket, keys.prefix);
        } else {
          // What `outlived` of `#keepMedia` deletes.
          await bucket.delete([keys.original, keys.upload]);
          await deleteUnder(bucket, keys.variants);
        }
      }
      this.#store.sweptTo(
        listed.truncated ? (listed.objects.at(-1)?.key ?? null) : null,
      );
    }

    /**
     * Takes up the scheduled posts whose time has come, and deletes the
     * ones that were put aside long enough ago.
     */
    #publishDue(): void {
      const from = this.#store.seq;
      const time = now().getTime();
      // Before it is tried: what fails here has been tried all the same,
      // and is come back to in a while, not at once.
      this.#store.dueLookedAt = Math.max(this.#store.dueLookedAt, time);
      try {
        this.#store.publishDue(time);
        this.#store.pruneTrashed(time);
      } finally {
        this.#publish(from);
      }
    }

    /**
     * When the alarm is next needed, in milliseconds from now, or null if
     * the object has nothing to do by itself. Everything that sets the
     * alarm asks here, so this is the one list of what the alarm is for.
     * It is the earliest of these moments:
     *
     * - A delivery can begin, or waits for an access that is overdue for
     *   renewal: at once, after a change. The alarm itself has just
     *   tried, so what it leaves so has failed, and it comes back in
     *   `deliveryWatchMs`: never at once, which would be a loop.
     * - A delivery is under way: in `deliveryWatchMs`, to see that it
     *   ends, and to create its workflow if that could not be done.
     * - The alarm stopped renewing accesses for a delivery, `unfinished`:
     *   at once, for the rest of them. It has renewed one at least, so
     *   this ends.
     * - The alarm stopped waiting for a pass beside it, because a change
     *   asked for a delivery to begin, or queued a push message while it
     *   waited for the stats, `stoodAside`: at once, for that delivery or
     *   message. It takes a change to get here, so this ends. The alarm
     *   also stops waiting at the time of a scheduled post, `#waitAside`,
     *   which is no change: what brings it back then is the moment of
     *   that post below.
     * - A delivery waits for an access that is overdue for renewal, and
     *   the alarm did not turn to that access, `renewed`: at once. The
     *   delivery came to wait while the alarm was busy with another
     *   channel, after it had taken its list of the accesses that are
     *   due, on which this one was not: a delivery to its channel was
     *   under way then. The next alarm turns to it, which leaves the
     *   access no longer overdue, whatever comes of it, so this ends
     *   too. Not when the alarm could not say what it turned to, because
     *   renewing failed as a whole: that would be a loop.
     * - A scheduled post is due: at its time. If its time has passed,
     *   and the object has looked for what was due since, it did not
     *   manage to take the post up, and comes back in `deliveryWatchMs`.
     * - A post that was put aside is to be deleted: `trashMs` after it
     *   was put aside, and in `deliveryWatchMs` if the alarm has just
     *   failed to.
     * - A push message waits to be sent: at once after the change that
     *   queued it, `pushQueued`, and at once when the pass before
     *   stopped at its limit, which has sent some, so this ends. Else in
     *   `deliveryWatchMs`: a message that is left then could not be sent
     *   a moment ago, and what failed then fails again, or a pass is
     *   sending it beside the alarm.
     * - An access is to be renewed: at its time, and in `renewalPauseMs`
     *   at the earliest.
     * - The inbox has something to do by the clock, which is to tell of
     *   an access that ends or to remove what is old: at that time, and
     *   in `deliveryWatchMs` at the earliest, which is when it is tried
     *   again if it did not work.
     * - An image is due for something, `mediaDue` of the store: an
     *   upload to give up, an image that is in no part to delete, bytes
     *   to let go of. At that time, and in `deliveryWatchMs` at the
     *   earliest, which is when the rest is taken where a look has done
     *   as many as it does, and when it is tried again if it did not
     *   work.
     * - The bucket is to be looked through for bytes that no row names,
     *   `mediaSweep` of the store: at that time, and in
     *   `deliveryWatchMs` at the earliest, for the same reasons.
     * - The stats of a delivery are to be read: at their time, which is
     *   at once for a delivery that has just been sent. While a pass over
     *   the stats is under way, or the last one stopped short of what was
     *   due, `#metricsBehind`: in `metricsPauseMs` at the earliest. Every
     *   read that a pass gets to leaves its delivery with a later time or
     *   with none, whatever comes of it, so this ends. All but one whose
     *   account was connected again or disconnected while its network was
     *   asked, which stays due, with the pass behind: it takes a change to
     *   get there, so that ends too.
     *
     * `after` says who asks: a change, or the alarm when it has looked.
     */
    #nextLookIn(
      after: "change" | "alarm",
      {
        unfinished = false,
        renewed,
        stoodAside = false,
        pushQueued = false,
      }: {
        unfinished?: boolean;
        renewed?: ReadonlySet<string> | undefined;
        stoodAside?: boolean;
        pushQueued?: boolean;
      } = {},
    ): number | null {
      const time = now().getTime();
      const waits: number[] = [];
      const need = this.#store.deliveriesNeed(time);
      if (need !== "nothing") {
        waits.push(
          after === "change" && need !== "watch" ? 0 : deliveryWatchMs,
        );
      }
      if (unfinished || stoodAside) waits.push(0);
      if (
        need === "renew" &&
        renewed &&
        [...this.#store.awaitingRenewal(time)].some(
          (channelId) => !renewed.has(channelId),
        )
      ) {
        waits.push(0);
      }
      const pruneAt = this.#store.nextPruneAt;
      if (pruneAt !== null) {
        waits.push(
          Math.max(after === "alarm" ? deliveryWatchMs : 0, pruneAt - time),
        );
      }
      const dueAt = this.#store.nextDueAt;
      if (dueAt !== null) {
        waits.push(
          dueAt > this.#store.dueLookedAt
            ? Math.max(0, dueAt - time)
            : deliveryWatchMs,
        );
      }
      if (this.#store.pushesWait) {
        waits.push(pushQueued || this.#passStopped ? 0 : deliveryWatchMs);
      }
      const renewal = this.#store.nextRenewalAt;
      if (renewal !== null) {
        waits.push(Math.max(renewalPauseMs, renewal - time));
      }
      const inbox = this.#store.nextInboxAt;
      if (inbox !== null) {
        waits.push(Math.max(deliveryWatchMs, inbox - time));
      }
      const images = this.#store.nextMediaAt;
      if (images !== null) {
        waits.push(Math.max(deliveryWatchMs, images - time));
      }
      const sweep = this.#store.mediaSweep.at;
      if (sweep !== null) {
        waits.push(Math.max(deliveryWatchMs, sweep - time));
      }
      const metricsAt = this.#store.nextMetricsAt;
      if (metricsAt !== null) {
        waits.push(
          Math.max(this.#metricsBehind ? metricsPauseMs : 0, metricsAt - time),
        );
      }
      // The runtime sets no alarm for a time that is centuries away, and
      // a post can be scheduled for one. The alarm comes back before
      // then, finds nothing to do, and is set anew.
      return waits.length === 0 ? null : Math.min(farthestLookMs, ...waits);
    }

    /**
     * Sets the alarm to the moment that `#nextLookIn` names, after a
     * change, unless it is set to that moment or an earlier one already:
     * a change brings the alarm forward and never puts it off, so the
     * look at a delivery under way stays where it is whatever is
     * scheduled after it. Every `setAlarm` of the object is here or at the
     * end of `alarm`.
     *
     * An alarm that is needed at once is set at once, in the same turn as
     * the change that it follows: it is stored with that change, so it
     * runs also if the object stops before it gets there. For a later
     * moment the runtime is asked what is set. It alone knows: a record
     * of the object's own would be wrong after an alarm that failed, and
     * for an object from before it had one. The answer takes a moment in
     * which more can change, so the moment is worked out anew when the
     * answer is there, and nothing is awaited between that and setting
     * the alarm. An alarm that began to run in that moment sets the next
     * one itself.
     *
     * While the alarm runs this does nothing: the alarm sets the next one
     * when it is done, from what it finds then, and a change of its own
     * would have it run again at once, for what it is about to do.
     *
     * By the clock of the runtime, which is the one that alarms go by.
     * The times of posts and accesses are by the clock that the object
     * was made with, which is another one in a test: the alarm is set as
     * far ahead as the moment is by that clock.
     */
    async #setNextAlarm(pushQueued = false): Promise<void> {
      if (this.#looking) return;
      let wait = this.#nextLookIn("change", { pushQueued });
      if (wait === null) return;
      if (wait > 0) {
        const alarms = this.#alarms;
        const set = await this.ctx.storage.getAlarm();
        if (this.#looking || alarms !== this.#alarms) return;
        wait = this.#nextLookIn("change", { pushQueued });
        if (wait === null) return;
        if (wait > 0 && set !== null && set <= Date.now() + wait) return;
      }
      await this.ctx.storage.setAlarm(Date.now() + wait);
    }

    /**
     * Renews the access of every channel that is due for it: see
     * renewal.ts. Each outcome is stored before the next channel is
     * turned to, and each leaves its channel with a later time to renew
     * at, or with none.
     *
     * A renewal waits for a network, for up to half a minute, and no
     * delivery begins meanwhile. So it stops after a channel when a
     * delivery has become ready to begin: the alarm that the change set
     * for it, `#wake`, begins it and takes the rest of the channels. So
     * too when the delivery is one that waited for this renewal, which
     * the alarm begins as its last step.
     *
     * Returns whether it stopped so with channels left to turn to, and
     * notes in `turnedTo` the channels that it turned to.
     */
    async #renewAccesses(turnedTo: Set<string>): Promise<boolean> {
      const workspace = this.#store.identity;
      const due = this.#store.renewalsDue(now().getTime());
      for (const [index, channel] of due.entries()) {
        const { channelId, credentials } = channel;
        turnedTo.add(channelId);
        const renewal = await renewAccess(
          dependencies,
          this.env,
          workspace,
          channel,
        );
        const from = this.#store.seq;
        try {
          switch (renewal.kind) {
            case "renewed": {
              const kept = this.#store.renewChannelAccess(
                channelId,
                credentials,
                renewal.access,
                now().getTime(),
              );
              // The channel was disconnected or connected again while
              // its network was asked: it does not hold what was renewed.
              if (!kept) await renewal.discard();
              break;
            }
            case "lapsed":
              this.#store.mutate(
                {
                  name: "channel.lapse",
                  args: {
                    id: channelId,
                    connectedAt: channel.connectedAt,
                  } satisfies MutatorArgs<"channel.lapse">,
                },
                now().getTime(),
              );
              break;
            case "later":
              this.#store.postponeRenewal(channelId, credentials, renewal.at);
              break;
            case "never":
              this.#store.postponeRenewal(channelId, credentials, null);
              break;
          }
        } catch (error) {
          log.error(
            "renewal",
            "What came of renewing the access of a channel was not stored",
            { ...this.#store.where, channelId },
            error,
          );
          // Not left due, or the alarm would come straight back to it.
          this.#store.postponeRenewal(
            channelId,
            credentials,
            now().getTime() + renewalBrokenMs,
          );
        }
        this.#publish(from);
        if (this.#store.deliveriesNeed(now().getTime()) === "begin") {
          return index < due.length - 1;
        }
      }
      return false;
    }

    /**
     * Sends the push messages that wait to the devices of the owner, and
     * waits until they are sent, unless something more urgent comes up.
     *
     * A push service can be slow, and one that does not answer keeps a
     * message waiting for ten seconds for every round of devices. An
     * alarm that waited all of that out would keep the deliveries and the
     * accesses waiting with it: the runtime runs one alarm at a time. So
     * the sending is a pass of its own, `#pushPass`, which the alarm
     * begins as the last thing it does, and which it leaves to itself
     * as soon as a change asks for a delivery to begin: `#wake` says so
     * here. The alarm then ends and runs again at once, for the delivery,
     * and the pass goes on beside it. An alarm that comes while a pass is
     * under way begins no second one.
     *
     * Returns whether the alarm left the pass to itself so.
     */
    async #sendPushes(): Promise<boolean> {
      if (!this.#pushing && !this.#store.pushesWait) return false;
      if (!this.#pushing) {
        this.#passStopped = false;
        this.#pushing = this.#pushPass()
          .catch((error: unknown) =>
            log.error(
              "push",
              "The push messages of a workspace were not sent",
              this.#store.where,
              error,
            ),
          )
          .finally(() => {
            this.#pushing = null;
            // For a pass that the alarm has left to itself. One that the
            // alarm waits for sets nothing: the end of the alarm does.
            if (this.#passStopped) {
              this.#setNextAlarm().catch((error: unknown) =>
                log.error(
                  "alarm",
                  "The next look at a workspace was not set",
                  this.#store.where,
                  error,
                ),
              );
            }
          });
      }
      return this.#waitAside(this.#pushing, { pushes: false });
    }

    /**
     * Waits for `pass`, a pass that the alarm has begun beside itself, to
     * end, unless something comes first that the alarm has to do: a
     * delivery that a change asks to begin, or with `pushes` a push
     * message that a change queues, which `#wake` says here, and the time
     * of the next scheduled post, `#untilNextPost`. Returns whether it
     * stopped waiting for a change. The pass goes on all the same.
     *
     * A pass can wait for a network or a push service for a minute and
     * more, and the alarm, which takes up the posts and renews the
     * accesses, does not run meanwhile: the runtime runs one at a time.
     * Time that passes is no change that `#wake` hears of, so the alarm
     * stops waiting by itself when a post is due, and comes back for it
     * at once: `#nextLookIn` has it due then.
     */
    async #waitAside(
      pass: Promise<void>,
      { pushes }: { pushes: boolean },
    ): Promise<boolean> {
      let stoodAside = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      try {
        await Promise.race([
          pass,
          new Promise<void>((resolve) => {
            // By the clock of the runtime, as far ahead as the moment is
            // by the clock of the workspace, as the alarm is set.
            const rearm = () => {
              if (timer !== null) clearTimeout(timer);
              const wait = this.#untilNextPost();
              if (wait !== null) timer = setTimeout(resolve, wait);
            };
            this.#aside = {
              stand: () => {
                stoodAside = true;
                resolve();
              },
              rearm,
              pushes,
            };
            rearm();
          }),
        ]);
      } finally {
        this.#aside = null;
        // Nothing that runs in the object leaves a timer behind: the
        // runtime would keep it busy for as long as one is pending.
        if (timer !== null) clearTimeout(timer);
      }
      return stoodAside;
    }

    /**
     * In how many milliseconds the alarm has a scheduled post to take up,
     * by the clock of the workspace, or null if none is ahead: when the
     * alarm stops waiting for a pass beside it. A post whose time the
     * alarm has looked for already is one that it could not take up, and
     * waits for a later alarm, `#nextLookIn`, and not for this.
     *
     * Not the renewal of an access, which waits for the pass: an access
     * is good for weeks when its renewal comes due, and the alarm keeps a
     * minute between two looks for renewals all the same, `renewalPauseMs`.
     * The alarm has two waits in a row, for the push messages and for the
     * stats, and a time that passed in the first is one that the second
     * would have to know that it did not look for, as it knows of a post
     * by `dueLookedAt`: for a renewal, nothing to win. Nor what an image is
     * due for, or a look through the bucket, for the same reasons: each
     * comes due hours or days after what it waits for, and the alarm
     * keeps `deliveryWatchMs` between two looks at the images, and at the
     * bucket. The alarm looks after the images, and through the bucket,
     * before it begins the stats, so those never wait for a pass that it
     * begins.
     */
    #untilNextPost(): number | null {
      const dueAt = this.#store.nextDueAt;
      return dueAt !== null && dueAt > this.#store.dueLookedAt
        ? Math.max(0, dueAt - now().getTime())
        : null;
    }

    /**
     * Begins a pass over the stats that are due, `#metricsPass`, unless one
     * is under way or none is due: the alarm waits for it with the push
     * messages, and leaves it to itself as it leaves those. An alarm that
     * comes while a pass is under way begins no second one.
     */
    #beginMetricsPass(): void {
      if (this.#counting) return;
      const due = this.#store.nextMetricsAt;
      if (due === null || due > now().getTime()) {
        this.#metricsBehind = false;
        return;
      }
      this.#metricsBehind = true;
      this.#counting = this.#metricsPass()
        .catch((error: unknown) =>
          log.error(
            "stats",
            "The stats of a workspace were not read",
            this.#store.where,
            error,
          ),
        )
        .finally(() => {
          this.#counting = null;
        });
    }

    /**
     * One pass over the stats that are due, the ones that were due first
     * first: stats.ts reads each, and what came of it is stored before
     * the next is read, with the time of the next read. A network that
     * asks to be asked later is asked no more in this pass, and the reads
     * of its channel that are due wait with the one that it refused. A
     * read during which its account was connected again is stored nothing
     * of: the pass reads with the access that its list was taken with,
     * and the read stays due for a later one, with the new access.
     *
     * A pass makes `metricsPerPass` reads at most and takes up no new one
     * after `metricsPassMs`. What is left goes with a later pass, which
     * `#nextLookIn` asks for in `metricsPauseMs`: a workspace that has
     * sent hundreds of posts at once asks their networks a few at a time.
     */
    async #metricsPass(): Promise<void> {
      // By the clock of the runtime: this is about how long the object
      // has been at it, not about a time in the workspace.
      const began = Date.now();
      const workspace = this.#store.identity;
      // The channels whose network asked to be asked later, and those
      // that were connected again since the list was taken.
      const resting = new Set<string>();
      // Whether a read is left due for a later pass.
      let leftDue = false;
      const list = this.#store.metricsDue(now().getTime(), metricsPerPass);
      for (const due of list) {
        if (Date.now() - began >= metricsPassMs) return;
        if (due.channel && resting.has(due.channel.channelId)) continue;
        const outcome = await readMetrics(
          dependencies,
          this.env,
          workspace,
          due,
        );
        // The account was connected again, or disconnected, while its
        // network was asked: what the read found is of the access
        // before, which a new connection can have made good, as the
        // permission that an old Threads account lacked. It is stored
        // nothing of, and the read stays due, as do the other reads of
        // the channel on this list, which has the access before: a
        // later pass reads them with the new one. The connection does
        // not bring them forward, being due already. Never at once:
        // the pass is behind, `#metricsBehind`.
        if (
          due.channel &&
          this.#store.channelAccess(due.channel.channelId)?.connectedAt !==
            due.channel.connectedAt
        ) {
          resting.add(due.channel.channelId);
          leftDue = true;
          continue;
        }
        const from = this.#store.seq;
        try {
          if (outcome.rest !== undefined && due.channel) {
            // Its network asked to be asked later: so are the other reads
            // of the channel until then, also where this one is given
            // up, and this pass asks it nothing more.
            resting.add(due.channel.channelId);
            this.#store.postponeMetricsOf(due.channel.channelId, outcome.rest);
          }
          this.#store.recordMetrics(
            due.targetId,
            outcome.reading,
            outcome.next,
            now().getTime(),
          );
        } catch (error) {
          log.error(
            "stats",
            "What came of reading the stats of a delivery was not stored",
            { ...this.#store.where, targetId: due.targetId },
            error,
          );
          // Not left due, or the next pass would come straight back to
          // it.
          this.#store.recordMetrics(
            due.targetId,
            null,
            now().getTime() + metricsBrokenMs,
            now().getTime(),
          );
        }
        this.#publish(from);
      }
      // All that was due is read, unless the list stopped at its limit,
      // and there may be more, or a read was left due.
      if (list.length < metricsPerPass && !leftDue) {
        this.#metricsBehind = false;
      }
    }

    /**
     * One pass over the push messages that wait, the oldest first. A
     * message is taken off the queue when it has been handed to the push
     * services, whatever each of them said: a device that cannot be
     * reached is told by its push service later, or reads the inbox. It
     * stays when the devices could not be read, which ends the pass, and
     * is tried with the next alarm, for as long as the store keeps it.
     *
     * A pass sends `pushesPerPass` messages at most and takes up no new
     * one after `pushPassMs`. What is left then goes with the next alarm,
     * which is asked for at once, `#passStopped`: in between, that alarm
     * looks after the deliveries and the accesses, also where nothing has
     * woken it.
     */
    async #pushPass(): Promise<void> {
      // By the clock of the runtime: this is about how long the object
      // has been at it, not about a time in the workspace.
      const began = Date.now();
      const key = await vapidKeyOf(this.#vapidKey());
      const { ownerId } = this.#store.identity;
      for (let sent = 0; ; sent += 1) {
        // Read anew each time: a message can be queued while one is sent.
        const [next] = this.#store.queuedPushes(now().getTime());
        if (!next) return;
        if (sent >= pushesPerPass || Date.now() - began >= pushPassMs) {
          this.#passStopped = true;
          return;
        }
        // A pigy without a key sends nothing, and keeps nothing to send.
        if (key) {
          await pushToDevices(
            { db: drizzle(this.env.DB), fetch, now, key },
            ownerId,
            next.message,
            // What a push service knows a message by, to put a later one
            // in its place: the ID of the notification, which is 32
            // characters without its dashes.
            next.notificationId.replaceAll("-", ""),
          );
        }
        this.#store.pushed(next.id);
      }
    }

    /**
     * Begins every delivery whose turn it is and creates its workflow,
     * until there is none left to begin.
     *
     * The target is `sending` before its workflow exists, so that the
     * workflow finds it so. If the object stops in between, the alarm runs
     * again and creates the workflow then: its ID is this delivery's and
     * no other's, see `deliveryInstanceId`, so it is created once however
     * often this is tried.
     *
     * A workflow that cannot be created does not keep the others from
     * being created: the deliveries to other channels have nothing to do
     * with it. It is logged, and left for the next alarm: `failed` has
     * the runs that this alarm could not create, and takes the ones that
     * this look cannot.
     */
    async #startDeliveries(failed: Set<string>): Promise<void> {
      for (;;) {
        const from = this.#store.seq;
        this.#store.startDeliveries(now().getTime());
        this.#publish(from);
        const runs = this.#store
          .deliveries(false)
          .filter((run) => !failed.has(this.#runId(run)));
        if (runs.length === 0) return;
        const workspace = this.#store.identity;
        for (const run of runs) {
          const { targetId, attempt } = run;
          const id = this.#runId(run);
          try {
            try {
              release(
                await this.env.PUBLISH.create({
                  id,
                  params: { workspace, targetId, attempt },
                }),
              );
            } catch (error) {
              // Created by an earlier try that did not get to say so, if
              // it is there: a run under this ID is this delivery's own.
              // `get` fails for an instance that does not exist.
              release(
                await this.env.PUBLISH.get(id).catch(() => {
                  throw error;
                }),
              );
            }
          } catch (error) {
            failed.add(id);
            log.error(
              "delivery",
              "The workflow of a delivery was not created",
              { ...this.#store.where, targetId: run.targetId },
              error,
            );
            continue;
          }
          this.#store.dispatched(run);
        }
      }
    }

    /**
     * Ends the deliveries whose workflow is over and has not ended them:
     * it failed in a way that it could not report, or somebody stopped it.
     * Nothing else would ever end such a delivery, and the ones behind it
     * would wait for good. How far it got is not known, so a person has to
     * look.
     */
    async #watchDeliveries(): Promise<void> {
      for (const run of this.#store.deliveries(true)) {
        let over: boolean;
        try {
          over = await this.#isOver(run);
        } catch (error) {
          // Nothing is known of this one, which the next look makes up
          // for. The others are looked at all the same: one of them may be
          // over, and its channel waits for it.
          log.error(
            "delivery",
            "The workflow of a delivery could not be asked how it is",
            { ...this.#store.where, targetId: run.targetId },
            error,
          );
          continue;
        }
        if (!over) continue;
        const from = this.#store.seq;
        const ended = this.#store.endDelivery(
          {
            id: run.targetId,
            attempt: run.attempt,
            status: "uncertain",
            error: lostTrackMessage,
            refusedConnection: null,
          },
          now().getTime(),
        );
        // Refused if the workflow has ended the delivery after all, in the
        // moment that it took to ask: then nothing was wrong.
        if (ended.ok) {
          log.error(
            "delivery",
            "The workflow of a delivery ended without a word",
            { ...this.#store.where, targetId: run.targetId },
          );
        }
        this.#publish(from);
      }
    }

    /** The ID of the run of the workflow that carries a delivery. */
    #runId({ targetId, startedAt }: StartedDelivery): string {
      return deliveryInstanceId({
        workspaceId: this.#store.identity.id,
        targetId,
        startedAt,
      });
    }

    /** Whether the workflow of a delivery has stopped for good. */
    async #isOver(run: StartedDelivery): Promise<boolean> {
      let status: InstanceStatus["status"];
      try {
        const instance = await this.env.PUBLISH.get(this.#runId(run));
        try {
          ({ status } = await instance.status());
        } finally {
          release(instance);
        }
      } catch (error) {
        // Gone: its record was deleted, which happens only to one that is
        // over. Any other failure says nothing about the workflow.
        if (/not[_ ]found/i.test(String(error))) return true;
        throw error;
      }
      // A workflow that completes ends its delivery first. One that has
      // completed and left the delivery under way has not done its work.
      return (
        status === "errored" || status === "terminated" || status === "complete"
      );
    }

    override webSocketMessage(
      socket: WebSocket,
      message: string | ArrayBuffer,
    ): void {
      try {
        this.#receive(socket, message);
      } catch (error) {
        // A bug or a failed write. Whatever the message asked for did not
        // happen, so the client is told to start over rather than left to
        // wait for an answer.
        log.error("sync", "A sync message failed", this.#store.where, error);
        abandon(socket);
      }
    }

    #receive(socket: WebSocket, message: string | ArrayBuffer): void {
      // A message that was on its way when the object closed the socket.
      // The client has been told to start over.
      if (socket.readyState !== WebSocket.OPEN) return;
      const state = stateOf(socket);
      // If not, the message is not processed. The client sends it again on
      // the socket that it opens next, if its session still lets it.
      if (!usable(socket, state, now().getTime())) return;
      if (typeof message !== "string") {
        fail(socket, "invalid_message", "Messages are JSON text");
        return;
      }
      if (message.length > syncLimits.clientMessageLength) {
        fail(
          socket,
          "message_too_large",
          `A message is at most ${syncLimits.clientMessageLength} characters long`,
        );
        return;
      }
      let json: unknown;
      try {
        json = JSON.parse(message);
      } catch {
        fail(socket, "invalid_message", "Messages are JSON text");
        return;
      }

      // Before anything else, because a client that speaks another version
      // may send a hello that this one cannot read.
      const versions = helloVersionsSchema.safeParse(json);
      if (
        versions.success &&
        (versions.data.protocolVersion !== syncProtocolVersion ||
          versions.data.schemaVersion !== syncSchemaVersion)
      ) {
        fail(
          socket,
          "version_mismatch",
          "The client and the server speak different versions",
        );
        return;
      }

      const parsed = clientMessageSchema.safeParse(json);
      if (!parsed.success) {
        const [issue] = parsed.error.issues;
        const path = issue?.path.join(".");
        const text = issue?.message ?? "The message is invalid";
        fail(socket, "invalid_message", path ? `${path}: ${text}` : text);
        return;
      }
      switch (parsed.data.type) {
        case "hello":
          this.#hello(socket, state, parsed.data);
          break;
        case "mutate":
          this.#mutate(socket, state, parsed.data);
          break;
        case "ping":
          // A ping that the runtime did not answer by itself, because it
          // was not spelled exactly like `pingMessageText`.
          socket.send(pongMessageText);
          break;
      }
    }

    #hello(socket: WebSocket, state: SocketState, hello: HelloMessage): void {
      if (state.clientId !== null) {
        fail(socket, "invalid_message", "This socket has said hello already");
        return;
      }
      // A client has one socket: the one it opened last. Another with the
      // same client ID is one that the client has given up, or that of
      // another tab over the same copy. Left open, it would get the answers
      // to mutations that were sent on this one, and each of the two would
      // see the other move the cursor they share. This socket is not among
      // the others: it has no client ID yet.
      const others = this.ctx
        .getWebSockets()
        .filter(
          (other) =>
            other.readyState === WebSocket.OPEN &&
            stateOf(other).clientId === hello.clientId,
        );
      // Which of them is the newer one goes by when they were opened, not
      // by when their hellos arrive. On a bad connection a client gives up
      // a socket whose hello is still on its way, and that hello can get
      // here after the one of the socket that the client opened next. If
      // it closed that socket, the client would be left with none.
      if (others.some((other) => stateOf(other).order > state.order)) {
        socket.close(syncCloseCodes.replaced, "Replaced by a newer socket");
        return;
      }
      for (const other of others) {
        other.close(syncCloseCodes.replaced, "Replaced by a newer socket");
      }
      socket.serializeAttachment({
        ...state,
        clientId: hello.clientId,
      } satisfies SocketState);
      this.#wake();
      send(
        socket,
        this.#store.changesSince(hello.cursor),
        this.#store.lastMutationId(hello.clientId),
        // The rejections that the client has not seen: the answer that told
        // of them was lost. The ones it has seen are forgotten here.
        this.#store.acknowledge(hello.clientId, hello.lastMutationId),
      );
    }

    #mutate(socket: WebSocket, state: SocketState, message: MutateMessage) {
      const { clientId } = state;
      if (clientId === null) {
        fail(socket, "invalid_message", "The first message must be a hello");
        return;
      }
      const { mutations } = message;
      const processed = this.#store.lastMutationId(clientId);
      // The IDs in a message increase by one, so the first tells whether
      // one is missing in between.
      if ((mutations[0]?.id ?? 0) > processed + 1) {
        fail(
          socket,
          "mutation_gap",
          `The mutation after ${processed} is missing`,
        );
        return;
      }
      // What was processed before is skipped: the client sends a mutation
      // again when it does not know whether the first time arrived.
      const fresh = mutations.filter((mutation) => mutation.id > processed);
      if (
        fresh.length > 0 &&
        this.#store.rejectionCount(clientId) >= maxRejectionsKept
      ) {
        // No more are kept until the client has said how many it has seen,
        // which it does in a hello. The message is not processed: the
        // client sends it again on the socket that it opens next.
        socket.close(syncCloseCodes.reconnect, "Connect again");
        return;
      }
      const from = this.#store.seq;
      const rejected = this.#store.applyFrom(clientId, fresh, now().getTime());
      this.#publish(from, { socket, rejected });
    }

    /**
     * Sends the changes since the cursor `from` to every client. The socket
     * that asked for them gets an answer even if nothing changed: it tells
     * the client that its mutations were processed, in the same message as
     * what they changed.
     *
     * The changes are committed by now, so this does not throw. A socket
     * that it cannot send them to is closed instead, for its client to
     * connect again and get them from its cursor: none is left open without
     * them, where it would wait for nothing.
     *
     * Every change of the workspace passes through here, so this is also
     * where the object sees whether a change has made a delivery ready to
     * begin.
     */
    #publish(
      from: number,
      origin?: { socket: WebSocket; rejected: Rejection[] },
    ): void {
      this.#wake();
      const sockets = this.ctx
        .getWebSockets()
        .filter((socket) => socket.readyState === WebSocket.OPEN);
      let patch: Patch;
      try {
        patch = this.#store.changesSince(from);
      } catch (error) {
        // Nobody can be told what changed, so everybody may be behind.
        log.error(
          "sync",
          "The changes of a workspace were not sent",
          this.#store.where,
          error,
        );
        for (const socket of sockets) abandon(socket);
        return;
      }
      const time = now().getTime();
      for (const socket of sockets) {
        // Each socket by itself: what goes wrong for one must not keep the
        // changes from the ones after it.
        try {
          const state = stateOf(socket);
          // A socket that has not said hello is not behind: its hello is
          // answered with everything.
          if (state.clientId === null) continue;
          const isOrigin = socket === origin?.socket;
          if (patch.changes.length === 0 && !isOrigin) continue;
          if (!usable(socket, state, time)) continue;
          send(
            socket,
            patch,
            this.#store.lastMutationId(state.clientId),
            isOrigin ? origin.rejected : [],
          );
        } catch (error) {
          log.error(
            "sync",
            "The changes of a workspace were not sent",
            this.#store.where,
            error,
          );
          abandon(socket);
        }
      }
    }

    /**
     * Has the alarm run when a change has given the object something to
     * do by itself: at once if a delivery is ready to begin, because a
     * post was published or the delivery before it has ended, or has to
     * wait for an access that is overdue for renewal, which the alarm
     * renews first, and at once for a push message that the change has
     * queued. Later for a post that was scheduled, an access that was
     * given a time to be renewed at or something that the inbox does by
     * the clock, if that is before the time that the alarm is set to.
     * Also when a client says hello: a
     * workspace from before the object had something to do by itself has
     * no alarm, and gets one when somebody next opens it.
     *
     * `#nextLookIn` has what a change does not bring the alarm forward
     * for. A delivery that is under way without its workflow, because the
     * workflow could not be created, is nothing that a change has brought
     * about, and nothing that this change makes any better: the alarm
     * tries again when its own time comes. Brought forward for it, the
     * alarm would run at every message of a client, a keystroke included,
     * for as long as the platform does not create workflows.
     */
    #wake(): void {
      // The change that led here is committed. If this fails, the posts,
      // the deliveries and the accesses wait for the next change or the
      // next alarm.
      const failed = (error: unknown) =>
        log.error(
          "alarm",
          "The next look at a workspace was not set",
          this.#store.where,
          error,
        );
      try {
        // A push message that this change has queued is sent at once:
        // `#nextLookIn`.
        let pushQueued = this.#store.takePushQueued();
        if (pushQueued && this.#vapidKey() === undefined) {
          // A pigy without a key sends nothing, and keeps nothing to
          // send: the inbox has what the message would have told of.
          this.#store.dropQueuedPushes();
          pushQueued = false;
        }
        if (this.#aside) {
          // An alarm that waits for a pass beside it is in the way of a
          // delivery that this change has made ready, and while it waits
          // for the stats, of a push message that this change has queued:
          // it ends here, the pass goes on, and it comes back at once.
          // Otherwise this change may have brought a scheduled post
          // nearer, whose time it stops waiting at.
          const need = this.#store.deliveriesNeed(now().getTime());
          if (
            need === "begin" ||
            need === "renew" ||
            (pushQueued && this.#aside.pushes)
          ) {
            this.#aside.stand();
          } else {
            this.#aside.rearm();
          }
        }
        this.#setNextAlarm(pushQueued).catch(failed);
      } catch (error) {
        failed(error);
      }
    }
  };
}

function stateOf(socket: WebSocket): SocketState {
  return socket.deserializeAttachment() as SocketState;
}

/**
 * Sends `patch`, in as many messages as it takes to keep each from growing
 * past `syncLimits.patchChangesLength`. Throws if the socket does not take
 * them: whoever calls this closes the socket then.
 */
function send(
  socket: WebSocket,
  patch: Patch,
  lastMutationId: number,
  rejected: Rejection[],
): void {
  const messages: Change[][] = [];
  let changes: Change[] = [];
  let length = 0;
  for (const change of patch.changes) {
    const changeLength = JSON.stringify(change).length;
    if (
      changes.length > 0 &&
      length + changeLength > syncLimits.patchChangesLength
    ) {
      messages.push(changes);
      changes = [];
      length = 0;
    }
    changes.push(change);
    length += changeLength;
  }
  // Also when there are no changes: a patch is at least one message.
  messages.push(changes);
  const frames = messages.map((part, index) =>
    JSON.stringify({
      type: "patch",
      from: patch.from,
      to: patch.to,
      changes: part,
      more: index < messages.length - 1,
      lastMutationId,
      rejected,
    } satisfies PatchMessage),
  );
  for (const frame of frames) socket.send(frame);
}

/**
 * Closes a socket whose client may be behind, or waits for an answer that
 * will not come. The client connects again and says where it is.
 */
function abandon(socket: WebSocket): void {
  try {
    socket.close(syncCloseCodes.failure, "Something went wrong");
  } catch {
    // It went away in the meantime.
  }
}

/** Tells the client what it did wrong and closes the socket. */
function fail(socket: WebSocket, code: SyncErrorCode, message: string): void {
  socket.send(
    JSON.stringify({
      type: "error",
      code,
      message,
      protocolVersion: syncProtocolVersion,
      schemaVersion: syncSchemaVersion,
    } satisfies SyncErrorMessage),
  );
  socket.close(syncCloseCodes.error, code);
}

/**
 * Whether the object may still read from `socket` and write to it. If not,
 * the socket is closed in the way that tells its client what to do next.
 */
function usable(socket: WebSocket, state: SocketState, time: number): boolean {
  if (
    state.protocolVersion !== syncProtocolVersion ||
    state.schemaVersion !== syncSchemaVersion
  ) {
    fail(
      socket,
      "version_mismatch",
      "The server was updated to another version",
    );
    return false;
  }
  if (time >= state.expiresAt) {
    // For the client to open another, which takes it past the check of its
    // session again.
    socket.close(syncCloseCodes.reconnect, "Connect again");
    return false;
  }
  return true;
}
