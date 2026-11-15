# pigy sync protocol

How a client keeps a copy of a workspace and changes it. Protocol version 2, schema version 1.

This document is the contract between the server and any client: the browser store of the app, or anything else. It is meant to be enough to write a client from. The message schemas, the row schemas, the mutators, the limits and the versions are code in `packages/core/src/sync`, and a client should use them rather than copy them. The server is `apps/worker/src/workspace`. `apps/worker/test/sync-client.ts` is a small client written from this document, which the tests of the server use.

## 1. Model

- A **workspace** is one user's data in one environment. Everybody has two, `live` and `sandbox`. `GET /api/workspaces` lists them, as `{ "workspaces": [{ "id": "…", "environment": "live" }, { "id": "…", "environment": "sandbox" }] }`, and creates them the first time.
- The **synced tables** of a workspace are the part of it that clients hold a copy of: `post` and `post_part` so far. `packages/core/src/sync/tables.ts` describes their rows. A row has an `id`, a UUID version 7 in lowercase, that is unique in its table.
- A client never writes rows. It sends **mutations**: the name of a mutator and its arguments, such as `post.create`. The server runs the mutator, and what it does to the rows is what counts. A client may run the same mutator, from `packages/core/src/sync/mutators.ts`, on its own copy first, to show the change before the server has answered.
- The server applies mutations one at a time, in the order they arrive. Each mutation that changes something is one change and gets a **sequence number**: the changes of a workspace are numbered 1, 2, 3 and so on. A **cursor** is a sequence number, and a client whose cursor is N has exactly the rows that the server had after change N. Cursor 0 is the empty workspace.
- A **client** is one local copy: its rows, its cursor, the mutations it has made that the server has not confirmed, and the ID of the last one that the server has confirmed. It has a **client ID**, a UUID version 7 that it makes up once, and it numbers its mutations 1, 2, 3 and so on. The server remembers the last mutation it has processed for each client ID, which is what makes it safe to send a mutation twice. A client keeps its copy and its client ID for one workspace: another workspace is another copy with another ID.
- A client has **at most one socket** open. Tabs of a browser that share a stored copy, and with it a client ID, choose one among them to hold the socket and to pass on what it receives. Or each tab keeps a copy of its own, with a client ID of its own. Two sockets with one client ID do not work: every patch moves the cursor that both go by, so each would find that the other has made it miss a patch, and the answer to a `mutate` goes only to the socket that sent it. The server therefore keeps one socket per client ID, the one that was opened last, and closes the others when they have said hello.
- A client that loses its local copy, or any part of it, **starts over**: it makes up a new client ID and says hello with the cursor `null` and the `lastMutationId` 0, as a client that has nothing. With the old ID, the server would take the mutations of a second copy for repeats of the first one's, and skip them. Two things tell a client that it has to start over:
  - It is told of a `lastMutationId` higher than any mutation it has made. It has no unconfirmed mutations left then: the patch that said so took them all for confirmed.
  - The server answers a `mutate` with the error `mutation_gap`, and when the client has connected again, it does not have the mutation that the server expects, which is the one after the `lastMutationId` of the answer to its hello. Either the client has lost that mutation, or the server has gone back to an earlier state. The client keeps the unconfirmed mutations that it has. Their IDs are all higher than that `lastMutationId`, so the server has processed none of them, and sending them under the new client ID cannot apply one twice. The client numbers them again from 1, in the order they were made. Those that build on a mutation that is missing are rejected, like any mutation that cannot be applied.

## 2. Connecting

A client opens a WebSocket to `/sync/<workspace ID>` on the origin of the app: `wss://<host>/sync/<workspace ID>`. The handshake is an ordinary request to the Worker, which lets it through if

- it comes from a page of the app itself: the `Origin` header is the origin of the address. A browser sends the session cookie with a handshake that any site starts, so this is what keeps other sites out. Otherwise 403.
- the session cookie is that of a signed-in user. Otherwise 401.
- the workspace belongs to that user. Otherwise 404, the same as for a workspace that does not exist.
- the workspace has fewer than 32 sockets open. Otherwise 429.

A request that is not a WebSocket handshake gets 426. A browser does not tell a script why a handshake failed, only that it did. A client whose handshake fails therefore asks `GET /api/workspaces`: a 401 means that it is signed out, and no answer that it is offline. A 200 means that the handshake failed for another reason, such as too many sockets or a failure of the server. The client then tries the handshake again after a pause, which it makes longer every time the handshake fails. If the 200 does not list the workspace, the workspace is not the user's, and trying again is no use.

The session is checked at the handshake and not again. To make up for that, a socket lasts five minutes. After that the server closes it with the code 4401, when the next message arrives on it or the next change would be sent to it. An idle socket stays open and costs nothing. A client that is closed with 4401 connects again at once, and that handshake checks the session again. So somebody who signed out, or whose invitation was withdrawn, can read and write through a socket that was open at the time for at most five minutes. A message that arrives on a socket that is past its time is not processed. The server can end a socket with 4401 before the five minutes are over, in the same way: section 4 has the one case.

## 3. Messages

Every message is one text frame with one JSON object, which has a `type`. A field that is not described here makes a message invalid, in both directions.

### Client to server

**`hello`** is the first message on every socket, and is sent once.

```json
{ "type": "hello", "protocolVersion": 2, "schemaVersion": 1, "clientId": "0192…", "cursor": 42, "lastMutationId": 7 }
```

`cursor` is the `to` of the last patch that the client has applied, or `null` if it has applied no patch. `lastMutationId` is the `lastMutationId` of the last patch that the client has applied, or 0 if it has applied no patch. It says that the client knows what became of its mutations up to that one, and the server forgets what it kept to tell the client: see section 4.

The server answers with a patch that brings the client up to date, and from then on sends it every change. A socket that has not said hello receives nothing. Of the sockets that have said hello with one client ID, the server keeps the one that was opened last and closes the others with the code 4409. That is usually an older socket that is still open. It is the socket of this hello, which then gets no answer, if the hello arrives after that of a socket that was opened later: a hello can be held up on its way past the point at which the client gave the socket up.

**`mutate`** carries mutations of the client, at least one and at most 100.

```json
{ "type": "mutate", "mutations": [{ "id": 7, "name": "part.setText", "args": { "id": "0192…", "text": "Hello" } }] }
```

The IDs in a message increase by one. The server skips the mutations that it has processed before, and runs the others in order. If the first mutation is not the one after the last that was processed, or an earlier one, the server runs none: it answers with the error `mutation_gap` and closes the socket. Each `mutate` is answered with one patch, also if it changed nothing.

**`ping`** is answered with `{ "type": "pong" }`. It is there for a client to find out that a socket is dead. Sent as exactly the text `{"type":"ping"}`, which is `pingMessageText`, it is answered without waking the workspace up, at any time, also before the hello.

A message is at most 262,144 characters long, counted the way `String.length` counts. A client with more mutations than fit sends several messages.

### Server to client

**`patch`** takes the client from one cursor to another.

```json
{
  "type": "patch",
  "from": 42,
  "to": 44,
  "changes": [
    { "op": "put", "table": "post_part", "row": { "id": "0192…", "postId": "0192…", "position": 0, "text": "Hello" } },
    { "op": "delete", "table": "post", "id": "0192…" }
  ],
  "more": false,
  "lastMutationId": 7,
  "rejected": [{ "id": 6, "code": "not_a_draft", "message": "Only a draft can be edited" }]
}
```

- `from` is the cursor that the patch applies to, and `to` the cursor of a client that has applied it. `from` is `null` for a **snapshot**: the client first forgets every row it has.
- `changes` has each row at most once. `put` carries the whole row as it is at `to`, and replaces the row with the same ID or adds it. `delete` removes the row with that ID, if the client has it. The order of the changes means nothing.
- A patch can be more than one message. All but the last have `more: true`, they follow each other with nothing in between, and they differ only in `changes` and `more`. A message of the server holds at most about 524,288 characters of changes.
- `lastMutationId` is the ID of the last mutation of the receiving client that the server has processed, 0 if there is none.
- `rejected` lists the mutations of the receiving client that were rejected, with the reason: those with an ID after the `lastMutationId` that the client had before the patch, and up to the `lastMutationId` of the patch. What the client had before is what the patch before said on the same socket, or the hello, for the answer to a hello. A rejected mutation had no effect and counts as processed.

A client applies a patch as one step, when its last message is in:

1. If `from` is `null`, drop all rows. If it is a number other than the client's cursor, the client has missed a patch: it closes the socket and connects again.
2. Apply the changes.
3. Set the cursor to `to`.
4. Drop the unconfirmed mutations with an ID up to `lastMutationId`, take note of the ones in `rejected` for the user, and keep `lastMutationId` for the next hello. An entry of `rejected` whose ID is not above the `lastMutationId` that the client has stored is skipped, and a `lastMutationId` lower than the stored one is not stored. Both can only happen where tabs share a copy: the tab that takes the socket over says hello with what was stored at the time, and the tab that held the socket before can store one more patch after that.
5. If mutations were shown before they were confirmed: run the unconfirmed mutations that are left on top of the new rows, for display.

Steps 1 to 4 belong in one transaction of the local store: the rows, the cursor, the `lastMutationId`, the unconfirmed mutations that go, and what the client keeps of each rejection until the user has been told. Two things depend on it. The patch that confirms a mutation is the patch that carries its changes, so there is no moment at which the client has neither its own version of a change nor the server's. And the server forgets a rejection as soon as a hello has a `lastMutationId` that covers it. A client that stored the `lastMutationId` of a patch without its rejections, and was stopped in between, would drop the mutations and never learn that they were rejected.

**`error`** says what the client did wrong. The server then closes the socket with the code 4400.

```json
{ "type": "error", "code": "version_mismatch", "message": "…", "protocolVersion": 2, "schemaVersion": 1 }
```

`protocolVersion` and `schemaVersion` are what the server speaks. The codes:

| Code | Meaning | What a client does |
| --- | --- | --- |
| `version_mismatch` | The `hello` had another protocol or schema version, or the server changed to another one while the socket was open | If the server's versions are higher, the client is out of date: it updates itself, which for the app means loading the new version of itself, and does not connect before. If they are lower, the server is in the middle of an update: try again later |
| `invalid_message` | Not JSON text, not a message of the protocol, a second `hello`, or a `mutate` before the `hello` | A bug in the client |
| `message_too_large` | Longer than the limit | A bug in the client |
| `mutation_gap` | See `mutate` | Connect again: the answer to the hello says which mutation the server expects next, the one after its `lastMutationId`. A client that does not have that mutation, because it lost it or because the server has gone back to an earlier state, would get the same error every time. It starts over: see section 1 |

**`pong`** answers a `ping`.

### How the server closes a socket

| Code | Meaning | What a client does |
| --- | --- | --- |
| 4400 | An `error` message came before | See above |
| 4401 | The socket has reached the end of its life. A message that was arriving is not processed | Connect again at once |
| 4409 | Another socket with the same client ID, one that was opened later, has said hello | Nothing. The client has a newer socket, and this one is no longer its own. If tabs share the copy, another tab holds the socket now. Connecting again because of this close would close that socket in turn, and so on for ever |
| 1011 | The server failed while it handled a message. It may have processed the message or not. The server also closes the sockets of other clients with this code, when it has made a change and cannot send it to them | Connect again, after a pause |

After any close other than 4400 and 4409, and after a socket was lost, a client connects again, says hello with its cursor and its `lastMutationId`, and sends its unconfirmed mutations again under the IDs they have: all of them, or those after the `lastMutationId` of the answer to its hello. The server skips the ones that it has processed, so a client never has to know whether a message got through, after a 1011 no more than after a lost socket. A socket can be lost without the client being told. A client that gets no `pong`, or no patch in answer to a `mutate`, within a time of its choosing closes the socket and connects again. After 4400 a client does what the table of errors says for the error that came before, which for some of them is not to connect again. After 4409 it does nothing.

## 4. Mutations

The mutators, their arguments and what they refuse are in `packages/core/src/sync/mutators.ts`. For now:

| Name | Arguments | Does |
| --- | --- | --- |
| `post.create` | `id`, `partId`, `text` | Creates a draft with its first part. Rejected with `already_exists` if either ID is taken |
| `part.setText` | `id`, `text` | Replaces the text of a part. Rejected with `not_found` if the part is gone, with `not_a_draft` if its post is past being a draft |
| `post.delete` | `id` | Deletes a post and its parts. Does nothing if the post is gone |

Whoever creates a row makes up its ID, so a client can create rows while it is offline. `uuidv7` in `packages/core` makes one.

Every mutation that a client sends is processed exactly once, and one of three things happens: it changes rows, it changes nothing, or it is rejected. All three are final. A mutation is also rejected, not refused as a message, if its name is unknown (`unknown_mutation`), its arguments are not what the mutator takes (`invalid_arguments`), or its mutator fails on it, which is a bug in the server (`internal_error`). Otherwise a client would send it again for ever, and none of its later mutations would get through. It is another matter when the database of the workspace fails under a mutator, because it is full, for example: sent again later, the mutation can go through. The server then processes nothing of the message and closes the socket with 1011.

The server keeps a rejection until the client has seen it. The patch that answers a `mutate` can get lost, and the rows do not tell the client what happened: an edit that was accepted before its post was deleted leaves the same rows behind as an edit that was rejected because the post was gone. So the answer to the next hello of the client lists the rejections after the `lastMutationId` of that hello, and the server forgets the ones up to it. A client that applies patches the way section 3 says therefore learns of every rejection, and of each once.

Once the server keeps 1,000 rejections for a client, it takes no more mutations from it: it closes the socket on which the next `mutate` arrives with 4401 and does not process that message. The hello on the next socket says how far the client has seen, which makes room. Only a client that has that many mutations rejected on one socket ever notices.

A mutator takes the time from its transaction, which on the server is the server's clock. So a row that a client made for display before the answer can differ from the row that the patch brings, in `createdAt` for example. The patch is right.

Conflicts need no handling by a client. Mutations are applied in the order they reach the server, and a mutator works on the rows as they are then, so of two changes to the same field the later one wins, and changes to different fields both hold.

## 5. How the server works

This is not part of the contract, but it explains its edges.

- **One object per workspace.** A workspace is a Durable Object with a SQLite database, named after the ID of the workspace. It handles one message at a time and everything it does with one is synchronous, so mutations have a single order, and a patch is sent to every socket before the next message is looked at. A socket that a patch cannot be sent to is closed with 1011, so that no client stays connected without a change and waits for nothing.
- **What a client is missing.** The server keeps a change log: for each change, the tables and IDs of the rows it wrote or deleted, not their contents. What a client at cursor N is missing is then the current state of every row that the log names after N: a `put` if the row exists, a `delete` if not. The patch that goes to the connected clients after a change is computed the same way, so there is one path from the database into a message. The alternative, a version number in every row plus tombstones for deleted rows, would need columns in every synced table and a rule for when a tombstone may go. With a log, a synced table needs nothing, and deletions are entries like any other.
- **Keeping the log bounded.** The log covers the last 1,000 changes. A client whose cursor is older gets a snapshot, as does a client with no cursor, and one whose cursor is higher than the workspace's sequence number, which can only come from another workspace or from a workspace that was restored to an earlier state. A snapshot costs as much as the workspace is large, which for text is little.
- **Exactly once.** For every client ID the server stores the ID of the last mutation it has processed, in the same transaction as the changes of that mutation. The rows of this table are never removed: one small row per local copy that has ever sent a mutation. The rejections are stored in the same transaction, with a reason of at most 200 characters, and removed when a hello says that the client has seen them. A client that never comes back leaves fewer than 1,100 behind.
- **Rejected or failed.** An error is the database's own, and aborts the message, if SQLite reports that it could not do its work whatever it was asked: it is full, cannot be read or written, is locked, or has no memory. Every other error while a mutator runs is the mutator's, and the mutation is rejected for good: an error that the mutator throws, and one from the database about what the mutator wrote, such as a constraint that a row violates or a value that is too large. Those would come again however often the mutation was sent.
- **What can be synced.** Each synced table has an explicit list of synced columns, in `apps/worker/src/workspace/synced.ts`, and every row in a patch is read through it. A column or a table that is not listed cannot get into a message.
- **Hibernation.** The sockets stay open while the object is not in memory. What the object knows about a socket, its client ID and when it runs out, is stored with the socket, and everything else is in the database.
- **Who is asking.** The object does not see the client's request. The Worker makes a new one that names the workspace, after it has checked the session and the owner. The object remembers which workspace it holds from the first time it is used, and refuses to serve another.

## 6. What is not covered

- Messages are not rate-limited, and nothing limits how much a workspace stores. Both are bounded only by what one signed-in user does to their own workspace.
- A client cannot ask for part of a workspace: it holds all of it.
- When the schema version changes, a client of the new version drops its rows and says hello with the cursor `null`, unless it knows how to convert them. It keeps its client ID and its `lastMutationId`. Its unconfirmed mutations are sent as they are, and rejected if the new mutators do not take them.
- If the data of a workspace is ever restored to an earlier state, clients whose cursor is ahead get a snapshot, but a client can stay ahead unnoticed if the workspace then catches up with its cursor. Restoring has to come with a way to make every client start over, such as a new schema version.
