import { DurableObject } from "cloudflare:workers";
import {
  type Change,
  type Clock,
  clientMessageSchema,
  type HelloMessage,
  helloVersionsSchema,
  type MutateMessage,
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
import {
  type Patch,
  type Refusal,
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

/** What the object keeps about a socket. It survives hibernation. */
type SocketState = {
  /** Set by the `hello` of the socket. Until then it receives nothing. */
  clientId: string | null;
  /** When the socket stops being good, in milliseconds since the epoch. */
  expiresAt: number;
  /**
   * What the server spoke when the socket was opened. A socket can stay open
   * while a deploy replaces the code of the object, and with it the
   * versions that its client agreed to in its hello.
   */
  protocolVersion: number;
  schemaVersion: number;
};

/** The result of a mutation that did not come from a client. */
export type MutationOutcome = { ok: true } | ({ ok: false } & Refusal);

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

      const { 0: client, 1: server } = new WebSocketPair();
      this.ctx.acceptWebSocket(server);
      server.serializeAttachment({
        clientId: null,
        expiresAt: time + socketLifetimeMs,
        protocolVersion: syncProtocolVersion,
        schemaVersion: syncSchemaVersion,
      } satisfies SocketState);
      return new Response(null, { status: 101, webSocket: client });
    }

    /**
     * Runs a mutator for Worker code, such as the REST API. The clients that
     * are connected receive the change like any other. Returns nothing if
     * `workspace` is not the one that the object holds.
     */
    mutate(
      workspace: WorkspaceIdentity,
      name: string,
      args: unknown,
    ): MutationOutcome | undefined {
      if (!this.#store.bind(workspaceIdentitySchema.parse(workspace))) {
        return undefined;
      }
      const from = this.#store.seq;
      const [refusal] = this.#store.apply([{ name, args }], now().getTime());
      this.#publish(from);
      return refusal ? { ok: false, ...refusal } : { ok: true };
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
        socket.close(1011, "Something went wrong");
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
      socket.serializeAttachment({
        ...state,
        clientId: hello.clientId,
      } satisfies SocketState);
      send(
        socket,
        this.#store.changesSince(hello.cursor),
        this.#store.lastMutationId(hello.clientId),
        [],
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
      const last = fresh.at(-1);
      const from = this.#store.seq;
      const rejected: Rejection[] = [];
      if (last) {
        const outcomes = this.#store.apply(fresh, now().getTime(), {
          id: clientId,
          lastMutationId: last.id,
        });
        outcomes.forEach((refusal, index) => {
          const id = fresh[index]?.id;
          if (refusal && id !== undefined) rejected.push({ id, ...refusal });
        });
      }
      this.#publish(from, { socket, rejected });
    }

    /**
     * Sends the changes since the cursor `from` to every client. The socket
     * that asked for them gets an answer even if nothing changed: it tells
     * the client that its mutations were processed, in the same message as
     * what they changed.
     */
    #publish(
      from: number,
      origin?: { socket: WebSocket; rejected: Rejection[] },
    ): void {
      const patch = this.#store.changesSince(from);
      const time = now().getTime();
      for (const socket of this.ctx.getWebSockets()) {
        if (socket.readyState !== WebSocket.OPEN) continue;
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
      }
    }
  };
}

function stateOf(socket: WebSocket): SocketState {
  return socket.deserializeAttachment() as SocketState;
}

/**
 * Sends `patch`, in as many messages as it takes to keep each from growing
 * past `syncLimits.patchChangesLength`.
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
  try {
    for (const frame of frames) socket.send(frame);
  } catch {
    // The socket went away in the meantime. Its client connects again and
    // says where it is.
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
