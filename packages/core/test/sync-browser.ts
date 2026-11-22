import {
  type Access,
  type Change,
  memoryStorage,
  memoryTabs,
  type PatchMessage,
  type Row,
  type Schedule,
  type SocketEvents,
  SyncConnection,
  SyncStore,
  unscheduled,
  uuidv7,
} from "../src/index.ts";

/** A new ID for a row. */
export function newId(): string {
  return uuidv7(new Date(0));
}

/** A draft as the server has it, with one part. */
export function draft(text: string, updatedAt = 0) {
  const post: Row<"post"> = {
    id: newId(),
    status: "draft",
    createdAt: 0,
    updatedAt,
    ...unscheduled,
  };
  const part: Row<"post_part"> = {
    id: newId(),
    postId: post.id,
    targetId: null,
    position: 0,
    text,
  };
  return {
    post,
    part,
    /** The changes that bring the draft, with `text` if it has changed. */
    puts: (newText = text): Change[] => [
      { op: "put", table: "post", row: post },
      { op: "put", table: "post_part", row: { ...part, text: newText } },
    ],
    /** The changes that take the draft away. */
    deletes: (): Change[] => [
      { op: "delete", table: "post", id: post.id },
      { op: "delete", table: "post_part", id: part.id },
    ],
  };
}

/** A message of a patch. What is left out is what an empty patch says. */
export function patch(fields: Partial<PatchMessage>): PatchMessage {
  return {
    type: "patch",
    from: null,
    to: 0,
    changes: [],
    more: false,
    lastMutationId: 0,
    rejected: [],
    ...fields,
  };
}

/** Lets everything that is waiting for a promise run. */
export function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** The server's end of a socket that a connection has opened. */
export class ServerSocket {
  /** The frames that the client has sent, as they were. */
  readonly frames: string[] = [];
  /** The messages in them, parsed. */
  readonly sent: unknown[] = [];
  /** Whether the client has closed the socket. */
  closed = false;

  constructor(private readonly events: SocketEvents) {}

  /** Lets the handshake through. */
  async open(): Promise<void> {
    this.events.open();
    await settle();
  }

  /** Sends messages to the client, objects as JSON. */
  async send(...messages: unknown[]): Promise<void> {
    for (const message of messages) {
      this.events.message(
        typeof message === "string" ? message : JSON.stringify(message),
      );
    }
    await settle();
  }

  /** Closes the socket. Before `open()`, the handshake has failed. */
  async close(code: number): Promise<void> {
    this.events.close(code);
    await settle();
  }

  /** The `mutate` messages that the client has sent. */
  get mutates(): { id: number; name: string; args: unknown }[][] {
    return this.sent.flatMap((message) =>
      typeof message === "object" && message !== null && "mutations" in message
        ? [message.mutations as { id: number; name: string; args: unknown }[]]
        : [],
    );
  }
}

/**
 * A browser for the tests of the sync client: one stored copy, any number
 * of tabs over it, a network whose other end the test plays, and a clock
 * that only the test moves.
 */
export function browser() {
  const storage = memoryStorage();
  const tabs = memoryTabs();
  let time = Date.UTC(2026, 10, 14);
  const timers: { at: number; callback: () => void }[] = [];
  const sockets: ServerSocket[] = [];
  const errors: unknown[] = [];
  const network = {
    /**
     * What `GET /api/workspaces` says. `silent`: nothing, as on a network
     * that takes a request and never answers it.
     */
    access: "unknown" as Access | "silent",
    accessChecks: 0,
    /**
     * The questions that got no answer, oldest first: a function to answer
     * one after all, and whether the client has stopped waiting for it.
     */
    unanswered: [] as { answer(access: Access): void; signal: AbortSignal }[],
  };
  const schedule: Schedule = (callback, delayMs) => {
    const timer = { at: time + delayMs, callback };
    timers.push(timer);
    return () => {
      const index = timers.indexOf(timer);
      if (index >= 0) timers.splice(index, 1);
    };
  };

  return {
    storage,
    /** The channel between the tabs: `join()` is one more of them. */
    tabs,
    /** Every socket that a connection has opened, oldest first. */
    sockets,
    /** What the stores and connections reported as having gone wrong. */
    errors,
    /** What `GET /api/workspaces` says, and how often it was asked. */
    network,

    /** The socket that was opened last. */
    get socket(): ServerSocket {
      const socket = sockets.at(-1);
      if (!socket) throw new Error("No socket has been opened");
      return socket;
    },

    /** Opens a tab: its store, loaded, and its connection, not yet run. */
    async tab() {
      const store = new SyncStore({
        storage,
        channel: tabs.join(),
        now: () => new Date(time),
        schedule,
        onError: (error) => errors.push(error),
      });
      await store.open();
      const connection = new SyncConnection({
        store,
        open: (events) => {
          const socket = new ServerSocket(events);
          sockets.push(socket);
          return {
            send: (text) => {
              socket.frames.push(text);
              socket.sent.push(JSON.parse(text));
            },
            close: () => {
              socket.closed = true;
            },
          };
        },
        checkAccess: (signal) => {
          network.accessChecks += 1;
          const { access } = network;
          return access === "silent"
            ? new Promise((answer) => {
                network.unanswered.push({ answer, signal });
              })
            : Promise.resolve(access);
        },
        schedule,
        onError: (error) => errors.push(error),
      });
      return { store, connection };
    },

    /**
     * Opens a tab that holds the socket, up to the hello: the handshake
     * has gone through and the test answers the hello next. `running`
     * resolves when the tab gives the socket up.
     */
    async holder() {
      const tab = await this.tab();
      const running = tab.connection.run();
      await settle();
      const socket = this.socket;
      await socket.open();
      return { ...tab, socket, running };
    },

    /** Moves the clock, and runs what was scheduled for the time passed. */
    async advance(milliseconds: number): Promise<void> {
      const until = time + milliseconds;
      for (;;) {
        const due = timers
          .filter((timer) => timer.at <= until)
          .sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        timers.splice(timers.indexOf(due), 1);
        time = due.at;
        due.callback();
        await settle();
      }
      time = until;
    },
  };
}
