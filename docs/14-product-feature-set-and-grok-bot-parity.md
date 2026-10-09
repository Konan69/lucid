# Product feature set and Grok Bot parity

What Vivid can do today, how each claim was checked, and what is not built. "Parity" is a
directional product target, not a claim that Vivid and Grok Bot are equivalent. Keep this page
true: change a row in the same change that changes the fact, and write how it was checked.

Last brought up to date on 3 October 2026.

## How a row is checked

- **Seen in the app with a real model**: a Person's message in the web app, answered by the model
  through the gateway, with the tools Vivid actually called read from the Thread.
- **Live test**: a `.live.test.ts` run against the real service (Executor, HelixDB, Boat, the
  model gateway), skipped unless its suite-specific test configuration and credentials are present.
- **Rehearsed**: driven in the app with the scripted model (`VIVID_MODEL=rehearsal/script`), which
  calls the real tools with fixed inputs. It proves the tools, the cards and the plumbing, and
  says nothing about the model's judgement.
- **Tests**: checked-in unit and integration suites; persistence checks use disposable PostgreSQL.
- **Run for real**: launched and driven as a Person would, with captures.

## Working

| Capability                                                                                                                                      | How it was checked                                                |
| ----------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Vivid answers in a Thread, streaming, with send-while-working and stop                                                                          | Seen in the app with a real model                                 |
| Personal space and Companies in one product: Memberships, roles, shared and private Threads, attributed messages, presence                      | Tests; seen in the app                                            |
| Reading a web page (`read_page`), refused for anything not on the public internet                                                               | Seen in the app with a real model                                 |
| Programs Vivid writes (`run_code`), interpreted on a server thread with memory, work and time limits; each call checked as the Person           | Tests with the real interpreter; a live run from a Thread         |
| Cards in a Thread (`show`): table, charts, steps, options, comparison, links, facts, draft, schedule, form, pictures                            | Rehearsed for every kind; charts seen with a real model           |
| Questions Vivid cannot answer alone (Input requests), answered from a card                                                                      | Seen in the app with a real model                                 |
| Routines once at a time, on a schedule, by webhook, and on an Integration's events (by polling)                                                 | Tests                                                             |
| The trust loop: allowed, needs an Approval, or blocked by a rule; the approved action runs later from the stored copy                           | Tests                                                             |
| Integrations on Executor: the catalogue, signing in or entering a key, finding and using tools                                                  | Live test for the catalogue and reads; seen in the app for search |
| Adding an Integration by address: an MCP server, or an OpenAPI document Executor can import                                                     | Live test                                                         |
| Memory on HelixDB: remember, recall, forget, correct, and the background pass after a Run                                                       | Live test; remember and recall seen in the app with a real model  |
| The Computer on Boat: create, viewer, look, open/read a page, click a link, type/replace/clear a field with readback, files, archive and resume | Live test against real Boat                                       |
| The Library: folders, PDF and text ingest, search, citations                                                                                    | Tests                                                             |
| Skills: 23 native runtime folders, and reusable procedures Vivid saves for itself                                                               | Native catalogue, activation and scoped saved-procedure tests     |
| Search palette, notifications, Settings, the Company record                                                                                     | Tests; seen in the app                                            |
| Desktop app: choose a Vivid, sign up, pages beside a Thread with tabs, the Computer tab, switching Vivid                                        | Run for real                                                      |
| Pictures attached to a message in a private Thread                                                                                              | Tests                                                             |

## Built, not yet seen working end to end

- **App push**: session-owned Web Push and Expo targets, owner-scoped setup RPCs, Notification
  delivery when away, durable send claims, provider timeouts and gone-target removal. Disposable
  PostgreSQL handler tests and controlled provider HTTP tests pass. Clients still need permission,
  service-worker/native registration and tap handling; real VAPID/device delivery is unverified.
- **Attention**: `notify_person`, the opt-in “Watch what needs me” Routine template and its built-in
  mail/calendar procedure. Standing checks complete silently; actionable findings can open private
  follow-up Threads through ordinary Run admission. Real-model judgement has not been evaluated.

The push lane's isolated checkout passed 104 distinct focused tests across registration, delivery,
provider HTTP, model tools, native skill mounting, Routine opt-in and existing Thread/Routine seams.
The repository gate passed package policy, version lockstep, Effect boundaries and migration
integrity, then stopped on the existing Tailwind class-order warning at
`apps/web/src/screen/Notifications.tsx:165`. The frontend owner must correct that order; this lane
made no frontend changes.
Server and runtime leaf typechecks passed under the shared compiler lock in the isolated checkout.

- **Artifacts**: Thread-owned Markdown documents, immutable versions, optimistic Person revisions,
  live RPC queries and runtime write/read tools. Private-Thread rehearsal proved writing version 1,
  revising to version 2, reading it and leaving an identical rewrite unchanged. Runtime reads keep
  up to 48,000 body characters and explicitly identify longer, cut documents with their full count.
  Missing: web, mobile and desktop lists, readers, revision history, editing and removal surfaces.
  Attribution refuses ambiguous working Runs: the current reservation still permits same-Person
  deliveries to join.

| Capability                                                     | What is missing                                                                                                                                                                                                                    |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The Computer panel showing Boat's viewer inside the app        | Never opened in the app against real Boat                                                                                                                                                                                          |
| Browser input from a Thread on Boat                            | `computers/thread.live.test.ts` attempted once; stopped before a model call because the night server selects Docker. Successful tool receipts now include the cookie-bound screen relay; Thread-driven Boat input remains unproved |
| The Person's desktop browser                                   | Target/access/control contracts and PostgreSQL device receipts built; native input-token enforcement is unrecovered, Person route fails closed, runtime option withheld                                                            |
| Vivid using the desktop (`use_desktop`) from a Thread          | Included in the same opt-in Computer chain proof; blocked on the Boat server configuration, never reached a model call                                                                                                             |
| Mobile app                                                     | Tests only; never run on a device                                                                                                                                                                                                  |
| Google Integrations                                            | Need an operator sign-in client set up in Executor (`docs/22-one-product.md`)                                                                                                                                                      |
| An Approval raised by a real model's action, approved, and run | `approvals/thread.live.test.ts` attempted once; stopped before a model call because the running stack and supplied disposable proof database differ                                                                                |
| Routines firing from a real Integration event                  | `routines/thread.live.test.ts` attempted once; the same database isolation preflight blocked it. The fixture uses a real Executor record service; no third-party event proof yet                                                   |

The unconnected mail chain also has `connections/thread.live.test.ts`, skipped by default. Its
single attempt stopped at the database preflight before a model call; Google setup and consent
remain operator prerequisites. The `connect` tool now ends an unconnected offer's turn instead
of leaving the model to keep discovering. Focused runtime tests checked the card receipt,
termination and Computer session metadata (21 tests passed). No row above was promoted to
working end to end. Flue `defineTool` still shares Approval card handles with model-visible
output; strict identifier isolation needs native content/details registration in the runtime
instruction owner's lane.

Run these proofs serially with the existing stack, from the server package, using
`pnpm exec vitest run --config src/runtime/vitest.ts` and exactly one of
`VIVID_LIVE_THREAD_COMPUTER`, `VIVID_LIVE_THREAD_APPROVAL`, `VIVID_LIVE_THREAD_CONNECTION`,
`VIVID_LIVE_THREAD_ROUTINE`, `VIVID_LIVE_THREAD_PROGRAM`, or `VIVID_LIVE_FIRST_CONVERSATION` set
to `1`. Each corresponding
`thread.live.test.ts` (and `threads/first.live.test.ts`, the first Thread) has one scenario;
no judge or retry loop calls the model. The supplied `VIVID_TEST_DATABASE_URL` must designate the
same disposable database as the stack; the proof never falls back to an application database.

## Not built

- **The durable work log** of a Run (requests, responses, tool calls, model and timing).
- **Vivid-to-Vivid** across People and Companies (`docs/06-communication.md`).
- **The Person's own computer as a device**, and taking over the Computer to teach a task.
- **Voice** and **messaging channels** (mail in, Slack and the like); Telegram was cancelled.
- **To-do lists and project management.** Tasks as Vivid first had them (things Vivid tracked and
  chased) were removed on 3 October 2026. They come back in two different shapes, neither built:
  for a Person, a to-do list that is theirs: things they mean to do, which Vivid can add to, tick
  off and remind about; for a Company or team, product and project management: work that has an
  owner, a state and a place in a Project, seen by everyone on it. Until then a reminder is a
  one-off Routine.
- **Billing and usage limits.**
- **Apps on the Computer and a home screen.** The Computer image carries a browser and the desktop
  stack only. There is no office suite, no creative or engineering apps, and no launcher showing
  what is installed (#4).
- **Files as Artifacts.** Vivid cannot hand a file built on the Computer to the Person as an
  Artifact, so a document is Markdown through the document tools, never a Word file (#5).
- **Spreadsheet, presentation and PDF procedures.** The reference procedures build real files and
  check them by rendering; they wait on the two gaps above (#6).
- **Parallel workers for wide research.** The same lookup runs over each input in batches inside
  one Run (#8).
- **Booking by phone, and a map for places.** Both paths exist in the reference procedures and were
  left out; Vivid has no calling and no map display (#10).

## Known limits

- An empty completion from the model is not caught: Vivid has no retry layer of its own, the
  gateway fails over between providers and Flue retries transient errors.
- Pictures in a reply load automatically, so a page Vivid read could have it show a picture whose
  address carries Thread content elsewhere. Loading on tap or through the server would close it.
- Adding by address depends on the operator running Executor with public-only egress.
- Forgetting cannot change or remove a Routine: no tool does it, so Vivid names the Routine and the
  Person changes it (#7).
- Installation, revision history and imported provenance persistence remain outside #12 phase 1.
  All 22 built-ins always mount through Flue’s native catalogue and `activate_skill`. Vivid saves
  and reuses verified procedures itself; People never see, name, edit or manage skills. Built-in
  names are reserved and saved procedures never replace them. Saved Person/Company procedures
  keep the authorized `read_skill` path because native catalogue snapshots persist in shared Thread
  history. Unavailable saved summaries are explicit in model context and leave built-ins mounted.
- Ten built-in procedures (3 October 2026) were adapted from a third party's partial snapshot of
  Muse's shipped skill files, not from a source its maker published. The supporting reference
  files those skills point to were not in the snapshot, so only steps stated in the skill bodies
  were used. External skill collections were not surveyed as a source (#9).

## Grok Bot parity map

| Grok Bot capability                          | Vivid today                                                                                                                    |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Persistent conversation and background state | Working                                                                                                                        |
| Browser, terminal and filesystem computer    | Working at the Boat provider, including browser input; app viewer and Thread-driven input unproven                             |
| The Person's own browser                     | Preparatory server channel tested with a fake device; native control and scoped access are blocked, no model tool option ships |
| Connectors and MCP services                  | Working through Executor; add by address working                                                                               |
| Approval before sensitive actions            | Working in tests; not yet seen with a real model                                                                               |
| Reusable skills                              | Working                                                                                                                        |
| Scheduled and event-triggered routines       | Working in tests; events by polling                                                                                            |
| Multiple agents collaborating                | Not built                                                                                                                      |
| Files, links, images and richer input        | Pictures and the Library working; Artifact backend built, surfaces missing                                                     |
| Activity transcript and action visibility    | Step lines and the Company record working; the per-Run work log not built                                                      |
| Sharing and organization controls            | Working                                                                                                                        |
