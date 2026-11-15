import type { Clock, Schedule } from "../../dependencies.ts";
import { uuidv7 } from "../../id.ts";
import type { MutatorArgs, MutatorName } from "../mutators.ts";
import { syncSchemaVersion } from "../protocol.ts";
import {
  appendMutations,
  applyChanges,
  applyWrite,
  type Copy,
  dismissRejection,
  emptyTables,
  type Head,
  type Meta,
  type MutationCall,
  openCopy,
  replaces,
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
   * How many of them this tab could not store. They are in its memory and
   * nowhere else, so they are gone if the tab is closed, and they are not
   * sent. The store keeps trying to store them. This has nothing to do with
   * the connection: it is the device that fails.
   */
  unsaved: number;
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
  | { type: "connection?" }
  /**
   * From a tab that has reason to think that the network has changed, to
   * the tab that holds the socket.
   */
  | { type: "wake" };

/** A `BroadcastChannel`: what a tab posts reaches the other tabs. */
export interface TabChannel {
  post(message: TabMessage): void;
  /** Hands `listener` the messages of other tabs. Returns how to stop. */
  listen(listener: (message: TabMessage) => void): () => void;
}

/**
 * How long the store waits before it tries again to store mutations that
 * it could not store, in milliseconds.
 */
export const saveRetryMs = 5_000;

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
    unsaved: 0,
    outdated: false,
  };
  /** Mutations that are shown and not stored yet, oldest first. */
  private readonly unsaved: MutationCall[] = [];
  /**
   * How many of them, from the oldest, an attempt to store them has taken.
   * Until it is over they stay as they are: they are what it stores.
   */
  private saving = 0;
  /** Whether the last attempt to store `unsaved` failed. */
  private saveFailed = false;
  private cancelSaveRetry: (() => void) | undefined;
  private readonly listeners = new Set<() => void>();
  /** The work on the storage, which is done one piece at a time. */
  private queue: Promise<unknown> = Promise.resolve();
  private saveQueued = false;
  private reloadQueued = false;
  /** Whether this tab holds the socket. */
  private holding = false;
  private wakeListener: (() => void) | undefined;
  private closed = false;
  private stopListening = () => {};

  constructor(
    private readonly options: {
      storage: ClientStorage;
      channel: TabChannel;
      now: Clock;
      schedule: Schedule;
      /** Told of failures of the storage that nobody waits for. */
      onError: (error: unknown) => void;
    },
  ) {}

  /** Loads the copy, which is made first if there is none. */
  async open(): Promise<void> {
    const { storage, channel } = this.options;
    this.stopListening = channel.listen((message) => this.receive(message));
    await this.enqueue(async () => {
      const { write } = await storage.update((head) =>
        openCopy(head, this.newClientId()),
      );
      if (write) channel.post({ type: "write", write });
      // Which also finds a copy that this tab is too old for.
      await this.read();
      this.refresh(true);
    });
    if (!this.closed) channel.post({ type: "connection?" });
  }

  /** Stops following the other tabs. What is stored stays. */
  close(): void {
    this.closed = true;
    this.cancelSaveRetry?.();
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
    const call = { name, args, at: this.options.now().getTime() };
    const last = this.unsaved.at(-1);
    // By the rule of the outbox, before the mutation gets there: what is
    // typed into a part stays one change while it cannot be stored, however
    // many keys it takes. Otherwise the app would count every key as a
    // change that is not saved, and show each by running all of them.
    if (last && this.unsaved.length > this.saving && replaces(call, last)) {
      this.unsaved[this.unsaved.length - 1] = call;
    } else {
      this.unsaved.push(call);
    }
    this.refresh(true);
    this.save();
  }

  /** Forgets a rejection, in every tab: the person has seen it. */
  dismiss(key: string): void {
    this.enqueue(() =>
      this.run((head) => dismissRejection(head, key), { own: true }),
    ).catch(this.options.onError);
  }

  /**
   * Changes the stored copy in one step and returns the outcome of `step`.
   * By then this tab has applied the write and told the other tabs.
   *
   * This is for what the socket brings. A tab that is too old for the copy
   * must not write that: `step` is not run then, nothing is stored and the
   * outcome is `undefined`.
   */
  transact<Result>(
    step: (head: Head) => Step<Result>,
    options: { durable?: boolean } = {},
  ): Promise<Result | undefined> {
    return this.enqueue(() => this.run(step, options));
  }

  /** Reads the stored copy again. */
  reload(): Promise<void> {
    return this.enqueue(async () => {
      await this.read();
      this.refresh(true);
    });
  }

  /**
   * Reads the stored copy again if it has changed without this tab hearing
   * of it. A tab that is closed, or dies, after it has stored a write and
   * before its message to the others has left is never heard, so the
   * messages only make the tabs find out sooner. The tab that holds the
   * socket asks this now and then: nobody else would send what such a tab
   * has left in the outbox.
   */
  reconcile(): Promise<void> {
    return this.enqueue(async () => {
      // Only the head: the rows are read when there is something to read.
      const { result: version } = await this.options.storage.update((head) => ({
        write: null,
        result: head?.meta.version,
      }));
      if (this.closed || !this.copy || version === undefined) return;
      if (version <= this.copy.head.meta.version) return;
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

  /**
   * For when there is reason to think that the network has changed, in a
   * tab that may not hold the socket: the tab that does is told, here or
   * through the channel, and makes sure of its connection.
   */
  wakeHolder(): void {
    if (this.holding) this.wakeListener?.();
    else this.options.channel.post({ type: "wake" });
  }

  /**
   * For the tab that holds the socket: `listener` is called when a tab
   * asks for `wakeHolder()`. Returns how to stop.
   */
  onWake(listener: () => void): () => void {
    this.wakeListener = listener;
    return () => {
      if (this.wakeListener === listener) this.wakeListener = undefined;
    };
  }

  /** Stores the mutations that are shown and not stored yet. */
  private save(): void {
    if (this.saveQueued) return;
    this.saveQueued = true;
    this.cancelSaveRetry?.();
    this.cancelSaveRetry = undefined;
    this.enqueue(async () => {
      // From here on a new mutation needs another round.
      this.saveQueued = false;
      const calls = this.unsaved.slice();
      if (calls.length === 0) return;
      this.saving = calls.length;
      // They leave `unsaved` in the same moment as they enter the outbox
      // in memory, so the view never has them twice or not at all.
      await this.run(
        (head) => appendMutations(head, calls),
        { own: true },
        () => {
          this.unsaved.splice(0, calls.length);
          this.saving = 0;
          this.saveFailed = false;
        },
      );
    }).catch((error: unknown) => {
      this.options.onError(error);
      if (this.closed) return;
      // The mutations stay in `unsaved` and on screen. The app is told
      // that they are not stored, and they are tried again: after a pause,
      // or with the next mutation, whichever comes first.
      //
      // The attempt no longer holds them, so the last of them can be
      // replaced again: by the next mutation, or by the one that was made
      // right after it while the attempt ran.
      const taken = this.saving;
      this.saving = 0;
      const last = this.unsaved[taken - 1];
      const next = this.unsaved[taken];
      if (last && next && replaces(next, last)) {
        this.unsaved.splice(taken - 1, 1);
      }
      this.saveFailed = true;
      this.refresh(false);
      if (this.saveQueued) return;
      this.cancelSaveRetry = this.options.schedule(() => {
        this.cancelSaveRetry = undefined;
        this.save();
      }, saveRetryMs);
    });
  }

  /**
   * Runs `step` in a transaction of the storage and brings the memory of
   * this tab up to what was written.
   *
   * `own` is for what the person did in this tab: a mutation, a rejection
   * that they dismissed. That is stored whatever the schema of the copy.
   * Mutations of an older schema are in the outbox anyway after an update,
   * and SYNC.md section 6 says what becomes of them. Everything else is
   * what this tab knows of the server, and a tab that is too old for the
   * copy must not write it over the rows of a newer schema.
   *
   * `saved` is called when mutations of `unsaved` are in the outbox.
   */
  private async run<Result>(
    step: (head: Head) => Step<Result>,
    options: { durable?: boolean; own?: boolean },
    saved?: () => void,
  ): Promise<Result | undefined> {
    const { write, result: outcome } = await this.options.storage.update(
      (head) => {
        if (!head) throw new Error("The local copy is gone");
        const { meta } = head;
        const { write, result } =
          options.own || meta.schemaVersion <= syncSchemaVersion
            ? step(head)
            : { write: null, result: undefined };
        // With the meta that the step saw: nothing here has an effect
        // outside the transaction, which can fail.
        return { write, result: { meta, result } };
      },
      options.durable ? { durable: true } : {},
    );
    const { meta, result } = outcome;
    this.checkSchema(meta);
    if (this.closed || !this.copy) return result;
    let rows = Boolean(write?.rows || write?.outbox);
    if (write) {
      if (write.meta.version === this.copy.head.meta.version + 1) {
        this.copy = applyWrite(this.copy, write);
        // The mutations have moved from `unsaved` to the end of the outbox,
        // and those that were merged do what the ones they replace did. The
        // view runs the same mutations as before, so it stays as it is:
        // computing it again would render every screen again, with every
        // keystroke.
        if (saved) rows = false;
      } else {
        // Another tab wrote in between and its message is still on its way.
        await this.read();
        rows = true;
      }
      this.options.channel.post({ type: "write", write });
    }
    saved?.();
    this.refresh(rows);
    return result;
  }

  private async read(): Promise<void> {
    const stored = await this.options.storage.read();
    if (!stored) throw new Error("The local copy is gone");
    this.checkSchema(stored.head.meta);
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

  /**
   * Finds out that this tab is too old for the copy: a tab that runs a
   * newer version of the app has brought the copy to a schema that this
   * one does not know. That can happen at any time while this tab is open,
   * so it is looked for wherever the tab sees the copy: when it reads it,
   * in every transaction and in every write that another tab tells it of.
   * Whoever holds the socket follows `outdated` and gives it up.
   */
  private checkSchema(meta: Meta): void {
    if (meta.schemaVersion > syncSchemaVersion) this.markOutdated();
  }

  private receive(message: TabMessage): void {
    if (this.closed) return;
    switch (message.type) {
      case "write": {
        const { write } = message;
        this.checkSchema(write.meta);
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
      case "wake":
        if (this.holding) this.wakeListener?.();
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
    const unsaved = this.saveFailed ? this.unsaved.length : 0;
    if (pending !== this.state.pending || unsaved !== this.state.unsaved) {
      this.state = { ...this.state, pending, unsaved };
    }
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
