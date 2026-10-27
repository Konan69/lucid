# Memory in the Person cell

Status: chosen placement, integration in progress. [Runtime cells](27-runtime-cells.md) puts
Notes beside the native Pi Harness in one celld Person cell. There is no separate `Memory`
cell, `apps/memory` deployment, or server `MemoryCells` client. Cell-backed Notes behavior
and lifecycle have not yet been proven.

## Ownership

The Person cell's SQLite holds Notes separately from Pi's tables, using Pi's table prefix.
The note tools read the acting Person's Notes directly when running in that Person's cell.
A shared Thread lives in its creator's cell; another speaker's Notes still belong to that
speaker and require an authorized cross-cell call through the server. Missing Notes authority
must fail explicitly, never appear as an empty index.

Helix stays the deep memory layer on the server, with its knowledge graph and embeddings
searched on demand. It does not replace standing Notes. The response reads its Notes index
once and freezes it with the delivery's context.

AgentFS files, `VIVID_MEMORY_DIR`, and a central runtime volume are the pre-cell implementation
being replaced. Production conversation storage is native Pi Durable Object SQLite, and Notes
share that cell. PostgreSQL remains the product database.

## Notes behavior

Preserve `read_note`, `write_note`, and `delete_note`, the bounded index, correction of an
existing note, and forgetting it on request. A Person's question must not rewrite their Notes.
Tool receipts and recalled content are the observable proof, not a claim in the assistant's text.

The earlier memory design also proposed provenance, versions, and dreaming. Those remain
unbuilt extensions; their descriptions here do not make them prerequisites for the host change.
Provenance links a note to its source Thread and Message. Versioned writes reject stale edits
rather than overwrite them. Dreaming consolidates notes against their sources after a delay.
Any future dreaming work uses Pi's native durable tasks and the shared `onWake`/alarm lifecycle
inside the Person cell. It does not add a second host timer or scheduler. Product Watch schedules
remain on the server.

## Historical celld proof

A memory-only prototype ran on `cloudbox-konan2` on 15 October 2026 with two celld nodes and a
throwaway MinIO bucket. It showed:

- A note written through one node was read through the other.
- Two concurrent writes against version 1 returned one `200` and one `409` conflict.
- Across 200 Persons, writes measured p50 9.5 ms and p95 40.7 ms; reads measured p50 2.3 ms
  and p95 2.6 ms.
- The dream alarm fired.
- After the owner node was killed, reads resumed through the other node in 10.9 s, with a
  10-second lease. Requests failed during that interval.
- After both nodes stopped and their disks were wiped, a fresh node restored all 200 Persons
  from the bucket and answered their reads in 1.9 s.

These are historical prototype measurements. They do not prove the Vivid cell runtime, real
Notes tools, Railway placement, or production bucket latency. The prototype's disk wipe is
not a product procedure or permission to alter live data.

## Required proof

Use disposable celld storage on a devbox. Through the real server and shipped model, create a
standing preference, recall it, correct the same note, recall the correction, and forget it.
Require real tool receipts. Move or restart the cell and prove retained Notes, correct acting
Person scope, and continued conversation history.

The current `verify-vivid` launcher still starts the old Node host and invokes its PG migration
command. Notes recipes are blocked until that integration uses the cell host. A browser reload,
a disposable PG-adapter test, or a rehearsal model cannot establish cell-backed Notes durability
or model behavior. No production reset, data-loss step, or live-data copy is authorized here.
