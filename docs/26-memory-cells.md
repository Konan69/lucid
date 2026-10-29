# Memory in the Person cell

Personal memory shares the native Pi SQLite database in the celld Person cell. There is no
separate memory deployment or server-owned personal-memory store. The cell binds the Memory
service when it opens (`apps/cells/src/main.ts`, `Person`; `packages/agent/runtime/src/cell.ts`,
`openCell`). [Runtime cells](27-runtime-cells.md) describes its host, and
[Assistant patterns](28-assistant-patterns.md#4-memory-in-layers) separates implemented layers
from planned upkeep and dreaming.

## Ownership

The cell applies memory migrations with a `memory_migrations` ledger, and Pi opens its own
storage with the `pi_` prefix (`packages/agent/runtime/src/memory.ts`, `openMemory`;
`packages/agent/runtime/src/cell.ts`, `openCell`). PostgreSQL holds product records.

A Thread lives in its creator's cell. Memory belongs to the acting Person. Local tools read
that Person's entries directly; another speaker's memory uses native cell-to-cell RPC through
`PERSONS.getByName`. The model cannot choose the actor or source. Settings goes through the
server's authenticated RPC handlers (`apps/cells/src/main.ts`, `Person`;
`packages/agent/runtime/src/authority.ts`, `resolveMemoryCall`;
`apps/server/src/runtime/handlers.ts`, `memoryHandlers`).

History. The earlier design named a separate `apps/memory` deployment. AgentFS files and `VIVID_MEMORY_DIR` belonged to the pre-cell runtime. Helix was removed
from personal memory. Its retained service and volume, and the disconnected `RuntimeMemory`
volume, remain migration resources (`infra/railway.ts`, `railwayResources`).

## Memory behavior

The model has `read_memory`, `list_memory`, `search_memory`, `write_memory`, and `delete_memory`.
Reads page long bodies, listing reaches older entries, and search uses native SQLite FTS5.
Writes replace a complete entry at the revision read. Retractions retain the revision while
removing content (`packages/agent/runtime/src/tools/memory.ts`, `memoryTools`;
`packages/agent/runtime/src/memory.ts`, `write`, `retract`).

The layers are `self`, `soul`, `person`, `memory`, `days`, `bank`, `people`, `dreams`, `attention`,
and `research`. Each entry holds Markdown, `said` or `guessed` basis, source authority, time,
and revision. The full written standing pages and a bounded index are frozen for each response
(`packages/contracts/src/memory.ts`, `SavedMemory`, `MemoryLayer`;
`packages/agent/runtime/src/context.ts`, `loadContext`, `listed`).

Learning runs in the cell after settlement. Its native Pi task asks Jev whether an exchange is
worth keeping when decisions are enabled, then runs a learner restricted to curated `memory`.
A disabled or unavailable decision considers the exchange instead. The task and its learner
submission are deduplicated (`packages/agent/runtime/src/learning.ts`, `consider`, `starter`,
`learn`; `packages/agent/runtime/src/agents/learner.ts`, `learnerDefinition`).

The Dreamer and periodic upkeep remain plans. The current learner does not write the dated
trail, bank, people pages, dreams, or research. A `delete_memory` receipt retracts one entry and
reports `forget_complete: false`; it cannot prove cross-layer forgetting
(`packages/agent/runtime/src/agents/learner.ts`, `learnerDefinition`;
`packages/agent/runtime/src/tools/memory.ts`, `memoryTools`).

## Historical celld proof

A memory-only prototype on 15 October 2026 exercised cross-node reads, revision conflicts,
owner loss, and bucket restore. Those historical results do not prove the current product's
memory tools or conversation recovery.

## Required proof

The verifier now deploys the shipped Worker to two native celld nodes and a disposable bucket
(`.agents/skills/verify-vivid/scripts/cells.mjs`, `startCells`). Through the real server and
model, create a preference, recall it in another Thread, correct the same entry, recall the
correction, and retract it. Require persisted entries and tool receipts, then repeat recall
after restart and owner move (`.agents/skills/verify-vivid/features/memory.md`;
`.agents/skills/verify-vivid/references/cells.md`). A browser reload or rehearsal alone does not
establish cell durability or real-model behavior.
