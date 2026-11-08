# Runtime: one cell per Person on celld

The cell host is implemented in `apps/cells/src/main.ts` (`Person`). Each Person has one native
Pi Durable Harness over celld Durable Object SQLite. Memory shares that database. Product
PostgreSQL remains on the server (`packages/agent/runtime/src/cell.ts`, `openCell`;
`scripts/migrate.mjs`). Source describes the implementation; product and recovery claims still
require the real-runtime evidence below. This document authorizes no production action.

The implemented memory layers, cell-owned learning, and planned Dreamer are described in
[Assistant patterns](28-assistant-patterns.md). The cell is their persistence and execution host.

## The decision

Each Person's cell is named by `PersonId`. It serves every Thread created by that Person and
opens one Harness over native SQLite. PostgreSQL keeps auth, Company and Membership, Thread
metadata, Runs, Library items, and Connections (`apps/cells/src/main.ts`, `Person`;
`packages/agent/runtime/src/person.ts`, `openPerson`).

The server remains the product authority and runtime relay. Tools that need product records
call its typed RPC client. Memory uses the acting Person's cell, which can differ from the
Thread creator's cell (`packages/agent/runtime/src/client.ts`, `Product`;
`packages/agent/runtime/src/authority.ts`, `resolveMemoryCall`).

## Why cells

- **Native storage.** `openCell` uses Pi's `openDurableObjectSqliteStorage` with the `pi_` prefix
  (`packages/agent/runtime/src/cell.ts`).
- **Native wake.** The cell arms alarms from Pi's `wake()` and resumes work on an alarm.
  celld owns activation and idle lifecycle (`apps/cells/src/main.ts`, `Person`).
- **One owner per Person.** Pi owns tasks, queues, deduplication, wait, abort, and restart.
  Vivid registers its tools and learning task with that Harness
  (`packages/agent/runtime/src/person.ts`, `openPerson`).
- **Shared cell storage.** The fleet declares two nodes and one retained Railway bucket. Each node
  has a separate local volume and advertised peer address (`infra/cells.ts`, `railwayCells`).

History. The custom runtime PostgreSQL adapter and AgentFS memory belonged to the pre-cell
implementation. Runtime migrations now apply only to server auth and product tables
(`scripts/migrate.mjs`); cell memory migrations run when `Person` opens.

## The request path

```text
client → /api/rpc → server → celld ingress → owning Person cell
                   │                       ├─ Pi Harness (pi_ tables)
                   │                       ├─ memory and FTS5
                   │                       └─ alarm and carrier event
                   └← product RPC tools ←────────┘
```

1. The server checks product authority and addresses the Thread creator's cell. It tries another
   configured node on a transport failure (`apps/server/src/runtime/client.ts`, `makeRuntime`;
   `apps/server/src/runtime/transport.ts`, `cellNodes`).
2. The Worker checks the runtime token and resolves `PERSONS.getByName(personId)`
   (`apps/cells/src/main.ts`, default `fetch`). `/health` is a public liveness exception.
3. The cell hands requests to the Effect router created by `openCell`. Routes cover admission,
   abort, terminal waiting, state, attachments, history import, and Settings memory
   (`packages/agent/runtime/src/cell.ts`, `openCell`; `packages/agent/runtime/src/app.ts`, `routes`).
4. The cell queues router work and pumps response bodies inside one carrier event. Model tools
   use the server's RPC authority or memory authority
   (`apps/cells/src/main.ts`, `Person`; `packages/agent/runtime/src/tools/index.ts`, `tools`).

`GET …/submissions/:id` returns only terminal `Done`, `Failed`, or `Stopped`. Its response body
owns the native wait. State streams report progress separately
(`packages/agent/runtime/src/app.ts`, `settled`, `stateEvents`).

## The cell

`Person` in `apps/cells/src/main.ts` owns the following lifecycle.

- **Open.** `blockConcurrencyWhile` opens local memory migrations and the Harness. Recovery
  resumes later inside the carrier, after the alarm has been armed.
- **Run.** All Pi router work starts from one carrier loop. Its event stays live through
  `waitUntil` until queued jobs, active work, settlement follow-ups, and ready or running
  background tasks are quiet. Sleeping or waiting tasks remain scheduled by Pi.
- **Wake.** Before admission, abort, or resume, the cell arms Pi's active-work heartbeat.
  `onWake` updates the alarm from Pi's active flag and earliest deadline. `alarm()` queues
  recovery through the same carrier.
- **Watch.** The carrier pumps state and settlement response bodies. The state link uses
  Server-Sent Events to the server, which exposes the product stream to clients
  (`packages/agent/runtime/src/app.ts`, `stateEvents`;
  `apps/server/src/runtime/client.ts`, `makeRuntime`).
- **Memory.** Local operations use the opened store. Another acting Person's entries use native
  cell RPC, with typed decoding of the result. Settings enters through the token-protected HTTP
  routes. Memory migrations have a separate ledger (`packages/agent/runtime/src/memory.ts`,
  `openMemory`).

History. Holding one event per request until the Person became quiet accumulated retained
events during overlapping Threads and learning. celld refused the cell at 64 in-flight events.
The carrier fix in #174 holds one event for Pi work plus requests still being answered
(`apps/cells/src/main.ts`, `Person` carrier implementation).

## What the runtime has dropped

The native host uses `HttpRouter.toWebHandler` rather than a Node HTTP listener
(`packages/agent/runtime/src/cell.ts`, `openCell`). Cell memory is SQLite-backed through
`openMemory` in `packages/agent/runtime/src/memory.ts`. Programs execute on the Computer
through product tools (`packages/agent/runtime/src/tools/code.ts`, `codeTools`).

History. Flue and the filesystem-slot design are no longer part of this runtime.

## Writes per reply

Pi owns conversation commits and streamed progress persistence. Vivid supplies native storage
and model settings rather than a second persistence loop (`packages/agent/runtime/src/cell.ts`,
`openCell`; `packages/agent/runtime/src/person.ts`, `openPerson`). The carrier keeps the event
that owns those continuations alive. Replication cost and progress under load need fleet
measurements; the old memory-only prototype is historical evidence only.

## Infrastructure

Alchemy declares the fleet in `infra/cells.ts` (`railwayCells`). No deployment result is implied
by these declarations.

- Each node is a separate Railway service, `cells-a` or `cells-b`, pinned to celld 0.6.2, with
  its own volume, private address, and peer advertisement.
- One retained Railway bucket holds fleet data.
- The server's pre-deploy command applies product migrations, then publishes the Worker
  (`infra/railway.ts`, `railwayResources`; `apps/cells/scripts/build.mjs`, `main`).
- `cellVariables` supplies private Worker bindings for server authority, selected model,
  provider credentials, and optional `VIVID_DECISIONS`. The server gets the comma-separated
  private node addresses (`infra/cells.ts`, `cellVariables`, `cellsUrl`).
- History. The retained `RuntimeMemory` volume preserves the old filesystem data for migration.
  It is disconnected from services (`infra/railway.ts`, `railwayResources`).

The local Alchemy graph starts the same Worker through native celld development mode on port
5173 (`alchemy.run.ts`, `localStack`). It does not start a runtime PostgreSQL migration or Node
listener. Adding a fleet node requires another declared service and volume
(`infra/cells.ts`, `nodes`, `railwayCells`).

## Failure

Transport failure can advance the server to another ingress node. Terminal observation
reconnects through `observeRun`; the cell resumes interrupted native tasks through its alarm
(`apps/server/src/runtime/transport.ts`, `cellNodes`;
`apps/server/src/runtime/settlement.ts`, `observeRun`; `apps/cells/src/main.ts`, `Person`).

A failed Harness aborts the cell instance. Provider or storage diagnostics stay behind the
runtime's typed HTTP refusals (`apps/cells/src/main.ts`, `Person`;
`packages/agent/runtime/src/app.ts`, `answered`). Recovery proof must inspect committed history
and the same submission, not infer success from node health.

## Risks

- A cell move interrupts open streams. Reconnect must be proved through the product
  (`.agents/skills/verify-vivid/references/cells.md`).
- Settlement follow-up still uses an in-memory queue. Once admitted, learning is a durable Pi
  task; a kill before admission can lose it (`packages/agent/runtime/src/settled.ts`,
  `followSettlements`; `packages/agent/runtime/src/learning.ts`, `starter`).
- Picture bytes currently remain in Pi's transcript, and the attachment route reads them there
  (`packages/agent/runtime/src/state/pictures.ts`, `picture`).
- Memory retraction is local, not full forgetting across layers or queued work
  (`packages/agent/runtime/src/tools/memory.ts`, `memoryTools`).

## Required proof

The verifier deploys the shipped Worker to two celld 0.6.2 nodes with disposable native storage
and a private bucket (`.agents/skills/verify-vivid/scripts/cells.mjs`, `startCells`). Run Launch,
Doctor, touched HTTP and browser journeys, and Cleanup. Real-model memory, terminal waiting,
explicit abort, pictures, restart, owner loss, idle wake, and reconnect after a move each require
their own receipts (`.agents/skills/verify-vivid/references/cells.md`). A rehearsal proves
plumbing only. Run continuity alone does not prove that streamed text was preserved.

## Feature map

This map records ownership, not passing verification. Runtime routes and tool registration are
in `packages/agent/runtime/src/app.ts` (`routes`) and
`packages/agent/runtime/src/tools/index.ts` (`catalogue`). The server relay is
`apps/server/src/runtime/client.ts` (`makeRuntime`). Each product claim needs its mapped recipe
under `.agents/skills/verify-vivid/features`.

| Feature                              | In the cell                                    | Server keeps                                         |
| ------------------------------------ | ---------------------------------------------- | ---------------------------------------------------- |
| First message and first-send handoff | Conversation, generation, projection           | Run reservation, once-only claim, settlement effects |
| Reload and socket recovery           | Transcript, state stream                       | Access checks, product subscription                  |
| Rich replies and display actions     | Text, tool records, display source             | Display authority and execution                      |
| Questions and withdrawal             | Question call, answer delivery                 | Input requests and answer race                       |
| Allow or deny an action              | Proposed call, continuation, outcome signal    | Approval, policy, ledger, credentials                |
| Stop work                            | Task cancellation, settlement                  | Run authorization and admission gate                 |
| Pictures                             | Bytes in the transcript, attachment route      | Type and size checks, byte proxy                     |
| Programs                             | Tool call and receipt                          | Computer runner                                      |
| Documents                            | Tool receipt                                   | Artifacts and versions                               |
| Watches and reminders                | Background conversation and reply              | Watch records, subscriptions, schedules              |
| Feed                                 | Background conversation and tool calls         | Feed cards, seen and Done                            |
| Library                              | Search call and result                         | Upload, extraction, search, access                   |
| Devices and desktop                  | Conversation and native tool calls             | Enrolment, permission, native streams, auth          |
| Memory                               | Layered entries, index, search, learning       | Settings authority and relay                         |
| Read reporting                       | None                                           | Read state and attention                             |
| Settings, Integrations, appearance   | Frozen response context                        | Settings, Connections, appearance                    |
| Projects                             | Tool call                                      | Projects and Thread filing                           |
| Saved and built-in skills            | Bundled built-ins, activation                  | Saved procedures                                     |
| Sharing                              | Creator's conversation, acting Person's memory | Participants and acting authority                    |
| Notifications                        | Tool receipt and completion signal             | Notifications and push                               |
| Android navigation                   | Open Thread's reads                            | Thread list and presence                             |
