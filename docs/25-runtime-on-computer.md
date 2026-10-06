# The runtime moves to the Computer: Pi Durable replaces Flue

**Status:** decision, 4 October 2026. Nothing is built yet. It replaces the "Decision" of
[Runtime platform research](11-runtime-platform-research.md) (Flue Node beside the server) and
fills in "Runtime on the Computer: planned" in [The Computer](04-computer.md). Until the branch
below lands, the code is still Flue 2.2.2 and `packages/agent/runtime/AGENTS.md` still describes
what runs.

Evidence is source and package metadata read on 4 October 2026: Pi 1.0 and `pi-durable` 1.0.x from
the upstream Pi repository, Open Session at `f1654fa35`, `ai` 7.0.127 with `@ai-sdk/harness-pi`
1.0.140, Cloudflare `agents` 0.26.0, and an inventory of this repository. **Nothing here was run.**
Every claim about another project's behaviour is **unverified** until the first live run on a Boat
guest. The Cloudflare and AI SDK API names were read through a summary and are the least certain.

## The decision

1. **Flue is replaced, not upgraded.** Flue 2.2.2 pins `pi-ai` and `pi-agent-core` at `^0.87.1`, so
   it cannot carry Pi 1.0. We do not wait for it.
2. **The runtime is Pi Durable (`@earendil-works/pi-durable`), used directly.** No framework sits
   between Vivid and it.
3. **It runs on the Person's Computer**, inside the Boat guest, as the process that owns the
   conversation. This is the shape [The Computer](04-computer.md) always described: the machine the
   agent lives on, not a harness it calls out to.
4. **Conversation state is SQLite on the Computer's disk.** PostgreSQL stays for product records on
   the server. The runtime no longer needs a Postgres adapter, which Pi Durable does not have.
5. **The server stays the authority for consequential actions.** Tools still call `/api/rpc`;
   Gate, Approvals, Connections and credentials do not move. The agent has wide authority on its
   own machine by design, so the lack of a sandbox boundary inside the guest is not an objection.
6. **We write our own AI SDK adapter, in a branch.** See "The AI SDK adapter" below.
7. **We do not adopt `@ai-sdk/harness-pi` or Cloudflare `PiHarness`.** Reasons are in the table.

## What was compared

| Option                 | What it is                                                                                                                                                                                                                        | Verdict                                                                                                                                                                 |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Flue 2.2.2 (today)     | Runtime beside the server, history in PostgreSQL, pinned to pi 0.87.1                                                                                                                                                             | Replaced. Known gaps: no queue-only dispatch, no attachments on signals, custom tools stringify images                                                                  |
| Pi 1.0 coding agent    | The hardened coding agent, Codemode, deferred tool loading, cache warming                                                                                                                                                         | Not the runtime. It is a product, not a harness. `pi-agent-core` 1.0 removed its harness, storage, compaction and skills                                                |
| **Pi Durable 1.0.x**   | Harness = storage + tasks. Checkpointed tasks, crash resume, exactly-once submission by `requestId`, forks, extensions (sections, tools, hooks, tasks), `beforeTool` can block, background compaction, `watch()` for many clients | **Chosen.** Marked experimental upstream; we pin an exact version                                                                                                       |
| Open Session           | On Pi 1.0 but keeps its own kernel, per-session SQLite transcripts, queues, recovery and cursor replay. It does not use Pi Durable                                                                                                | Reference for transcripts, cursor replay and attributed entries. On 23 September it moved the loop back to its server and left only file and shell tools in the sandbox |
| `@ai-sdk/harness-pi`   | AI SDK 7 harness that runs Pi in the host process with a sandbox as remote files and shell                                                                                                                                        | Rejected. It depends on `pi-coding-agent ^0.85.1` and `pi-ai 0.74.2`: not Pi 1.0, not Durable. No structured output. Experimental                                       |
| Cloudflare `PiHarness` | Pi Durable inside a Durable Object with `pi_` SQLite tables                                                                                                                                                                       | Rejected as a host: Cloudflare only, beta, and its stream is not AI SDK shaped. Kept as a reference for a thin wrapper around Pi Durable                                |

Open Session chose the opposite placement (loop on the server, tools in the sandbox) to keep model
credentials and permission checks off the guest. We keep the loop on the Computer and answer the
same concern with rule 5 above and the model-key rule below.

## What Pi Durable does not give us

- **No Postgres storage.** Memory, SQLite and JSONL only; one process owns the storage. Fine on a
  Computer, where one process is the rule.
- **No sender on a submission.** Input is text and images. Attribution is ours to add as a typed
  document or extension. Not needed while Vivid is used by one Person.
- **No skills and no subagents built in.** Both are extensions we write.
- **Reconnect returns current state, not an event replay.** A client that reconnects redraws from
  `viewState()`.
- **The API may change.** Upstream says so. We pin the exact version and upgrade on purpose.

## The AI SDK adapter

Web and mobile already render AI SDK-named message parts (`text`, `file`, `dynamic-tool`) through
`useFlueAgent` and `createFlueClient` in `apps/web/src/screen/Thread.tsx`,
`apps/mobile/src/screen/Chat.tsx` and both `data/threads.ts`. Neither ready-made bridge fits: the
AI SDK's Pi harness is on an old Pi, and Cloudflare's stream is its own format.

So Vivid owns one small adapter:

- **Input:** Pi Durable `watch()` / `watchEvents()` output for one conversation.
- **Output:** the AI SDK UI message stream, with the same part names the clients render today.
- **Home:** shared, so web, mobile and desktop use one mapping. The wire schema goes in
  `packages/contracts`; the client in `packages/client/rpc`.
- **Path:** Computer → server relay → client. The server checks the Person and Thread and relays;
  it does not hold the conversation.

**It is built in a branch**, together with the rest of the migration, not on `feat/one-product` or
`main`. Flue keeps running on the main line until the branch passes a live run through the real
runtime path: a Person's message from the web client, a tool call that reaches `/api/rpc`, an
Approval, a restart of the guest mid-turn, and a reconnect from mobile. The branch merges only
then. Whether the mapping is total (every Pi Durable event has an AI SDK part) is **unverified**
and is the first thing the branch must prove.

## What stays the same

- The server's Gate, Approvals, Connections, Routines, Threads metadata and every product table.
- Tools as thin typed calls to `VividRpc`. The 13 files that use Flue's `defineTool` are rewritten
  as Pi Durable extension tools with the same contracts.
- The 26 skill folders in `packages/agent/skills`. Only the loader changes: a skills section plus a
  read tool as one extension, and our own frontmatter parser in place of `@flue/runtime/internal`.
- The default model and the gateway.

## Migration work

Sizes are from the inventory: Flue touches about 5,300 production lines and 6,500 test lines.

1. **Runtime process on the guest.** Pi Durable with SQLite storage, started and supervised by the
   Boat guest. Replaces `packages/agent/runtime` (32 files).
2. **Tools and skills as extensions.** As above.
3. **Relay and adapter.** The AI SDK adapter and the server relay; web and mobile switch from the
   Flue client to it.
4. **Server stream readers.** Five places read the Flue stream today: settlement, the threads
   gateway, memory history, approval requests and thread generation. Each moves to the relay.
5. **Approvals.** `beforeTool` blocks the tool, the server decides, the task resumes.
6. **Delete Flue.** `@flue/*`, `@flue/postgres` and the runtime's Postgres schema, after the branch
   is live.

## Open questions, with proposed answers

These are proposals, not decisions.

- **A sleeping or archived Computer makes its Threads unreadable.** Proposed: the Thread list and
  titles come from server metadata as today; opening a Thread wakes the Computer.
- **Where the model key lives.** Proposed: never on the Computer. Model calls go through the server
  with a per-Computer token, which also keeps usage accounting in one place.
- **Shared Threads.** Deferred while Vivid is used by one Person. The Computer is one per Person and
  a response is for one Person ([One product](22-one-product.md)), so the likely shape is one
  harness per Person; it is not designed here.
