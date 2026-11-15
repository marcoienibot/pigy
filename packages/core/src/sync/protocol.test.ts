import { expect, it } from "vitest";
import {
  changeSchema,
  clientMessageSchema,
  helloVersionsSchema,
  pingMessageText,
  syncLimits,
  syncProtocolVersion,
  syncSchemaVersion,
} from "./protocol.ts";

const id = "01932c07-0000-7000-8000-000000000001";

function mutate(ids: number[]) {
  return {
    type: "mutate",
    mutations: ids.map((id) => ({ id, name: "post.delete", args: {} })),
  };
}

it.each([
  ["one mutation", [7]],
  ["mutations whose IDs increase by one", [7, 8, 9]],
  [
    "as many mutations as a message may hold",
    Array.from({ length: syncLimits.mutationsPerMessage }, (_, i) => i + 1),
  ],
])("accepts %s", (_name, ids) => {
  expect(clientMessageSchema.safeParse(mutate(ids)).success).toBe(true);
});

// The server reads only the first ID to tell a replay from a gap, which is
// right only if the rest follow from it.
it.each([
  ["no mutations", []],
  ["a gap between mutations", [7, 9]],
  ["mutations out of order", [8, 7]],
  ["a mutation twice", [7, 7]],
  ["the mutation ID 0", [0]],
  [
    "more mutations than a message may hold",
    Array.from({ length: syncLimits.mutationsPerMessage + 1 }, (_, i) => i + 1),
  ],
])("rejects %s", (_name, ids) => {
  expect(clientMessageSchema.safeParse(mutate(ids)).success).toBe(false);
});

it("rejects a mutation without arguments", () => {
  const message = {
    type: "mutate",
    mutations: [{ id: 1, name: "post.delete" }],
  };

  expect(clientMessageSchema.safeParse(message).success).toBe(false);
});

const hello = {
  type: "hello",
  protocolVersion: syncProtocolVersion,
  schemaVersion: syncSchemaVersion,
  clientId: id,
  cursor: null,
  lastMutationId: 0,
};

it.each([
  ["a client with nothing yet", hello],
  [
    "a client that has applied changes",
    { ...hello, cursor: 12, lastMutationId: 7 },
  ],
])("accepts the hello of %s", (_name, message) => {
  expect(clientMessageSchema.safeParse(message).success).toBe(true);
});

it.each([
  ["a negative cursor", { ...hello, cursor: -1 }],
  ["a cursor that is not a whole number", { ...hello, cursor: 1.5 }],
  ["no cursor", { ...hello, cursor: undefined }],
  // Without it the server could not tell which rejections the client has
  // yet to hear of. Unlike the cursor it is never null: 0 says "none".
  ["no last mutation ID", { ...hello, lastMutationId: undefined }],
  ["null as the last mutation ID", { ...hello, lastMutationId: null }],
  ["a negative last mutation ID", { ...hello, lastMutationId: -1 }],
  ["a client ID that is not a UUIDv7", { ...hello, clientId: "tab-1" }],
  ["a field that the protocol does not have", { ...hello, userId: "me" }],
])("rejects a hello with %s", (_name, message) => {
  expect(clientMessageSchema.safeParse(message).success).toBe(false);
});

it("reads the versions of a hello that it does not otherwise understand", () => {
  // What a later version of the protocol might send. The server has to get
  // as far as the versions to say that it speaks another one.
  const fromTheFuture = {
    type: "hello",
    protocolVersion: syncProtocolVersion + 1,
    schemaVersion: syncSchemaVersion + 8,
    client: { id, cursors: [] },
  };

  expect(clientMessageSchema.safeParse(fromTheFuture).success).toBe(false);
  expect(helloVersionsSchema.parse(fromTheFuture)).toMatchObject({
    protocolVersion: syncProtocolVersion + 1,
    schemaVersion: syncSchemaVersion + 8,
  });
});

it("spells a ping the way the schema reads it", () => {
  // The server answers this exact text without waking the workspace up, so
  // it has to be a ping to the schema too.
  expect(clientMessageSchema.parse(JSON.parse(pingMessageText))).toEqual({
    type: "ping",
  });
});

const post = { id, status: "draft", createdAt: 1, updatedAt: 2 };

it("accepts a row of the table that a change names", () => {
  const change = { op: "put", table: "post", row: post };

  expect(changeSchema.parse(change)).toEqual(change);
});

it.each([
  ["a row of another table", { op: "put", table: "post_part", row: post }],
  // A table of the server's own bookkeeping.
  ["a table that is not synced", { op: "put", table: "change_log", row: post }],
  [
    // A client must not quietly accept a column that it does not know: the
    // server is not meant to send any.
    "a row with a field that the table does not have",
    { op: "put", table: "post", row: { ...post, credentials: "secret" } },
  ],
  [
    "a deletion in a table that is not synced",
    { op: "delete", table: "change_log", id },
  ],
])("rejects a change with %s", (_name, change) => {
  expect(changeSchema.safeParse(change).success).toBe(false);
});
