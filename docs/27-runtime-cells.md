# Runtime: one cell per Person on celld

Status: chosen target, integration in progress. The custom runtime PostgreSQL adapter is being
deleted now. The cell host, Notes, infrastructure wiring, and cell-backed product verification
are not yet proven. Product PostgreSQL remains. This decision authorizes no production deploy,
reset, or live-data change.

## The decision

Each Person's agent runtime runs as one celld Durable Object cell, named by `PersonId`. The cell
opens a Pi Durable `Harness` over its own SQLite database, serves that Person's Threads, and
sleeps when nothing runs. PostgreSQL keeps only app records, including auth, Company and Membership, Thread metadata,
Runs, Library items, and Connections.

This is the shape [the Computer plan](04-computer.md) already chose: Pi Durable used directly,
SQLite per Person, the server as relay and as the authority for consequential actions. The cell is
a different host for the same shape. The Computer is not reliable enough to hold the conversation
yet (15 October 2026). Moving conversation storage onto a Computer remains outside this change.

It also absorbs [memory cells](26-memory-cells.md). That design gave each Person a `Memory` cell
that the runtime reached through the server. With the runtime in the cell, the notes are tables
in the same database and the note tools read them directly.

## Why cells

- **Pi ships the adapter.** `openDurableObjectSqliteStorage(ctx.storage)` is Pi Durable's own
  Durable Object backend. It needs `sql.exec(...).toArray()` and `transaction(async fn)`, and
  celld 0.6.2 implements both in `crates/celld/js/harness.js`. The custom PG adapter is removed,
  rather than maintained alongside native storage.
- **Pi 1.4.0 can sleep.** `HarnessOptions.onWake` tells the host when the Harness next needs to
  run (`active`, or `at` a time). The cell sets its alarm to that time and hibernates. Retries,
  backoffs and sleeps no longer hold a process.
- **One writer per Person.** celld owns activation, ownership, and idle lifecycle. Pi owns tasks,
  queues, deduplication, wait, abort, and restart. Vivid adds no central Persons map, ownership
  lock, generation fence, idle timer, or recovery loop.
- **The runtime scales out.** Cells spread Persons across nodes, and any node routes a call to
  the owner. Notes share the cell's SQLite rather than an AgentFS file on a central volume.
- **The bucket is the truth.** Every write is an LTX segment copied to a follower node and then to
  the bucket. A wiped node restores its cells from the bucket. The historical memory-only proof
  restored 200 Persons in 1.9 s; it did not prove Vivid conversation recovery.

## The request path

```
client ──/api/rpc──▶ server (Node, Railway)
                       │  auth, Company scope, Thread index, approvals
                       │  fetch http://cells-a.railway.internal/persons/:personId/...
                       ▼
                     celld node (any) ──forwards──▶ owner node
                                                     │
                                                     ▼
                                              Person cell
                                              ├─ Pi Harness (tables prefixed pi_)
                                              ├─ notes
                                              └─ alarm = next wake
                                                     │ fetch
                              ┌──────────────────────┼─────────────────────┐
                              ▼                      ▼                     ▼
                         model provider        the Computer (Boat)    server /api/rpc
                                                                     (tools that need
                                                                      app records)
```

1. The client talks only to the server, as today. The server checks the session and the
   Membership, then calls the cells service on Railway's private network.
2. The cells Worker reads `personId` from the path and calls `env.PERSONS.getByName(personId)`.
   The node that received the call activates the cell, or forwards it to the node that owns it.
3. The cell's `fetch` hands the request to the runtime's Effect router through
   `HttpRouter.toWebHandler`. The routes stay those of `packages/agent/runtime/src/app.ts`:
   submit, abort, submission, state, attachments. `GET …/submissions/:id` directly awaits native
   `submission.wait(context)` and returns only `Done`, `Failed`, or `Stopped`. Cancelling the
   request ends only that wait. In-progress state comes from watch/live documents.
4. Tools that need an app record (Library, Connections, approvals) call the server's `/api/rpc`
   with the runtime token, as today. Tools that act on the Computer call the Boat API. The model
   call is a `fetch` to the provider.

The cell holds no credential that the runtime does not hold today. The cells service's public
listener has no authentication, so every call carries the runtime token (`Redacted`), checked in
the Worker, and only the private network reaches it.

## The cell

One `Person` Durable Object opens one native Pi Harness over its SQLite. Cell program packaging
and infrastructure integration are in progress. Use pi-durable 1.4.0's own Cloudflare SQLite and
`onWake`/alarm pattern. celld's `examples/pi` uses another `agents/harness` SDK and is only a
host-binding reference.

- **Open.** The constructor opens storage and the Harness inside `blockConcurrencyWhile`, as
  pi-durable's version-matched README does. That gate has a 30-second limit, so opening
  must not wait on the network.
- **Run.** A submission commits through Pi's storage, then the Harness schedules the Run. A phase
  is not inside a SQLite transaction, so a model call longer than 30 seconds is fine. Only each
  commit is a transaction.
- **Wake.** Arm an alarm before opening or starting work. `onWake` updates it from
  `harness.wake()`, including the native active-work recovery heartbeat and earliest sleeping
  task. `alarm()` arms the next wake before calling `harness.resume()`. Use that native pattern
  directly; a missing alarm can strand work. celld owns hibernation and activation.
- **Watch.** A client follows a Thread through the server. The server holds one hibernatable
  WebSocket per open Person to the cell and fans updates out on its own live channel. When celld
  moves the cell, the socket closes, and the server reconnects and reads the Thread's state
  again. Everything committed is in the cell's database, so a reconnect loses nothing.
- **Notes.** Notes live beside Pi's tables. Pi's `prefix` keeps the two apart in one database.
  Notes integration is not yet proven. Dreaming remains unbuilt and must share the cell's wake
  lifecycle, not install another scheduler.

## What the runtime has to drop

A cell runs on V8 with partial Node compatibility. Network and process work must use supported
host APIs or the Computer. The pre-cell integration has these host dependencies to remove:

- The custom PG adapter is being deleted in favor of native Durable Object SQLite.
- `node:http` and `@effect/platform-node`. Replaced by `HttpRouter.toWebHandler` (Effect 4.0.2).
- `agentfs-sdk`. Replaced by the notes tables.
- `child_process` and `inspector`. Anything that ran a process runs on the Computer instead.

## Writes per reply

Pi saves streamed output every 100 ms (`DEFAULT_PROGRESS_POLICY`), and each save is a replicated
write. With two nodes a write finishes when the follower holds it (historical memory-only proof, p50 9.5 ms,
p95 40.7 ms). With one node every write waits for the bucket, about 90 ms to a region-local
store. So the fleet runs at least two nodes, and the proof measures whether 100 ms progress holds
under load or the interval rises.

## Infrastructure

Alchemy owns the target infrastructure below. This wiring is in progress; no cell deployment
or production conversion is claimed.

- **One Railway service per node:** `cells-a`, `cells-b`, image `ghcr.io/denoland/celld:v0.6.2`
  pinned, each with its own small volume and its own private name. A node advertises that name to
  its peers through the bucket. Replicas of one service would share one name, so each node is its
  own service.
- **One Cloudflare R2 bucket,** checked with `celld diagnose` for conditional writes before first
  use.
- **The cell program** deploys through Alchemy using celld's native deployment protocol.
  Nodes pick up a new version without a restart.
- **The server** gets `VIVID_CELLS_URL` and the runtime token. The `runtime` service and its
  volume go away.

Scaling adds a node: one more service (`cells-c`) pointed at the same bucket. celld moves
hibernated cells onto it by weight. It does not autoscale, and Railway does not autoscale
horizontally, so node count is a setting we raise.

## Failure

- **A node dies.** Its cells move to a survivor once the 10-second lease runs out (memory proof:
  10.9 s, historical and memory-only). Calls in that window fail with a typed `CellUnavailable`; the client shows the Thread
  as reconnecting. A Run that was mid-phase restarts from its last commit, and Pi 1.4.0 parks a
  task that crashes five times in a row.
- **Every node dies.** A fresh node restores every cell from the bucket.
- **A deploy.** Pi 1.4.0 migrates its SQLite to schema version 2 on open, and 1.3.0 or earlier
  cannot read it, so a runtime release cannot roll back past that upgrade.

## Risks

- celld is a 0.6.2 beta from one vendor.
- Peer traffic is plaintext HTTP. Railway's private network carries it.
- The 30-second limit on a transaction and on `blockConcurrencyWhile`.
- An outbound socket from a cell closes when the cell moves. Every caller reconnects.
- Attachments do not belong in a cell's SQLite. They go to the bucket under the Person's prefix.

## Required proof

Use a disposable devbox stack with native Pi 1.4.0 Durable Object SQLite and celld 0.6.2.
Drive a Thread through the real server gateway, move its owner mid-reply, and prove the reply
finishes with committed history intact. Prove native terminal waiting, explicit abort, Notes,
pictures, and state-link reconnect through the product. Product authorization and settlement
effects must survive the host change.

The verifier still launches the old Node runtime and invokes a runtime PG migration command.
Cell-backed Launch, Doctor, feature, browser, and Cleanup are blocked until that integration is
replaced. Tests of the discarded PG adapter are not future proof. Integrated checks and the real product run
remain required. No live-data import or reset is part of this change.

## Feature map

This historical inventory records `feat/pi-port` at `cb3ccd09`, rebased on main on 25 October 2026. The Pi-port column and test filenames describe that pre-cell source, not passing evidence
or future storage fixtures. "From main" records ported behavior. Every row still needs cell-backed
product proof. Preserve each feature and the server's auth, Membership checks, and Thread index.

The runtime runs the conversation in the cell. Product credentials, process execution, and work
spanning Persons stay on the server: approvals, Computers, devices, Integrations, Library
ingestion, Watches, the Feed, notifications. The cell reaches those through `/api/rpc` the way
the runtime does today.

| Feature                      | Pi-port                                                              | In the cell                          | Server keeps                                     | Before the cell                                                                                                                        |
| ---------------------------- | -------------------------------------------------------------------- | ------------------------------------ | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| First message                | Unproven (`routes.test.ts`)                                          | Conversation, generation, projection | Run reservation and receipt, settlement effects  | Host off Node                                                                                                                          |
| First-send handoff, greeting | Unproven (`sending.test.ts`, `first.live.test.ts`)                   | First conversation, greeting         | Once-only claim, Run receipt                     | Same delivery key across a cell move                                                                                                   |
| Reload a Thread              | Unproven (`routes.test.ts`, `link.test.ts`)                          | Transcript and projection            | Access checks                                    | Each new reader loads the whole transcript (`state/link.ts` `transcript`)                                                              |
| Socket recovery              | Unproven for a process restart, never run for a cell move            | Committed state                      | The product socket                               | Reconnect when a cell moves                                                                                                            |
| Rich replies                 | From main: inline OpenUI, unproven                                   | Assistant text and tool records      | Display actions                                  | None                                                                                                                                   |
| Interactive display actions  | From main, unproven                                                  | Stored display source                | Display authority, execution                     | None                                                                                                                                   |
| Questions                    | From main: nonblocking, unproven                                     | Question call, answer delivery       | Input request, answers, withdrawal               | None                                                                                                                                   |
| Question withdrawal          | Unproven                                                             | The new input                        | Answer and withdrawal race                       | None                                                                                                                                   |
| Allow an action              | Unproven (`outcomes.test.ts`, `thread.live.test.ts`)                 | Proposed call and continuation       | Approval, policy, ledger, credentials            | External work stays outside a cell transaction                                                                                         |
| Deny an action               | Unproven (`replay.test.ts`)                                          | Outcome signal                       | Denial, delivery debt                            | None                                                                                                                                   |
| Stop work                    | Unproven (`routes.test.ts`)                                          | Task cancellation, settlement        | Run authorization, admission gate                | An `AbortSignal` does not cross a celld RPC. Stop stays an explicit route                                                              |
| Send a picture               | Unproven (`link.test.ts`)                                            | Picture bytes in the transcript      | Size and type checks, byte proxy                 | Pictures go over HTTP, not a socket (1 MiB input budget). Move the bytes to the bucket                                                 |
| Run a program                | Unproven (`code.test.ts`, `machine.test.ts`)                         | Tool call and receipt                | Program runner, Computer                         | None. Programs run on the Computer                                                                                                     |
| Documents                    | Unproven. Attribution picks the working Run, main used the tool call | Tool receipts                        | Artifacts and versions                           | Settle attribution when two Runs are working                                                                                           |
| Watches                      | From main, unproven                                                  | Background conversation              | Watch records, Executor subscriptions, callbacks | None                                                                                                                                   |
| Reminders                    | From main (Watch chain), unproven                                    | The reply to a reminder              | The schedule, or main's Watch chain              | A Pi alarm does not replace the product scheduler                                                                                      |
| Feed                         | From main, unproven                                                  | Background conversation              | Feed cards, seen and Done                        | It stays a server read across Threads, never a scan of cells                                                                           |
| Library                      | Unproven for search (`scope.test.ts`)                                | Search call and result               | Upload, extraction, search, access               | None                                                                                                                                   |
| Device permission requests   | From main with `asking`, unproven                                    | Model `UseWindow`/`Browse` calls     | Enrolment, allowance, native streams             | None                                                                                                                                   |
| Desktop app                  | Unproven (`computer.test.ts`), `copy_signin` from main               | Conversation, native tool adapters   | Desktop auth, native work                        | None                                                                                                                                   |
| Notes                        | Unproven. Notes lifecycle from main                                  | `notes` tables                       | Helix                                            | AgentFS cannot run in a cell (no persistent files). Notes move into the cell's tables                                                  |
| Read reporting               | Not runtime. `seen.ts` from main                                     | None                                 | Read state, attention                            | None                                                                                                                                   |
| Settings, Integrations       | Not runtime, apart from reading context (`routes.test.ts`)           | Frozen reply context                 | Settings, Connections                            | None                                                                                                                                   |
| Appearance, name             | Name in context, unproven                                            | Frozen name                          | Appearance                                       | None                                                                                                                                   |
| Projects                     | Unproven (`projects.test.ts`)                                        | Tool call                            | Projects, Thread filing                          | None                                                                                                                                   |
| Saved and built-in skills    | Unproven (`skills.test.ts`)                                          | Built-ins, activation                | Saved procedures                                 | Built-in skills read files (`skills.ts` `readSkill`). Bundle them                                                                      |
| Sharing                      | Unproven (`routes.test.ts`)                                          | The creator's conversation           | Participants, acting authority                   | A shared Thread lives in its creator's cell, but notes belong to whoever speaks. The cell reads that Person's notes through the server |
| Notifications                | Unproven (`notify.test.ts`)                                          | Tool receipt, completion signal      | Notifications, push                              | The server must still see settlement after a cell sleeps or moves                                                                      |
| Android navigation           | Not runtime                                                          | The open Thread's reads              | List, presence                                   | None                                                                                                                                   |

Two changes apply to every row.

- **The host.** The old Node listener and AgentFS must leave the cell path. The custom PG
  adapter is being deleted. Bundle compatibility and transitive dependencies remain unproven;
  celld's Node compatibility alone is not evidence that the Vivid program runs there.
- **Settlement follow-up.** `settled.ts` `followSettlements` releases deliveries and records
  responses from a queue in memory, after Pi's commit. A cell can be evicted between the two, so
  that work becomes a Pi task.

The cell-backed recipes must send through `SendToThread`, read through `WatchConversation`,
and retain evidence from the cell. Reload, socket recovery, and Notes also need an owner-move
step. The old Node launch cannot satisfy this requirement.
