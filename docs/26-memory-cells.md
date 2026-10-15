# Memory: one cell per Person on celld

**Status:** design, 15 October 2026. Nothing is built. It replaces Vivid's instant memory, the
notes in [Memory](25-memory.md) (AgentFS, one SQLite file per Person on the runtime's volume).
Helix is not touched: it stays the deep layer, the knowledge graph and embeddings, cold storage
that Vivid searches when it needs to. The cell is the always-on memory, in front of the model on
every response, like Claude Code's.

## The decision

1. **All of Vivid's memory of a Person lives in one memory cell.** A cell is a Durable Object on
   [celld](https://github.com/denoland/celld) (self-hosted Durable Objects, 0.6.2): its own SQLite
   database, its own alarm, replicated to an object-storage bucket.
2. **celld runs beside the server on Railway, not on the Person's Computer.** The Computer is not
   reliable enough yet to hold anything a Person cannot lose.
3. **Any copy of the server or runtime can reach any Person's cell.** celld routes a request to the
   node that owns the cell, so there is no volume lock and no single runtime process.
4. **Memory keeps itself tidy by dreaming.** A cell's alarm asks the server to consolidate that
   Person's memory a few hours after it last changed.
5. **Two layers, each with one job.** The cell is near-instant memory (notes with provenance and a
   version). Helix is the knowledge graph and embeddings, searched on demand.

## What it replaces

| Today                                                                 | After                                    |
| --------------------------------------------------------------------- | ---------------------------------------- |
| `packages/agent/runtime/src/notes.ts`, `agentfs-sdk`, `VIVID_MEMORY_DIR`, the runtime volume | The cell's `notes` table                 |
| The single-runtime rule (one process owns every Person's file)        | Gone: celld owns each cell               |

## Why celld

The runtime is one Railway copy today because AgentFS locks each Person's file to one process.
Scaling out needs every copy to reach every Person's memory with one writer per Person. That is
what a Durable Object is, and celld runs them without the Cloudflare network. Postgres was rejected
(the developer, 4 October: "no pg"). A git repository per Person was rejected as infrastructure we
would have to run (15 October).

**Proof, 15 October, on `cloudbox-konan2`** (throwaway, MinIO as the bucket, two celld nodes):

- A note written through one node was read through the other.
- Two copies writing version 1 of one note at once: one `200`, one `409` conflict.
- 200 Persons, one cell each: write p50 9.5 ms, p95 40.7 ms; read p50 2.3 ms, p95 2.6 ms.
- The dream alarm fired.
- Owner node killed with `kill -9`: every Person answered again through the other node after
  10.9 s. That is the lease lifetime (`CELLD_TTL_MS`, 10 s); requests in that window fail.
- Both nodes stopped and their disks wiped: a fresh node restored all 200 Persons from the bucket.

**Not proven yet:** celld on Railway's private network, latency to the production bucket, and
celld's maturity (0.x, released 7 October 2026).

## The model

```ts
// packages/contracts/src/memory.ts
NoteFile    // branded, /^[a-z0-9][a-z0-9-]{0,62}\.md$/ (unchanged)
NoteVersion // branded positive integer; 0 means "no note yet" on write
Source      // { thread: ThreadId, message: MessageId, at: DateTime.Utc }
Note        // { file, kind: MemoryKind, description, body, sources: NonEmptyArray<Source>,
            //   version: NoteVersion, updated: DateTime.Utc }
NoteLine    // { file, kind, description } — the index line, as today
```

- **Provenance on every note.** Each write cites the Thread and Message it came from. The model
  never sees these identifiers: a tool shows sources as "source 1, source 2" and the server
  resolves the number.
- **Versions, not locks.** A write names the version it read. A stale write gets the current note
  back as a `NoteConflict` and the model writes one version that keeps what is true in both.

## The cell

One Durable Object class, `Memory`, in a new app `apps/memory` (it deploys on its own). One cell
per Person, named by `PersonId`. Its SQLite holds `notes` (one row per note, the fields above) and
`dreams` (when each ran and what it changed).

| Call                      | Does                                                                 |
| ------------------------- | -------------------------------------------------------------------- |
| `index`                   | Index lines, most recently changed first, within `INDEX_BUDGET`      |
| `read(file)`              | One note, or `NoteMissing`                                           |
| `write(note, expected)`   | Writes if the stored version is `expected`, else `NoteConflict`      |
| `delete(file, expected)`  | The same rule                                                        |
| `changed()`               | Arms the dream alarm if none is armed (called after each settled Run)|
| `dream.commit(batch)`     | All of a dream's writes in one transaction, each with its version    |

Every call carries a shared token (`Redacted`, checked in the Worker); celld's public listener has
no authentication of its own. Only the server's private network reaches it.

## The server

- `MemoryCells`, a `Context.Service` in `apps/server/src/memory`, is the only client of the cells.
  It decodes every response with the contract schemas and fails with `MemoryUnavailable`,
  `NoteMissing` or `NoteConflict`.
- The runtime's note tools (`read_note`, `write_note`, `delete_note`) call the server over
  `/api/rpc`, like every other tool. The runtime holds no memory and no volume.
- The index is read once per response and put in front of the model, as today. An unreachable cell
  is told to the model as `Unavailable`, never as "no notes".

## Dreaming

After a Run settles, the server calls `changed()`. The cell arms an alarm four hours out if none is
armed. When it fires, the cell calls the server's private `dream(person)` route. The server runs one
model loop over that Person's notes and the Messages since the last dream, with tools to list, read
and write notes and to open a note's sources. It adds patterns, merges duplicates, removes what is
no longer true, and settles contradictions against the source. All writes land in one
`dream.commit`. If any note changed meanwhile, the whole dream is dropped and the next alarm tries
again. The model credential stays on the server; the cell only keeps time.

Helix's learning after each Run stays as it is: that feeds the knowledge graph, not the notes.

## Infrastructure

- **Two celld services on Railway**, `memory-a` and `memory-b`, image
  `ghcr.io/denoland/celld:v0.6.2` (pinned), each with its own small volume for `CELLD_WATCH` and its
  own private name (`memory-a.railway.internal`). Two nodes make a write finish when the second
  node holds it, not after a bucket round trip. Declared in `infra/railway.ts` like the other
  services.
- **One bucket** that celld qualifies: Cloudflare R2, Amazon S3 or Tigris. It must pass
  `celld diagnose` (conditional writes) before first use.
- **The cell's code** deploys with `celld deploy apps/memory --bucket …` from a push that touches
  `apps/memory`. Nodes take a new version without a restart.

## Order of work

1. Contracts: `Note` with `sources` and `version`, `NoteConflict`.
2. `apps/memory`: the `Memory` class and its Worker, tested against `celld dev`.
3. `MemoryCells` in the server; the note tools move behind `/api/rpc`.
4. Railway: the two services and the bucket; the proof above re-run there.
5. Dreaming.
6. A one-off copy of every Person's AgentFS notes into their cell.
7. Delete AgentFS, `VIVID_MEMORY_DIR` and the runtime's notes volume.

## Open decisions

- **The bucket provider.** R2 is what celld's release tests run against.
- **Runtime placement** is changing in another thread (Pi Durable). This design does not depend on
  it: the runtime only calls the server.
