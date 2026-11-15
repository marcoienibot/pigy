import { z } from "zod";
import type { Fetch, Schedule } from "../../dependencies.ts";
import { workspaceListResponseSchema } from "../../workspace.ts";
import {
  type HelloMessage,
  type MutateMessage,
  type PatchMessage,
  pingMessageText,
  type ServerMessage,
  serverMessageSchema,
  syncCloseCodes,
  syncProtocolVersion,
  syncSchemaVersion,
} from "../protocol.ts";
import { applyPatch, type Head, nextBatch, type Step } from "./copy.ts";
import type { ConnectionState, SyncStore } from "./store.ts";

/** A WebSocket, as far as the connection uses one. */
export type Socket = {
  send(text: string): void;
  close(): void;
};

/** What a socket tells the connection, after `OpenSocket` has returned. */
export type SocketEvents = {
  /** The handshake went through. */
  open(): void;
  /** `data` is what the frame held: text, for a message of the protocol. */
  message(data: unknown): void;
  /**
   * The socket is closed, with this code. Without an `open` before it, the
   * handshake failed.
   */
  close(code: number): void;
};

/** Starts the handshake of a socket to the workspace. */
export type OpenSocket = (events: SocketEvents) => Socket;

/** Why a handshake failed, as far as `GET /api/workspaces` tells. */
export type Access =
  /** The session has ended. */
  | "signed-out"
  /** The workspace is not one of whoever is signed in. */
  | "no-access"
  /** Neither: there is no connection, or the server has a problem. */
  | "unknown";

/**
 * Asks the server why a handshake may have failed, as SYNC.md section 2
 * says: a browser does not tell a script. `signal` ends the wait for the
 * answer, which then counts as none.
 */
export async function checkAccess(
  fetch: Fetch,
  workspaceId: string,
  signal?: AbortSignal,
): Promise<Access> {
  let response: Response;
  try {
    response = await fetch("/api/workspaces", signal ? { signal } : {});
  } catch {
    return "unknown";
  }
  if (response.status === 401) return "signed-out";
  if (!response.ok) return "unknown";
  const list = workspaceListResponseSchema.safeParse(
    await response.json().catch(() => undefined),
  );
  if (!list.success) return "unknown";
  return list.data.workspaces.some(({ id }) => id === workspaceId)
    ? "unknown"
    : "no-access";
}

/** The times of a connection, in milliseconds. SYNC.md leaves them open. */
export const syncTimings = {
  /**
   * How long a socket may take from the start of its handshake to the
   * answer to its hello, and how long the answer to a `mutate` may take.
   */
  answer: 15_000,
  /** How often a socket is pinged. */
  pingEvery: 30_000,
  /** How long the answer to a ping may take. */
  pong: 10_000,
  /** How long the server may take to say why a handshake failed. */
  access: 10_000,
  /**
   * The pause before connecting again: after the first failure, after the
   * second and so on. The last one is for every failure after that.
   */
  retry: [1_000, 2_000, 4_000, 8_000, 16_000, 30_000],
} as const;

/**
 * What an error about versions has in any version of the protocol: a
 * server that speaks a later one may word the rest of its messages in a way
 * that this client cannot read.
 */
const versionMismatchSchema = z.looseObject({
  type: z.literal("error"),
  code: z.literal("version_mismatch"),
  protocolVersion: z.int(),
  schemaVersion: z.int(),
});

/**
 * Keeps a copy in step with the server over a socket, as SYNC.md asks of a
 * client: it says hello with where the copy is, applies the patches, sends
 * the mutations of the outbox and connects again when the socket is lost.
 * One tab runs it at a time, the one that holds the socket of the copy.
 */
export class SyncConnection {
  private state: "new" | "running" | "ended" = "new";
  private finish = () => {};
  private unsubscribe = () => {};
  private socket: Socket | undefined;
  /**
   * Counts the sockets. An event of a socket other than the latest is
   * ignored: that socket was given up.
   */
  private generation = 0;
  /** Whether the hello of the socket has been answered. */
  private ready = false;
  /** The ID of the last mutation of the `mutate` that awaits its answer. */
  private awaiting: number | undefined;
  /** The messages so far of a patch that is still arriving. */
  private parts: PatchMessage[] = [];
  /**
   * The client ID that the hello of the socket named: what the server says
   * on the socket is about the copy of that client.
   */
  private clientId: string | undefined;
  /**
   * How many times in a row a socket has failed before it had shown that
   * it works: see `worked()`.
   */
  private failures = 0;
  /** Whether the next mutations are being read from the outbox. */
  private taking = false;
  /** What the sockets say is handled in the order it arrives. */
  private work: Promise<void> = Promise.resolve();
  private cancelRetry: (() => void) | undefined;
  private cancelAnswer: (() => void) | undefined;
  private cancelPing: (() => void) | undefined;
  private cancelPong: (() => void) | undefined;
  /** Ends the wait for the answer to why a handshake failed. */
  private cancelAccess: (() => void) | undefined;

  constructor(
    private readonly options: {
      store: SyncStore;
      open: OpenSocket;
      /**
       * Asks the server why a handshake may have failed. `signal` says
       * when the connection has stopped waiting for the answer.
       */
      checkAccess: (signal: AbortSignal) => Promise<Access>;
      schedule: Schedule;
      /** Told of what went wrong, for the log. */
      onError: (error: unknown) => void;
    },
  ) {}

  /**
   * Holds the socket of the copy. The promise resolves when that is over:
   * after `stop()`, or when the connection has given up for good, which the
   * `connection` and `outdated` of the store tell apart.
   */
  run(): Promise<void> {
    if (this.state !== "new") throw new Error("A connection runs once");
    const { store, onError } = this.options;
    if (store.getState().outdated) {
      // This tab could not use the socket. Another one may.
      this.state = "ended";
      return Promise.resolve();
    }
    this.state = "running";
    store.setConnection("connecting");
    const unsubscribe = store.subscribe(() => this.follow());
    const unlisten = store.onWake(() => this.wake());
    this.unsubscribe = () => {
      unsubscribe();
      unlisten();
    };
    const ended = new Promise<void>((resolve) => {
      this.finish = resolve;
    });
    // The hello says where the stored copy is, and this tab may have missed
    // the last writes of the tab that held the socket before it.
    store
      .reload()
      .catch(onError)
      .then(() => {
        if (this.state === "running") this.connect();
      });
    return ended;
  }

  /** Closes the socket and stops connecting. */
  stop(): void {
    this.end();
  }

  /**
   * For when there is reason to think that the network has changed, such
   * as the browser saying so: connects now if it was waiting to, and makes
   * sure that a socket which seems open still is. It also looks for what
   * other tabs have stored without this one hearing of it.
   */
  wake(): void {
    if (this.state !== "running") return;
    this.reconcile();
    // Waiting for a pause to end, or for the server to say why the last
    // handshake failed: the next handshake is a better question.
    if (this.cancelRetry || this.cancelAccess) this.connect();
    else if (this.ready) this.ping();
  }

  /** The store has changed. */
  private follow(): void {
    if (this.options.store.getState().outdated) {
      // Only a newer version of the app can go on, with this server or with
      // this copy. Other tabs may run one, so this one makes way.
      this.end("offline");
    } else {
      this.send();
    }
  }

  private reconcile(): void {
    this.options.store.reconcile().catch(this.options.onError);
  }

  private end(connection?: ConnectionState): void {
    if (this.state !== "running") return;
    this.state = "ended";
    this.drop();
    this.unsubscribe();
    if (connection) this.options.store.setConnection(connection);
    this.options.store.leave();
    this.finish();
  }

  private connect(): void {
    this.drop();
    const generation = this.generation;
    let opened = false;
    const handle = (step: () => void | Promise<void>) => {
      const current = () =>
        this.state === "running" && generation === this.generation;
      this.work = this.work
        .then(() => (current() ? step() : undefined))
        .catch((error: unknown) => {
          this.options.onError(error);
          if (current()) this.retry();
        });
    };
    this.socket = this.options.open({
      open: () =>
        handle(() => {
          opened = true;
          this.hello();
        }),
      message: (data) => handle(() => this.receive(data)),
      close: (code) => handle(() => this.closed(code, opened)),
    });
    this.expectAnswer();
  }

  /** Gives the socket up, if there is one, and everything that waits. */
  private drop(): void {
    this.generation += 1;
    for (const cancel of [
      this.cancelRetry,
      this.cancelAnswer,
      this.cancelPing,
      this.cancelPong,
      this.cancelAccess,
    ]) {
      cancel?.();
    }
    this.cancelRetry = undefined;
    this.cancelAnswer = undefined;
    this.cancelPing = undefined;
    this.cancelPong = undefined;
    this.ready = false;
    this.awaiting = undefined;
    this.parts = [];
    const { socket } = this;
    this.socket = undefined;
    try {
      socket?.close();
    } catch {
      // It was closed already.
    }
  }

  /** Connects again at once. */
  private reconnect(): void {
    this.connect();
  }

  /**
   * Reads the copy again and connects again: what the socket and this tab
   * know of the copy is not what is stored.
   */
  private async resync(): Promise<void> {
    const generation = this.generation;
    await this.options.store.reload();
    if (this.state === "running" && generation === this.generation) {
      this.reconnect();
    }
  }

  /**
   * The socket has shown that it works: the next failure is the first
   * again. An answer to the hello does not show it. A server that fails on
   * a `mutate`, because the database of the workspace is full, for example,
   * answers every hello and fails again when the mutation is sent again,
   * and the pause has to grow with that as with any failure. So a socket
   * works when a `mutate` has been answered on it, or when it has lasted as
   * long as it takes to send the first ping.
   */
  private worked(): void {
    this.failures = 0;
  }

  /**
   * A step that changes the copy for the socket that is open now. The
   * storage may get to it later, after other work of this tab or of
   * another one. By then the socket may have been given up, or the copy may
   * have started over as another client, here or in the tab that has taken
   * the socket over: what the socket said is not about the copy as it is.
   * So this is decided in the transaction, where the copy cannot change any
   * more, and before anything is worked out to write: the outcome is
   * `stale` and nothing is stored.
   */
  private forSocket<Result>(
    step: (head: Head) => Step<Result>,
  ): (head: Head) => Step<Result | "stale"> {
    const { generation, clientId } = this;
    return (head) =>
      this.state === "running" &&
      generation === this.generation &&
      head.meta.clientId === clientId
        ? step(head)
        : { write: null, result: "stale" };
  }

  /** Connects again after a pause, which grows with every failure. */
  private retry(): void {
    this.drop();
    const pauses = syncTimings.retry;
    const pause = pauses[Math.min(this.failures, pauses.length - 1)] ?? 0;
    this.failures += 1;
    this.options.store.setConnection("offline");
    this.cancelRetry = this.options.schedule(() => this.connect(), pause);
  }

  private hello(): void {
    const { clientId, cursor, lastMutationId } = this.options.store.head.meta;
    this.clientId = clientId;
    this.socket?.send(
      JSON.stringify({
        type: "hello",
        protocolVersion: syncProtocolVersion,
        schemaVersion: syncSchemaVersion,
        clientId,
        cursor,
        lastMutationId,
      } satisfies HelloMessage),
    );
  }

  private async receive(data: unknown): Promise<void> {
    let message: ServerMessage;
    try {
      const json: unknown = JSON.parse(z.string().parse(data));
      const mismatch = versionMismatchSchema.safeParse(json);
      if (mismatch.success) {
        this.failed(mismatch.data);
        return;
      }
      message = serverMessageSchema.parse(json);
    } catch (error) {
      throw new Error("The server sent what is not a message", {
        cause: error,
      });
    }
    // Whatever it says, the socket is alive.
    this.cancelPong?.();
    this.cancelPong = undefined;
    switch (message.type) {
      case "pong":
        break;
      case "error":
        this.failed(message);
        break;
      case "patch":
        this.parts.push(message);
        if (!message.more) {
          const parts = this.parts;
          this.parts = [];
          await this.patch(parts);
        }
        break;
    }
  }

  /** Applies a patch whose messages are all in. */
  private async patch(parts: PatchMessage[]): Promise<void> {
    const [first] = parts;
    if (!first) return;
    const { store } = this.options;
    const generation = this.generation;
    const outcome = await store.transact(
      this.forSocket((head) =>
        applyPatch(
          head,
          {
            from: first.from,
            to: first.to,
            changes: parts.flatMap(({ changes }) => changes),
            lastMutationId: first.lastMutationId,
            rejected: first.rejected,
          },
          store.newClientId(),
        ),
      ),
    );
    // Also when the store has found that this tab is too old for the copy:
    // it has said so, and the connection has ended.
    if (this.state !== "running" || generation !== this.generation) return;
    if (outcome === undefined) return;
    if (outcome === "gap" || outcome === "stale") {
      // A patch was missed, or another tab has moved the stored cursor or
      // started the copy over.
      await this.resync();
      return;
    }
    if (outcome === "start-over") {
      this.reconnect();
      return;
    }
    if (!this.ready) {
      this.ready = true;
      this.cancelAnswer?.();
      this.cancelAnswer = undefined;
      store.setConnection("online");
      this.pingLater();
    }
    if (this.awaiting !== undefined && first.lastMutationId >= this.awaiting) {
      this.awaiting = undefined;
      this.cancelAnswer?.();
      this.cancelAnswer = undefined;
      this.worked();
    }
    this.send();
  }

  /**
   * Sends the next mutations, if the socket is free for them: one `mutate`
   * is on its way at a time. The ones made in the meantime wait in the
   * outbox, where a later one can still take the place of an earlier one.
   */
  private send(): void {
    if (!this.ready || this.awaiting !== undefined || this.taking) return;
    const { store, onError } = this.options;
    if (store.head.outbox.length === 0) return;
    this.taking = true;
    const generation = this.generation;
    const current = () =>
      this.state === "running" && generation === this.generation;
    // Durable, because the server remembers what it is sent: if the copy
    // then forgot that it has made these mutations, it would give their IDs
    // to others, which the server would take for repeats.
    store
      .transact(
        this.forSocket((head) => nextBatch(head, store.newClientId())),
        { durable: true },
      )
      .then((batch) => {
        this.taking = false;
        if (!current()) {
          // The socket is another one by now. It was not served while this
          // was reading.
          this.send();
        } else if (batch === "stale") {
          return this.resync();
        } else if (batch === "start-over") {
          this.reconnect();
        } else if (batch) {
          this.awaiting = batch.at(-1)?.id;
          this.socket?.send(
            JSON.stringify({
              type: "mutate",
              mutations: batch,
            } satisfies MutateMessage),
          );
          this.expectAnswer();
        }
      })
      .catch((error: unknown) => {
        this.taking = false;
        onError(error);
        if (current()) this.retry();
      });
  }

  /** The server has said that this client did something wrong. */
  private failed(error: {
    code: string;
    protocolVersion: number;
    schemaVersion: number;
  }): void {
    switch (error.code) {
      case "version_mismatch":
        if (
          error.protocolVersion > syncProtocolVersion ||
          error.schemaVersion > syncSchemaVersion
        ) {
          // Only a newer version of the app can talk to this server. Other
          // tabs may run one, so this one makes way.
          this.options.store.markOutdated();
          this.end("offline");
        } else {
          // The server is the older one: it is being updated.
          this.retry();
        }
        break;
      case "mutation_gap":
        // The answer to the next hello says which mutation the server
        // expects. `nextBatch` then finds whether the outbox has it.
        this.reconnect();
        break;
      default:
        // A bug in this client, says SYNC.md. The same message would be
        // refused again, so there is no hurry.
        this.options.onError(
          new Error(`The server refused a message: ${error.code}`),
        );
        this.retry();
    }
  }

  private async closed(code: number, opened: boolean): Promise<void> {
    const wasReady = this.ready;
    if (code === syncCloseCodes.replaced) {
      // Another socket has said hello as this copy. Connecting again would
      // close that one in turn.
      this.end("replaced");
      return;
    }
    if (code === syncCloseCodes.reconnect && wasReady) {
      // The socket has reached the end of its life. The handshake of the
      // next one checks the session again.
      this.reconnect();
      return;
    }
    if (opened) {
      this.retry();
      return;
    }
    // The handshake failed, and only the server can say why.
    this.drop();
    this.options.store.setConnection("offline");
    const generation = this.generation;
    const access = await this.askAccess();
    // Not if the connection has moved on in the meantime: the answer is
    // about a handshake that it has given up on.
    if (this.state !== "running" || generation !== this.generation) return;
    if (access === "unknown") this.retry();
    else this.end(access);
  }

  /**
   * Asks the server why a handshake failed, and takes it for no answer if
   * none comes in time. A network that is up and leads nowhere, such as
   * one that wants a sign-in of its own first, can leave a request open
   * for minutes, and nothing else would connect again in that time: what
   * the sockets say waits behind this question.
   */
  private askAccess(): Promise<Access> {
    const asking = new AbortController();
    return new Promise<Access>((resolve, reject) => {
      const cancelTimer = this.options.schedule(
        () => this.cancelAccess?.(),
        syncTimings.access,
      );
      this.cancelAccess = () => {
        this.cancelAccess = undefined;
        cancelTimer();
        asking.abort();
        resolve("unknown");
      };
      this.options.checkAccess(asking.signal).then(resolve, reject);
    }).finally(() => this.cancelAccess?.());
  }

  /** Gives the socket up if it stays silent for too long from now. */
  private expectAnswer(): void {
    this.cancelAnswer?.();
    this.cancelAnswer = this.options.schedule(
      () => this.retry(),
      syncTimings.answer,
    );
  }

  private pingLater(): void {
    this.cancelPing = this.options.schedule(() => {
      this.worked();
      this.ping();
      // A tab that was closed right after it stored a mutation has told
      // nobody. This is how the mutation is found, and then sent.
      this.reconcile();
      this.pingLater();
    }, syncTimings.pingEvery);
  }

  /** Asks the server for a sign of life. */
  private ping(): void {
    this.socket?.send(pingMessageText);
    this.cancelPong ??= this.options.schedule(
      () => this.retry(),
      syncTimings.pong,
    );
  }
}
