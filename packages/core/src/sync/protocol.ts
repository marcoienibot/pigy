import { z } from "zod";
import { idSchema } from "../id.ts";
import { rejectionCodeSchema } from "./mutators.ts";
import { rowSchemas, type TableName, tableNames } from "./tables.ts";

/**
 * The messages of the sync protocol, which SYNC.md describes. Each is one
 * WebSocket text frame that holds one JSON object. The schemas are strict:
 * a field that is not listed makes a message invalid.
 */

/** Changes when the messages or their meaning change. */
export const syncProtocolVersion = 2;

/** Changes when the synced tables or the mutators change. */
export const syncSchemaVersion = 6;

/** Lengths are in UTF-16 code units, which is what `String.length` counts. */
export const syncLimits = {
  /** The longest message a client may send. */
  clientMessageLength: 256 * 1024,
  /** The most mutations in one message. */
  mutationsPerMessage: 100,
  /**
   * The server starts another message rather than let the changes of one
   * grow longer than this as JSON.
   */
  patchChangesLength: 512 * 1024,
} as const;

/** The codes the server closes a socket with. */
export const syncCloseCodes = {
  /** The client did something wrong. An `error` message came before. */
  error: 4400,
  /**
   * The socket has reached the end of its life. Connecting again is all it
   * takes, unless the session has ended in the meantime.
   */
  reconnect: 4401,
  /**
   * A newer socket has said hello with the same client ID. A client has one
   * socket, so this one is no longer its own.
   */
  replaced: 4409,
  /**
   * The server failed while it handled a message, which it may or may not
   * have processed. The code is the one that WebSocket has for this.
   */
  failure: 1011,
} as const;

/** A count of committed changes, or a mutation ID. */
const counterSchema = z.int().nonnegative();

// Client to server.

export const helloMessageSchema = z.strictObject({
  type: z.literal("hello"),
  protocolVersion: z.int(),
  schemaVersion: z.int(),
  /** Names the local copy that this client keeps and numbers mutations for. */
  clientId: idSchema,
  /** The `to` of the last patch the client has applied, null if it has none. */
  cursor: counterSchema.nullable(),
  /**
   * The `lastMutationId` of that patch, 0 if there is none: the client knows
   * what became of its mutations up to this one.
   */
  lastMutationId: counterSchema,
});

export type HelloMessage = z.infer<typeof helloMessageSchema>;

/**
 * What a `hello` of any version of the protocol has. The server reads the
 * versions with it before it reads anything else.
 */
export const helloVersionsSchema = z.looseObject({
  type: z.literal("hello"),
  protocolVersion: z.int(),
  schemaVersion: z.int(),
});

export const mutationSchema = z.strictObject({
  /** Counts up from 1, by one, for each client ID. */
  id: z.int().positive(),
  name: z.string().min(1).max(100),
  /** Checked by the mutator. */
  args: z.unknown(),
});

export type Mutation = z.infer<typeof mutationSchema>;

export const mutateMessageSchema = z.strictObject({
  type: z.literal("mutate"),
  mutations: z
    .array(mutationSchema)
    .min(1)
    .max(syncLimits.mutationsPerMessage)
    .refine(
      (mutations) =>
        mutations.every(
          (mutation, index) => mutation.id === (mutations[0]?.id ?? 0) + index,
        ),
      "The IDs of the mutations must increase by one",
    ),
});

export type MutateMessage = z.infer<typeof mutateMessageSchema>;

export const pingMessageSchema = z.strictObject({ type: z.literal("ping") });

export const clientMessageSchema = z.discriminatedUnion("type", [
  helloMessageSchema,
  mutateMessageSchema,
  pingMessageSchema,
]);

export type ClientMessage = z.infer<typeof clientMessageSchema>;

// Server to client.

function putSchema<Table extends TableName>(table: Table) {
  return z.strictObject({
    op: z.literal("put"),
    table: z.literal(table),
    /** The whole row as it is now. */
    row: rowSchemas[table],
  });
}

/** One row that is not what the client has. */
export const changeSchema = z.union([
  putSchema("post"),
  putSchema("post_part"),
  putSchema("channel"),
  putSchema("post_target"),
  putSchema("target_part_result"),
  z.strictObject({
    op: z.literal("delete"),
    table: z.enum(tableNames),
    id: idSchema,
  }),
]);

export type Change = z.infer<typeof changeSchema>;

/** A mutation of the receiving client that was rejected, and why. */
export const rejectionSchema = z.strictObject({
  id: z.int().positive(),
  code: rejectionCodeSchema,
  /** For people. */
  message: z.string(),
});

export type Rejection = z.infer<typeof rejectionSchema>;

export const patchMessageSchema = z.strictObject({
  type: z.literal("patch"),
  /**
   * The cursor that the patch applies to. Null for a snapshot: the client
   * forgets every row it has first.
   */
  from: counterSchema.nullable(),
  /** The cursor of a client that has applied the patch. */
  to: counterSchema,
  changes: z.array(changeSchema),
  /** True if the patch goes on in the next message. */
  more: z.boolean(),
  /** The last mutation of the receiving client that the server processed. */
  lastMutationId: counterSchema,
  /**
   * Which of the client's mutations were rejected, among those after the
   * `lastMutationId` that the client had before and up to this one.
   */
  rejected: z.array(rejectionSchema),
});

export type PatchMessage = z.infer<typeof patchMessageSchema>;

export const syncErrorCodeSchema = z.enum([
  /** The client speaks another version of the protocol or of the schema. */
  "version_mismatch",
  /** Not JSON, not a message of the protocol, or not allowed at this point. */
  "invalid_message",
  /** Longer than `syncLimits.clientMessageLength`. */
  "message_too_large",
  /** The first mutation is not the one that follows the last one processed. */
  "mutation_gap",
]);

export type SyncErrorCode = z.infer<typeof syncErrorCodeSchema>;

/** Sent before the server closes the socket with `syncCloseCodes.error`. */
export const syncErrorMessageSchema = z.strictObject({
  type: z.literal("error"),
  code: syncErrorCodeSchema,
  /** For developers. */
  message: z.string(),
  /** What the server speaks. */
  protocolVersion: z.int(),
  schemaVersion: z.int(),
});

export type SyncErrorMessage = z.infer<typeof syncErrorMessageSchema>;

export const pongMessageSchema = z.strictObject({ type: z.literal("pong") });

export const serverMessageSchema = z.discriminatedUnion("type", [
  patchMessageSchema,
  syncErrorMessageSchema,
  pongMessageSchema,
]);

export type ServerMessage = z.infer<typeof serverMessageSchema>;

/**
 * A `ping` and its `pong` as text. A ping that is sent as exactly this text
 * is answered without waking the workspace up.
 */
export const pingMessageText = JSON.stringify({
  type: "ping",
} satisfies z.infer<typeof pingMessageSchema>);

export const pongMessageText = JSON.stringify({
  type: "pong",
} satisfies z.infer<typeof pongMessageSchema>);
