import { env } from "cloudflare:workers";
import {
  type Change,
  type Environment,
  type Mutation,
  type MutatorArgs,
  type MutatorName,
  type Rejection,
  type Row,
  type ServerMessage,
  serverMessageSchema,
  syncProtocolVersion,
  syncSchemaVersion,
  type TableName,
  uuidv7,
  workspaceListResponseSchema,
} from "@pigy/core";
import { eq } from "drizzle-orm";
import { expect } from "vitest";
import { workspaces } from "../src/db/schema.ts";
import type { WorkspaceIdentity } from "../src/workspace/store.ts";
import { clock } from "./clock.ts";
import type { Browser, TestSetup } from "./helpers.ts";

/** A new ID for a row, as a client makes them. */
export function newId(): string {
  return uuidv7(clock.time);
}

/** The IDs of the workspaces of whoever `browser` is signed in as. */
export async function workspaceIds(
  browser: Browser,
): Promise<Record<Environment, string>> {
  const response = await browser.fetch("/api/workspaces");
  expect(response.status).toBe(200);
  const { workspaces: list } = workspaceListResponseSchema.parse(
    await response.json(),
  );
  const ids = Object.fromEntries(
    list.map(({ environment, id }) => [environment, id]),
  );
  if (!ids.live || !ids.sandbox) throw new Error("A workspace is missing");
  return { live: ids.live, sandbox: ids.sandbox };
}

/** A workspace as Worker code knows it, for calling its object directly. */
export async function identityOf(
  { db }: Pick<TestSetup, "db">,
  workspaceId: string,
): Promise<WorkspaceIdentity> {
  const [workspace] = await db
    .select({
      id: workspaces.id,
      ownerId: workspaces.ownerId,
      environment: workspaces.environment,
    })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId));
  if (!workspace) throw new Error(`There is no workspace ${workspaceId}`);
  return workspace;
}

/** The object of a workspace, for the helpers of `cloudflare:test`. */
export function objectOf(workspaceId: string) {
  return env.WORKSPACE.getByName(workspaceId);
}

/** A patch as a client has it once all its messages are in. */
export type ReceivedPatch = {
  from: number | null;
  to: number;
  changes: Change[];
  lastMutationId: number;
  rejected: Rejection[];
  /** How many messages the patch came in. */
  messages: number;
};

type Rows = { [Table in TableName]: Map<string, Row<Table>> };

/**
 * A client of the sync protocol, written from SYNC.md: a local copy of a
 * workspace, the cursor that goes with it and the numbering of its
 * mutations. All of that outlives a socket, as it does in a browser.
 *
 * It is strict where a real client may be lenient. A message that is not
 * exactly what the protocol describes, a patch that does not follow the
 * cursor, a row that comes twice in a patch and a rejection that the client
 * was told of before all fail the test.
 */
export class SyncClient {
  readonly clientId = newId();
  /** The `to` of the last patch that was applied. */
  cursor: number | null = null;
  /**
   * The `lastMutationId` of the last patch that was applied: what became of
   * the mutations up to this one, the client knows.
   */
  lastMutationId = 0;
  /** The ID of the mutation that `mutation()` makes next. */
  nextMutationId = 1;
  /** Every message that the server has sent to this client, as text. */
  readonly received: string[] = [];
  /**
   * How the server closed the socket. It stays pending while the socket is
   * open.
   */
  closed: Promise<{ code: number; reason: string }> = new Promise(() => {});

  private readonly rows: Rows = {
    post: new Map(),
    post_part: new Map(),
    channel: new Map(),
    post_target: new Map(),
    target_part_result: new Map(),
    notification: new Map(),
    schedule_slot: new Map(),
    settings: new Map(),
  };
  private socket: WebSocket | undefined;
  /** Messages that no test has looked at yet. */
  private readonly inbox: string[] = [];
  private arrived: (() => void) | undefined;

  /** Opens a socket to a workspace, without saying hello. */
  async open(browser: Browser, workspaceId: string): Promise<void> {
    const response = await browser.webSocket(`/sync/${workspaceId}`);
    expect(response.status).toBe(101);
    const socket = response.webSocket;
    if (!socket) throw new Error("The answer has no WebSocket");

    this.inbox.length = 0;
    socket.addEventListener("message", (event) => {
      const text = String(event.data);
      this.received.push(text);
      this.inbox.push(text);
      this.arrived?.();
    });
    this.closed = new Promise((resolve) => {
      socket.addEventListener("close", ({ code, reason }) =>
        resolve({ code, reason }),
      );
    });
    socket.accept();
    this.socket = socket;
  }

  /**
   * Opens a socket, says hello with where the local copy is and applies the
   * answer, which it returns.
   */
  async connect(browser: Browser, workspaceId: string): Promise<ReceivedPatch> {
    await this.open(browser, workspaceId);
    this.hello();
    return this.patch();
  }

  /** Sends a hello. `fields` replace what this client would say. */
  hello(fields: Record<string, unknown> = {}): void {
    this.send({
      type: "hello",
      protocolVersion: syncProtocolVersion,
      schemaVersion: syncSchemaVersion,
      clientId: this.clientId,
      cursor: this.cursor,
      lastMutationId: this.lastMutationId,
      ...fields,
    });
  }

  /** A mutation with the ID that follows the last one this client made. */
  mutation<Name extends MutatorName>(
    name: Name,
    args: MutatorArgs<Name>,
  ): Mutation {
    return { id: this.nextMutationId++, name, args };
  }

  /** Sends one new mutation in a message of its own, and returns it. */
  mutate<Name extends MutatorName>(
    name: Name,
    args: MutatorArgs<Name>,
  ): Mutation {
    const mutation = this.mutation(name, args);
    this.send({ type: "mutate", mutations: [mutation] });
    return mutation;
  }

  /** Sends any message, also one that the protocol does not have. */
  send(message: unknown): void {
    this.sendFrame(JSON.stringify(message));
  }

  /** Sends a frame as it is. */
  sendFrame(frame: string | ArrayBuffer): void {
    if (!this.socket) throw new Error("The client is not connected");
    this.socket.send(frame);
  }

  /** Closes the socket from the client's side. */
  disconnect(): void {
    this.socket?.close(1000, "Bye");
    this.socket = undefined;
  }

  /** How many messages have arrived that no test has looked at. */
  get unread(): number {
    return this.inbox.length;
  }

  /** The next message from the server. Fails if none comes. */
  async next(): Promise<ServerMessage> {
    if (this.inbox.length === 0) {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error("The server sent no message")),
          2000,
        );
        this.arrived = () => {
          clearTimeout(timeout);
          resolve();
        };
      });
      this.arrived = undefined;
    }
    // Strict: a field that the protocol does not have fails the test.
    return serverMessageSchema.parse(JSON.parse(this.inbox.shift() ?? ""));
  }

  /**
   * The next patch from the server, which must be what comes next. It is
   * applied to the local copy the way SYNC.md says, all its messages as one.
   */
  async patch(): Promise<ReceivedPatch> {
    const messages = [];
    do {
      const message = await this.next();
      if (message.type !== "patch") {
        throw new Error(`Expected a patch, got ${JSON.stringify(message)}`);
      }
      messages.push(message);
    } while (messages.at(-1)?.more);
    const [first] = messages;
    if (!first) throw new Error("A patch has at least one message");
    const { from, to, lastMutationId, rejected } = first;
    for (const message of messages) {
      // All messages of a patch say the same, apart from the changes.
      expect(message).toMatchObject({ from, to, lastMutationId, rejected });
    }

    if (from === null) {
      for (const rows of Object.values(this.rows)) rows.clear();
    } else if (from !== this.cursor) {
      throw new Error(
        `A patch from ${from} arrived at the cursor ${this.cursor}`,
      );
    }
    const changes = messages.flatMap((message) => message.changes);
    const seen = new Set<string>();
    for (const change of changes) {
      const id = change.op === "put" ? change.row.id : change.id;
      const key = `${change.table} ${id}`;
      if (seen.has(key)) throw new Error(`${key} is in the patch twice`);
      seen.add(key);
      if (change.op === "delete") this.rows[change.table].delete(id);
      else this.put(change.table, change.row);
    }
    this.cursor = to;
    // A patch tells of the rejections among the mutations that it confirms,
    // which are the ones after those that the client knew of. One from
    // before would be told twice, one from after is not processed yet.
    for (const { id } of rejected) {
      if (id <= this.lastMutationId || id > lastMutationId) {
        throw new Error(
          `A patch that confirms the mutations after ${this.lastMutationId} up to ${lastMutationId} rejects ${id}`,
        );
      }
    }
    if (lastMutationId < this.lastMutationId) {
      throw new Error(
        `A patch went back from mutation ${this.lastMutationId} to ${lastMutationId}`,
      );
    }
    this.lastMutationId = lastMutationId;
    return {
      from,
      to,
      changes,
      lastMutationId,
      rejected,
      messages: messages.length,
    };
  }

  private put<Table extends TableName>(table: Table, row: Row<Table>): void {
    this.rows[table].set(row.id, row);
  }

  /** The rows of a table in the local copy, in the order of their IDs. */
  table<Table extends TableName>(table: Table): Row<Table>[] {
    return [...this.rows[table].values()].sort((a, b) =>
      a.id < b.id ? -1 : 1,
    );
  }

  /** The whole local copy, to compare two clients. */
  get copy() {
    return {
      post: this.table("post"),
      post_part: this.table("post_part"),
      channel: this.table("channel"),
      post_target: this.table("post_target"),
      target_part_result: this.table("target_part_result"),
      notification: this.table("notification"),
      schedule_slot: this.table("schedule_slot"),
      settings: this.table("settings"),
    };
  }
}
