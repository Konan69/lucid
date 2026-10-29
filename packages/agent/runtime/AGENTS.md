# Vivid conversation runtime

This package runs Vivid's conversations with Pi Durable. The chosen host is one celld Person
cell with Pi's native Durable Object SQLite storage. [Runtime cells](../../../docs/27-runtime-cells.md)
is authoritative. celld owns activation, ownership, and idle lifecycle. Pi owns tasks, queues,
deduplication, wait, abort, and restart. Product state and authorization remain in `apps/server`;
runtime tools call it through the schema-derived `VividRpcClient`.

The existing integration is Pi Durable 1.2.0; the cell host targets 1.4.0. The custom PostgreSQL
adapter is being deleted. Cell hosting, Memory, infrastructure wiring, and real product verification
are in progress, not proven. Preserve pictures, Memory, and acting authority through that work.

Read the installed packages before changing anything that touches Pi
(`node_modules/@earendil-works/*/dist`), and the installed README for the same version. Never assume its API from memory; it is experimental and changes between releases.

## Layout

- Host integration is moving to the Person cell. Open `Harness` over
  `openDurableObjectSqliteStorage(ctx.storage)` and use Pi 1.4.0's README `onWake`/alarm pattern.
  Arm wake before starting work and resume on alarms. celld owns eviction and ownership.
- `src/app.ts`: the HTTP routes (`packages/contracts/src/runtime.ts` documents the contract).
- `src/person.ts`: Vivid's definition, tools, and the bridge from Pi's callbacks into Effect.
- `src/threads.ts`: one Pi conversation per Thread, and the documents that relate the two.
- `src/admission.ts`: admitting one delivery exactly once.
- `src/delivery.ts`: a delivery as the model reads it and as Pi places it; the delivery scope
  recorded at admission and recovered from the server after a restart.
- `src/deliveries.ts`: what is kept beside a delivery while it can be answered, including the
  context frozen for its response.
- `src/authority.ts`: whom a tool call acts for.
- `src/context.ts`: what Vivid is told at the start of a response: the Person's memory brief, the
  skills it can use, their time zone.
- `src/agents/vivid.ts`: Vivid's definition: the instruction text, the two prompt sections and the
  order tools are offered in.
- `src/skills.ts`, `src/frontmatter.ts`: the built-in skills: the catalogue section and
  `activate_skill`.
- `src/response.ts`: a response's metadata entry, which submission answered which, and the
  settlement read.
- `src/settled.ts`: what follows every settlement: releasing kept records, recording metadata.
- `src/models.ts`, `src/providers/`: the model collection and the selected model.
- `src/client.ts`: who Vivid is acting for (`Acting`) and the product client (`Product`).
- `src/tools/`: model tools. Each is a thin, typed call to `VividRpc`; they do not own server
  stores, schedulers, credentials, or product routes, and they never decide whether an action is
  allowed.
- `src/state/project.ts`: the pure projection of a conversation (Pi's entries and its `pi.live`
  and `pi.inbox` documents) into the state the screens read (`ConversationState`).
- `src/state/link.ts`: the state link: the whole state, then the changes between projections
  (`@earendil-works/chord/delta`), for as long as somebody reads; and the one-off read.
- `src/state/pictures.ts`: the bytes of a picture a Person sent.
- Runtime tests are transitioning to native first-party persistent storage. Product database
  fixtures still use only disposable PostgreSQL through `VIVID_TEST_DATABASE_URL`.

## Verification during the host change

Use the installed Pi README and source for the selected version. celld's `examples/pi` uses
another `agents/harness` SDK; it is a host-binding reference, not a replacement for pi-durable.
The current verifier starts the old Node entry and invokes a runtime PG migration command.
Cell-backed journeys are blocked until the launcher and recipes use the real cell host. Require
proof on a disposable devbox, including wake, abort, terminal wait, Memory, pictures, and reconnect
across an owner move. A PG-adapter test or rehearsal does not prove those claims.

## Runtime contract

- The application server is the only caller. It holds the runtime token and forwards a Person's
  message, or delivers a signal, to `POST /persons/:personId/threads/:threadId` after checking who
  they are and that they may see the Thread. The Person in the path is the Thread's creator.
- One Person, one cell, one native SQLite store, one Harness. PostgreSQL holds only product
  records, including auth, Company/Membership, Thread metadata, Runs, and Library. Runtime
  persistence has no `DATABASE_URL` requirement or PostgreSQL migration owner.
- Use celld's ownership and idle lifecycle and Pi's native scheduling and failure protocols.
  Keep required follow-up work in native durable tasks. Do not recreate them with central maps,
  ownership fences, idle timers, or in-memory recovery queues.
- `GET …/submissions/:id` awaits native `submission.wait(context)` directly. Its wire result is
  terminal only (`Done`, `Failed`, `Stopped`). Request cancellation ends only that wait.
  In-progress state comes from watch/live documents. Reconnect a state link after a cell move.
- A delivery's Pi request id is its idempotency key under the prefix `delivery:`, so it cannot
  equal a request id the runtime gives its own writes. A delivery that arrives during a response
  joins it after the current round of tools (`whenBusy: 'steer'`), together with every other one
  that arrived meanwhile (`steeringMode: 'all'`). Use Pi's native inbox and task protocols for
  placement and continuation after failure or restart.
- The model is asked to think at `medium`, main's level; Pi's default is `off`.
- A failed response leaves the runtime as a closed category and an HTTP status number
  (`failure.ts`). The provider's or Pi's failure text never crosses the HTTP surface.
- Delivery authority arrives as typed server metadata, outside the model-visible message. A signal
  carries a speaker name and turn number; `delivery.ts` caches its acting scope and recovers an
  evicted scope from the server's persisted Run. A plain user turn happens only in a private
  Thread, whose creator is recorded when its conversation is created. A tool acts for the Person
  behind the newest delivery its response has placed (`authority.ts`), and the server checks that
  Person's access again.
- The context for a response is read once, before its delivery is submitted, kept in the
  conversation beside the delivery, and released when the delivery settles. The instruction must
  stay byte-identical across the requests of one response: Pi writes a `pi.system` entry into the
  transcript whenever a section's text changes. A section that reads a clock or anything live
  breaks that.
- Entries and documents of our own are named `vivid.*`: the entries `vivid.signal` (a placed
  signal: type, attributes, body, and the sending client's key when a client sent it),
  `vivid.message` (a Person's own words sent with a client's key; without one they are Pi's
  `pi.user`), `vivid.response` (a response's outcome, deliveries, model,
  times, tool count and usage), `vivid.run` (a run's deliveries, written while it runs, so a
  screen groups a reply the same way during and after) and `vivid.placed` (the write that placed
  waiting deliveries); the documents `vivid.thread`, `vivid.conversation`, `vivid.delivery`, `vivid.answered`.
  These kinds are persisted names. Preserve their meaning and stored content through the host change.
- Product calls use the generated `/api/rpc` contract through `VividRpcClient`.
- The default model is `opencode-go/glm-5.3-flash`, served by OpenCode Go
  (`src/providers/opencode.ts`, key `OPENCODE_API_KEY`). OpenRouter is also
  declared (`src/providers/openrouter.ts`, key `OPENROUTER_API_KEY`). `VIVID_MODEL` may select another
  model those files declare. Do not add a retry, fallback or stream-wrapping layer around the
  provider: the request budget is the Harness's `settings.stream` (`providers/budget.ts`) and
  generation retries are Pi's.
- Pictures belong to private Threads, whose deliveries are ordinary user inputs with image
  content. Shared Threads use attributed signals, which carry words only; the gateway refuses
  shared pictures before reserving a Run.

## Known limits

These limits describe the pre-cell integration. They have not been re-proven in the cell host.
Use them to preserve observable behavior while moving required work into Pi's native tasks;
they are not instructions to build a separate recovery framework.

- **A response's follow-up writes are not durable** (`settled.ts` runs them just after the
  settling commit, from memory): releasing each delivery's `vivid.delivery` record, which holds
  the context frozen for it, and writing the response's `vivid.response` entry. A process killed
  before the release leaves the record in the store and loses the entry; killed after the
  release and before the entry, it loses only the entry. An orderly stop narrows this and does
  not close it: closing a Person finishes the writes already set off, but a response that settles
  after that point and before Pi stops taking commits is not followed. What a lost
  `vivid.response` entry costs a screen is the reply's times and nothing else: how the reply
  ended is read from Pi's own submission records. No later response reads a leftover record.
- **One delivery's context can be read more than once.** Two attempts with one key that arrive
  together may both find nothing kept and both read context; the first to keep it wins and the
  other's is discarded. Keeping the context and submitting the delivery are two commits, so the
  attempt whose context is kept need not be the one whose submission Pi admits.
- **A process killed between keeping a delivery's context and submitting it** leaves a kept
  record no submission names. A retry with the same key uses that context; if the server never
  retries, the record stays.
- **`repeated` on an admission receipt** is true when the key was already admitted at the moment
  the runtime looked, which is after it found the Thread's conversation. Two first attempts sent
  close together are one delivery and may both say false, or one may say true. The submission id
  is what identifies the delivery.
- **Every state read costs the whole transcript once, per reader.** A link, and each one-off
  read of a Thread's state, reads every entry of the conversation when it starts, because Pi's
  view carries only the entries after the newest reset or compaction and what was said before
  that must stay readable. After that a link reads only the entries written since. There is no
  paging, no cap and no sharing between readers: each link holds its own copy of the entries
  (pictures included) in memory until its reader goes away, and holds the Person's conversations
  open for as long. Remembering unchanged replies saves rebuilding them; it bounds nothing.
- **A reply's times are known late, and after a kill never.** `metadata` comes from the
  `vivid.response` entry, written just after the settling commit. Everything else about how a
  reply ended (`settlements`, the failed or stopped advisory) is read from Pi's submission
  records in the same change that says the reply is over.
- **A delivery can lose its reply for want of a hook.** A run records its deliveries
  (`vivid.run`) before each request to the model; that is the first moment Pi lets the runtime
  write after a delivery has joined, because Pi places joining deliveries inside its own commit
  at the end of a round of tools and offers no hook there or when a run ends. So a delivery that
  joined a run which then ended without asking the model again (a stop, or a failure while
  preparing the next request), and a run that failed before its first request, are not named in
  the transcript until the `vivid.response` entry is. Until then, and for good after a kill in
  that window, such a delivery is drawn as a message of its own with no `submissionId`, is not in
  `settlements`, and a failed one has no advisory.
- **A delivery withdrawn before it was placed** (a stop while it waited) has no entry, so it is
  never listed in `settlements`.
- **A picture in a tool's result cannot be read from the state.** It is drawn as `{ type:
'image', mimeType }` with no address. Its bytes are still in the transcript, inside the tool
  result, and reach only the model. No screen draws one today.

The opt-in rehearsal model uses pi’s faux provider to exercise real Vivid tools and display cards without a model provider key. It reconstructs deterministic scenes from conversation context and reports real tool receipts and failures; it is for product rehearsal and is never a default. Set `VIVID_MODEL=rehearsal/script` before starting the runtime to register it, then send a supported phrase such as “show a table” or “run a program”; an unrecognized message lists all phrases.
