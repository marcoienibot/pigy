import { DurableObject } from "cloudflare:workers";
import {
  type Change,
  type Clock,
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
import type { Bindings } from "../env.ts";
import { loggable } from "../errors.ts";
import {
  deliveryInstanceId,
  lostTrackMessage,
  release,
} from "../publish/delivery.ts";
import {
  type ChannelAccess,
  type ConnectChannelOutcome,
  callKeySchema,
  type Delivery,
  type DeliveryRun,
  type DisconnectChannelOutcome,
  type MutationOutcome,
  type Patch,
  type RenewedChannelAccess,
  type StartedDelivery,
  type StoredChannelAccess,
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
export function workspaceObject({ now }: { now: Clock }) {
  return class WorkspaceObject extends DurableObject<Bindings> {
    readonly #store: WorkspaceStore;

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
     * Runs a mutator for Worker code, such as the REST API. The clients that
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
     * are connected receive the channel, and never the access. Returns
     * nothing if `workspace` is not the one that the object holds.
     */
    connectChannel(
      workspace: WorkspaceIdentity,
      channel: MutatorArgs<"channel.connect">,
      access: ChannelAccess,
    ): ConnectChannelOutcome | undefined {
      if (!this.#store.bind(workspaceIdentitySchema.parse(workspace))) {
        return undefined;
      }
      const from = this.#store.seq;
      const outcome = this.#store.connectChannel(
        channel,
        access,
        now().getTime(),
      );
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
     * Looks after the deliveries: begins the ones whose turn has come,
     * each as a run of the publishing workflow, and ends the ones whose
     * workflow is over without having said so. It runs soon after anything
     * changes that can make a delivery begin, and every `deliveryWatchMs`
     * while one is under way.
     *
     * It never fails: the runtime gives up on an alarm that keeps failing,
     * and the deliveries would wait for ever. What goes wrong is logged,
     * and tried again the next time.
     */
    override async alarm(): Promise<void> {
      // Each by itself: a platform that does not say how its runs are
      // doing must not keep the next delivery from beginning.
      for (const look of [
        () => this.#watchDeliveries(),
        () => this.#startDeliveries(),
      ]) {
        try {
          await look();
        } catch (error) {
          console.error(
            "The deliveries of a workspace were not looked after",
            loggable(error),
          );
        }
      }
      // Nothing is awaited between the last look at the deliveries above
      // and this one, so nothing can have come in between.
      if (this.#store.deliveriesNeed !== "nothing") {
        // By the clock of the runtime, which is the one that alarms go by.
        await this.ctx.storage.setAlarm(Date.now() + deliveryWatchMs);
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
     */
    async #startDeliveries(): Promise<void> {
      for (;;) {
        const from = this.#store.seq;
        this.#store.startDeliveries(now().getTime());
        this.#publish(from);
        const runs = this.#store.deliveries(false);
        if (runs.length === 0) return;
        const workspace = this.#store.identity;
        for (const run of runs) {
          const { targetId, attempt } = run;
          const id = this.#runId(run);
          try {
            release(
              await this.env.PUBLISH.create({
                id,
                params: { workspace, targetId, attempt },
              }),
            );
          } catch (error) {
            // Created by an earlier try that did not get to say so, if it
            // is there: a run under this ID is this delivery's own. `get`
            // fails for an instance that does not exist.
            release(
              await this.env.PUBLISH.get(id).catch(() => {
                throw error;
              }),
            );
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
        if (!(await this.#isOver(run))) continue;
        const from = this.#store.seq;
        const ended = this.#store.mutate(
          {
            name: "target.end",
            args: {
              id: run.targetId,
              attempt: run.attempt,
              status: "uncertain",
              error: lostTrackMessage,
              reconnect: false,
            } satisfies MutatorArgs<"target.end">,
          },
          now().getTime(),
        );
        // Refused if the workflow has ended the delivery after all, in the
        // moment that it took to ask: then nothing was wrong.
        if (ended.ok) {
          console.error(
            `The workflow of the delivery ${this.#runId(run)} ended without a word`,
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
        console.error("A sync message failed", error);
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
        console.error("The changes of a workspace were not sent", error);
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
          console.error("The changes of a workspace were not sent", error);
          abandon(socket);
        }
      }
    }

    /**
     * Has the alarm run at once if a change has made a delivery ready to
     * begin: a post was published, or the delivery before it has ended.
     * The alarm is stored with the change that it follows, so it runs also
     * if the object stops before it gets there.
     */
    #wake(): void {
      // The change that led here is committed. If this fails, the
      // deliveries wait for the next change or the next alarm.
      const failed = (error: unknown) =>
        console.error(
          "The deliveries of a workspace were not looked at",
          error,
        );
      try {
        if (this.#store.deliveriesNeed === "start") {
          this.ctx.storage.setAlarm(Date.now()).catch(failed);
        }
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
