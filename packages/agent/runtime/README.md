# Vivid runtime

The chosen host is one celld Durable Object cell per Person, with a native Pi Durable
`Harness` over that cell's SQLite. [Runtime cells](../../../docs/27-runtime-cells.md) defines
this boundary. celld owns activation, ownership, and idle lifecycle. Pi owns tasks, queues,
deduplication, waiting, abort, and restart.

The integration is transitioning from Pi Durable `1.2.0` to `1.4.0`. The custom PostgreSQL
adapter is being deleted. The cell host, Memory, infrastructure, and verification integration
are in progress and have not been proven through the real product. Existing Node startup,
Docker, and verifier commands do not establish a working cell runtime.

## Persistence and lifecycle

Open Pi's `openDurableObjectSqliteStorage(ctx.storage)` adapter inside the Person cell.
Use Pi's native `onWake` and alarm pattern from its version-matched README. Arm the wake before
starting work, keep it armed while work is active, and call `harness.resume()` on an alarm.
celld supplies the single owner and SQLite durability. Vivid adds no central Persons map,
idle timer, ownership lock, or recovery scheduler.

Memory shares the Person cell's database, separate from Pi's tables. Cell-backed Memory integration and its lifecycle proof remain
required. A shared Thread lives in its creator's cell, but Memory belongs to the acting Person.
Pictures, attachments, and tool image results must survive the host change.

PostgreSQL remains the product database for auth, Company/Membership, Thread metadata, Runs,
Library, and other server records. It is not conversation storage. Runtime storage needs no
`DATABASE_URL` or runtime PostgreSQL migration owner. Product auth and product migrations remain.

## Server boundary

The server checks Thread access and reserves the Run before forwarding a typed delivery to
`POST /persons/:personId/threads/:threadId`, where the Person is the Thread's creator. Tools call
its schema-derived `VividRpcClient`; product authorization, credentials, schedulers, and provider
execution stay on the server. Browsers, phones, and desktop renderers never receive the runtime
token.

`POST …/abort` explicitly stops work. `GET …/submissions/:id` directly awaits native
`submission.wait(context)` and returns only `Done`, `Failed`, or `Stopped`. Cancelling that
request ends only the wait. In-progress state comes from watch/live documents. A cell move
requires the state link to reconnect and read committed state again.

The cell receives server-call authority and model credentials at runtime, never in the client
bundle. Infrastructure configuration belongs to Alchemy. Its cell deployment wiring is still
in progress; this document authorizes no production deploy or live-data change.

## Models and rehearsal

`src/providers/opencode.ts` declares OpenCode Go and `src/providers/explabs.ts` the Experiential
Labs gateway. `VIVID_MODEL` selects a declared model; the current default is
`opencode-go/glm-5.3-flash`. Vivid adds no model retry or fallback layer. Pi handles generation
retries and continuation from its durable tasks.

`VIVID_MODEL=rehearsal/script` opts into the deterministic rehearsal provider. It calls real
tools with fixed inputs and reports real receipts. It proves plumbing, not model judgement.

## Required proof

Runtime behavior tests must use native first-party persistent storage. Cell-backed product
verification must drive the server gateway, Memory, pictures, abort, terminal waiting, and
reconnect after ownership moves on a disposable devbox stack. The existing verifier still
launches the old Node host and runtime migration command. Until its cell integration lands,
report these journeys as blocked rather than verified.
