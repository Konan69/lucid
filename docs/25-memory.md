# Memory in the Person cell

Personal memory lives in the celld Person cell, beside Pi Durable's conversation tables in
native Durable Object SQLite. The cell opens the store and applies its migrations
(`apps/cells/src/main.ts`, `Person`; `packages/agent/runtime/src/memory.ts`, `openMemory`).
Settings and model tools reach the same entries. Placement is described in
[memory cells](26-memory-cells.md), and the implemented layers and remaining plans in
[Assistant patterns](28-assistant-patterns.md#4-memory-in-layers).

History. The 4 October filesystem experiment used AgentFS and Flue. That experiment preceded
the current cell implementation and does not establish its behavior. The historical layout
compared a hand-kept `- [Title](file.md)` index with one derived from entry headers.

## The direction

1. **One store per Person.** Memory belongs to the acting Person across Threads. The cell binds
   local operations and native cross-cell calls (`apps/cells/src/main.ts`, `Person`).
2. **Standing pages and a derived index.** A response gets complete written standing pages and
   a bounded index of other entries (`packages/agent/runtime/src/context.ts`, `listed`).
3. **Typed Markdown entries.** Each address has a layer and Markdown basename, with kind,
   description, body, basis, revision, time, and authority (`packages/contracts/src/memory.ts`,
   `MemoryAddress`, `SavedMemory`).
4. **Shared access.** Model tools and Settings use the same revision checks. Settings acts for
   the signed-in Person (`apps/server/src/runtime/handlers.ts`, `memoryHandlers`).

## Why cell storage

Memory and conversation execution share one Person cell. There is no memory filesystem mount
or separate retrieval service in this path (`apps/cells/src/main.ts`, `Person`). Standing pages
reach the model without a tool call. Other bodies are read when relevant, and entries beyond
the automatic index remain reachable through pagination and search
(`packages/agent/runtime/src/tools/memory.ts`, `memoryTools`).

## The layout

The layer vocabulary is `self`, `soul`, `person`, `memory`, `days`, `bank`, `people`, `dreams`,
`attention`, and `research`. Standing pages have canonical addresses such as `self/self.md`.
Ordinary entries have descriptive Markdown basenames. These are addresses in SQLite, not files
on disk (`packages/contracts/src/memory.ts`, `MemoryLayer`, `MemoryAddress`).

- `self`, `soul`, `person`, and `attention` are standing pages. Written pages are included whole.
- Other entries appear newest first within `INDEX_BUDGET`, currently 8,000 serialized characters.
  `list_memory` pages beyond the index, and `search_memory` uses SQLite FTS5 ranked excerpts.
- `read_memory` pages long bodies within the tool-output budget. Stored bodies have no such cap.
- `write_memory` accepts standing pages and the curated `memory` layer. It replaces the complete
  entry at the revision read. `delete_memory` retracts one address at that revision.

Sources are `packages/agent/runtime/src/memory.ts` (`index`, `list`, `search`, `write`, `retract`)
and `packages/agent/runtime/src/tools/memory.ts` (`memoryTools`). Each entry distinguishes
`said` from `guessed`. Host-supplied authority records a `ThreadRun`, `CellRun`, `Settings`, or
`HistoryLoad` source (`packages/contracts/src/memory.ts`, `MemoryBasis`, `MemorySource`).

## Native cell storage

`openMemory` applies ordered migrations with a separate `memory_migrations` ledger on the same
native SQLite queue used by Pi. Pi tables use the `pi_` prefix
(`packages/agent/runtime/src/memory.ts`, `openMemory`; `packages/agent/runtime/src/cell.ts`,
`openCell`). A stale write returns `MemoryConflict`. A retraction removes the body and retains
an incremented revision, so an old writer cannot restore it unnoticed.

The response snapshot is read before admission and kept beside its delivery. Its standing pages
and index remain frozen for that response. Unavailable memory is an explicit context state,
never an empty index (`packages/agent/runtime/src/context.ts`, `loadMemory`, `loadContext`;
`packages/agent/runtime/src/admission.ts`, `admit`).

## The knowledge base

History. Helix was removed from personal memory. Its old service and volume remain declared
with retention for migration (`infra/railway.ts`, `railwayResources`). Current memory search is
cell-local FTS5 (`packages/agent/runtime/src/memory.ts`, `search`).

## How Vivid learns

Vivid can write memory during a reply. After settlement, including a failed or stopped Run,
the cell's settlement follower captures each speaker's words and authority before releasing
frozen delivery context (`packages/agent/runtime/src/settled.ts`, `followSettlements`).

One deduplicated native Pi task groups the exchange by Person. With `VIVID_DECISIONS=on` and
an OpenRouter key, Jev judges whether each Person supplied a new durable fact. A probability of
at least 0.5 starts the learner. Decisions default off; an unavailable or failed decision
considers the exchange for learning (`packages/agent/runtime/src/settings.ts`, `decisionLayer`;
`packages/agent/runtime/src/learning.ts`, `consider`, `gate`).

The task owns its learner conversation, checkpoint, and stable submission request id. The
learner has memory read, list, search, and write tools only, and the host restricts writes to
`memory`. Its authority is `CellRun`. It belongs to no Thread and does not trigger further
learning (`packages/agent/runtime/src/learning.ts`, `starter`, `learn`, `learnerAuthority`;
`packages/agent/runtime/src/agents/learner.ts`, `learnerDefinition`).

## What exists today

Settings gets the index, lists entries, reads bodies, corrects entries, and retracts them through
`memoryHandlers` in `apps/server/src/runtime/handlers.ts`. Corrections and retractions compare
the revision shown to the Person and carry `Settings` authority. Successful changes are audited.
Missing entries, conflicts, and unavailable storage remain distinct outcomes
(`apps/server/src/runtime/client.ts`, `cellMemoryLayer`).

## The references, side by side

| Concern                                      | Source                                                           |
| -------------------------------------------- | ---------------------------------------------------------------- |
| Layers, addresses, revisions, and provenance | `packages/contracts/src/memory.ts`, `MemoryEntry`, `SavedMemory` |
| Persistence, pagination, and FTS5            | `packages/agent/runtime/src/memory.ts`, `openMemory`             |
| Response snapshot and prompt rendering       | `packages/agent/runtime/src/context.ts`, `loadContext`, `listed` |
| Model tools                                  | `packages/agent/runtime/src/tools/memory.ts`, `memoryTools`      |
| Settings access                              | `apps/server/src/runtime/handlers.ts`, `memoryHandlers`          |
| Learning after settlement                    | `packages/agent/runtime/src/learning.ts`, `learning`             |

## Historical proof, 4 October 2026

The filesystem experiment showed persistence and model recall through file tools. Its results
belong to that historical implementation. Current product proof uses the native cell launcher
and the memory recipe (`.agents/skills/verify-vivid/scripts/cells.mjs`, `startCells`;
`.agents/skills/verify-vivid/features/memory.md`).

## Not verified

Source establishes the implementation above, not reliable model behavior. The memory recipe
checks real receipts, same-entry corrections, recall, and retraction. Recovery also requires
restart and owner-move evidence (`.agents/skills/verify-vivid/features/memory.md`;
`.agents/skills/verify-vivid/references/cells.md`).

The settlement follower is in memory. A kill before learning-task admission can lose that
follow-up; the task is durable once created (`packages/agent/runtime/src/settled.ts`,
`followSettlements`). A local retraction does not remove related content in other layers,
Watches, queued work, or frozen context (`packages/agent/runtime/src/tools/memory.ts`,
`memoryTools`).

## Open questions

The Dreamer, scheduled consolidation, and full cross-layer forgetting remain plans in
[Assistant patterns](28-assistant-patterns.md). The current learner writes curated memory only
(`packages/agent/runtime/src/agents/learner.ts`, `learnerDefinition`).
