import type { Clock } from "../../dependencies.ts";
import { uuidv7 } from "../../id.ts";
import type { MutatorArgs, MutatorName } from "../mutators.ts";
import {
  appendMutations,
  applyChanges,
  applyWrite,
  type Copy,
  dismissRejection,
  emptyTables,
  type Head,
  type MutationCall,
  openCopy,
  type Step,
  type StoredRejection,
  type Tables,
  type Write,
} from "./copy.ts";
import type { ClientStorage } from "./storage.ts";
import { viewOf } from "./view.ts";

/**
 * How the tab that holds the socket is getting on. The last three are for
 * good: that tab has given up the socket.
 */
export type ConnectionState =
  /** No socket has got as far as an answer to its hello yet. */
  | "connecting"
  /** The copy follows the server. */
  | "online"
  /** The server cannot be reached. The tab keeps trying. */
  | "offline"
  /** The session has ended. */
  | "signed-out"
  /** The workspace is not, or no longer, that of whoever is signed in. */
  | "no-access"
  /** Another socket has taken the place of this copy's, see 4409. */
  | "replaced";

/** What the app shows of sync, apart from the rows. */
export type SyncState = {
  connection: ConnectionState;
  /** How many mutations the server has not confirmed. */
  pending: number;
  /**
   * This tab runs a version of the app that is older than the server or
   * than the copy. It has to be loaded again.
   */
  outdated: boolean;
};

/** What the tabs that share a copy tell each other. */
export type TabMessage =
  /** The copy was changed, by this write. */
  | { type: "write"; write: Write }
  /** From the tab that holds the socket. */
  | { type: "connection"; connection: ConnectionState }
  /** From a tab that has just opened and wants to know. */
  | { type: "connection?" };

/** A `BroadcastChannel`: what a tab posts reaches the other tabs. */
export interface TabChannel {
  post(message: TabMessage): void;
  /** Hands `listener` the messages of other tabs. Returns how to stop. */
  listen(listener: (message: TabMessage) => void): () => void;
}

const noRejections: readonly StoredRejection[] = [];

/**
 * The copy of a workspace as one tab holds it in memory, and what the app
 * reads: the rows of the server with the unconfirmed mutations run on top.
 *
 * The stored copy is the truth, and every tab changes it by itself, in
 * transactions of the storage. A tab tells the others what it wrote, and
 * each applies that to its memory, so that all of them show a change at
 * once. A tab that finds it has missed a write reads the stored copy again.
 *
 * A mutation shows the moment it is made. It is stored right after, and
 * gets its ID in that transaction, where no other tab can take the same.
 */
export class SyncStore {
  private copy: Copy | undefined;
  private view = emptyTables();
  private state: SyncState = {
    connection: "connecting",
    pending: 0,
    outdated: false,
  };
  /** Mutations that are shown and not stored yet, oldest first. */
  private readonly unsaved: MutationCall[] = [];
  private readonly listeners = new Set<() => void>();
  /** The work on the storage, which is done one piece at a time. */
  private queue: Promise<unknown> = Promise.resolve();
  private saveQueued = false;
  private reloadQueued = false;
  /** Whether this tab holds the socket. */
  private holding = false;
  private closed = false;
  private stopListening = () => {};

  constructor(
    private readonly options: {
      storage: ClientStorage;
      channel: TabChannel;
      now: Clock;
      /** Told of failures of the storage that nobody waits for. */
      onError: (error: unknown) => void;
    },
  ) {}

  /** Loads the copy, which is made first if there is none. */
  async open(): Promise<void> {
    const { storage, channel } = this.options;
    this.stopListening = channel.listen((message) => this.receive(message));
    await this.enqueue(async () => {
      const { write, result } = await storage.update((head) =>
        openCopy(head, this.newClientId()),
      );
      if (write) channel.post({ type: "write", write });
      await this.read();
      this.state = { ...this.state, outdated: result === "outdated" };
      this.refresh(true);
    });
    if (!this.closed) channel.post({ type: "connection?" });
  }

  /** Stops following the other tabs. What is stored stays. */
  close(): void {
    this.closed = true;
    this.stopListening();
    this.listeners.clear();
  }

  /** Calls `listener` after every change of what the getters return. */
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /**
   * The rows to show. A new object whenever a row may have changed, and a
   * table that did not change is the same object as before.
   */
  readonly getView = (): Tables => this.view;

  readonly getState = (): SyncState => this.state;

  /** The rejected mutations that the person has not dismissed. */
  readonly getRejections = (): readonly StoredRejection[] =>
    this.copy?.head.rejections ?? noRejections;

  /** The copy without its rows, as this tab knows it. */
  get head(): Head {
    if (!this.copy) throw new Error("The store is not open");
    return this.copy.head;
  }

  /** An ID for a copy that starts over. */
  newClientId(): string {
    return uuidv7(this.options.now());
  }

  /**
   * Makes a mutation. The view has it when this returns. The server gets
   * it when it can, and if it rejects it, the view goes back and the
   * rejection is added to `getRejections()`.
   */
  mutate<Name extends MutatorName>(name: Name, args: MutatorArgs<Name>): void {
    this.unsaved.push({ name, args, at: this.options.now().getTime() });
    this.refresh(true);
    if (this.saveQueued) return;
    this.saveQueued = true;
    this.enqueue(async () => {
      // From here on a new mutation needs another round.
      this.saveQueued = false;
      const calls = this.unsaved.slice();
      // They leave `unsaved` in the same moment as they enter the outbox
      // in memory, so the view never has them twice or not at all.
      await this.run(
        (head) => appendMutations(head, calls),
        {},
        () => this.unsaved.splice(0, calls.length),
      );
    }).catch(this.options.onError);
  }

  /** Forgets a rejection, in every tab: the person has seen it. */
  dismiss(key: string): void {
    this.transact((head) => dismissRejection(head, key)).catch(
      this.options.onError,
    );
  }

  /**
   * Changes the stored copy in one step and returns the outcome of `step`.
   * By then this tab has applied the write and told the other tabs.
   */
  transact<Result>(
    step: (head: Head) => Step<Result>,
    options: { durable?: boolean } = {},
  ): Promise<Result> {
    return this.enqueue(() => this.run(step, options));
  }

  /** Reads the stored copy again. */
  reload(): Promise<void> {
    return this.enqueue(async () => {
      await this.read();
      this.refresh(true);
    });
  }

  /** For the tab that holds the socket: says how it is getting on. */
  setConnection(connection: ConnectionState): void {
    this.holding = true;
    this.options.channel.post({ type: "connection", connection });
    this.setState({ connection });
  }

  /** For the tab that held the socket: it no longer does. */
  leave(): void {
    this.holding = false;
  }

  /** This tab has learned that it runs an old version of the app. */
  markOutdated(): void {
    this.setState({ outdated: true });
  }

  private async run<Result>(
    step: (head: Head) => Step<Result>,
    options: { durable?: boolean },
    stored?: () => void,
  ): Promise<Result> {
    const { write, result } = await this.options.storage.update((head) => {
      if (!head) throw new Error("The local copy is gone");
      return step(head);
    }, options);
    if (this.closed || !this.copy) return result;
    if (write) {
      if (write.meta.version === this.copy.head.meta.version + 1) {
        this.copy = applyWrite(this.copy, write);
      } else {
        // Another tab wrote in between and its message is still on its way.
        await this.read();
      }
      this.options.channel.post({ type: "write", write });
    }
    stored?.();
    this.refresh(Boolean(stored || write?.rows || write?.outbox));
    return result;
  }

  private async read(): Promise<void> {
    const stored = await this.options.storage.read();
    if (!stored) throw new Error("The local copy is gone");
    // Writes that arrived from other tabs while this was reading can have
    // taken the memory further than what was read.
    if (this.copy && this.copy.head.meta.version > stored.head.meta.version) {
      return;
    }
    this.copy = {
      head: stored.head,
      tables: applyChanges(emptyTables(), false, stored.rows),
    };
  }

  private receive(message: TabMessage): void {
    if (this.closed) return;
    switch (message.type) {
      case "write": {
        const { write } = message;
        // While the copy is being read for the first time, it may be read
        // as it was before this write.
        const version = this.copy?.head.meta.version ?? -1;
        if (this.copy && write.meta.version === version + 1) {
          this.copy = applyWrite(this.copy, write);
          this.refresh(Boolean(write.rows || write.outbox));
        } else if (write.meta.version > version) {
          // A write before this one has not arrived.
          this.reloadLater();
        }
        break;
      }
      case "connection":
        // The tab with the socket knows best. It hears this only from a
        // tab that has just lost the socket to it.
        if (!this.holding) this.setState({ connection: message.connection });
        break;
      case "connection?":
        if (this.holding) {
          this.options.channel.post({
            type: "connection",
            connection: this.state.connection,
          });
        }
        break;
    }
  }

  private reloadLater(): void {
    if (this.reloadQueued) return;
    this.reloadQueued = true;
    this.enqueue(async () => {
      // From here on a write that is missed needs another reload.
      this.reloadQueued = false;
      if (this.closed) return;
      await this.read();
      this.refresh(true);
    }).catch(this.options.onError);
  }

  /** Brings what the getters return up to date and tells the listeners. */
  private refresh(rows: boolean): void {
    if (this.closed || !this.copy) return;
    const { outbox } = this.copy.head;
    if (rows) {
      this.view = viewOf(this.copy.tables, [...outbox, ...this.unsaved]);
    }
    const pending = outbox.length + this.unsaved.length;
    if (pending !== this.state.pending) this.state = { ...this.state, pending };
    this.notify();
  }

  private setState(fields: Partial<SyncState>): void {
    const state = { ...this.state, ...fields };
    if (
      state.connection === this.state.connection &&
      state.outdated === this.state.outdated
    ) {
      return;
    }
    this.state = state;
    this.notify();
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener();
  }

  private enqueue<Result>(job: () => Promise<Result>): Promise<Result> {
    const result = this.queue.then(job);
    this.queue = result.catch(() => {});
    return result;
  }
}
