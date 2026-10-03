# Product feature set and Grok Bot parity

What Vivid can do today, how each claim was checked, and what is not built. "Parity" is a
directional product target, not a claim that Vivid and Grok Bot are equivalent. Keep this page
true: change a row in the same change that changes the fact, and write how it was checked.

Last brought up to date on 3 October 2026.

## How a row is checked

- **Seen in the app with a real model**: a Person's message in the web app, answered by the model
  through the gateway, with the tools Vivid actually called read from the Thread.
- **Live test**: a `.live.test.ts` run against the real service (Executor, HelixDB, Boat, the
  model gateway), skipped unless its opt-in flag and credentials are present.
- **Rehearsed**: driven in the app with the scripted model (`VIVID_MODEL=rehearsal/script`), which
  calls the real tools with fixed inputs. It proves the tools, the cards and the plumbing, and
  says nothing about the model's judgement.
- **Tests**: the checked-in suite against a disposable PostgreSQL.
- **Run for real**: launched and driven as a Person would, with captures.

## Working

| Capability                                                                                                                                           | How it was checked                                                |
| ---------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Vivid answers in a Thread, streaming, with send-while-working and stop                                                                               | Seen in the app with a real model                                 |
| Personal space and Companies in one product: Memberships, roles, shared and private Threads, attributed messages, presence                           | Tests; seen in the app                                            |
| Reading a web page (`read_page`), refused for anything not on the public internet                                                                    | Seen in the app with a real model                                 |
| Programs Vivid writes (`run_code`), in an interpreter with no network, a cleared environment and hard memory, CPU and time limits                    | Seen in the app with a real model; tests against the real sandbox |
| Cards in a Thread (`show`): table, charts, steps, options, comparison, links, facts, draft, schedule, form, pictures                                 | Rehearsed for every kind; charts seen with a real model           |
| Questions Vivid cannot answer alone (Input requests), answered from a card                                                                           | Seen in the app with a real model                                 |
| Tasks and follow-ups                                                                                                                                 | Seen in the app with a real model; tests                          |
| Routines on a schedule, by webhook, and on an Integration's events (by polling)                                                                      | Tests                                                             |
| The trust loop: allowed, needs an Approval, or blocked by a rule; the approved action runs later from the stored copy                                | Tests                                                             |
| Integrations on Executor: the catalogue, signing in or entering a key, finding and using tools                                                       | Live test for the catalogue and reads; seen in the app for search |
| Adding an Integration by address: an MCP server, or an OpenAPI document Executor can import                                                          | Live test                                                         |
| Memory on HelixDB: remember, recall, forget, correct, and the background pass after a Run                                                            | Live test; remember and recall seen in the app with a real model  |
| The Computer on Boat: create, viewer, look at the desktop, open a page and read it, write a file, archive, resume the same machine, recover the file | Live test against real Boat                                       |
| The Library: folders, PDF and text ingest, search, citations                                                                                         | Tests                                                             |
| Skills: the ones Vivid ships with, and ones a Person teaches                                                                                         | Tests; seen in the app                                            |
| Search palette, notifications, Settings, the Company record                                                                                          | Tests; seen in the app                                            |
| Desktop app: choose a Vivid, sign up, pages beside a Thread with tabs, the Computer tab, switching Vivid                                             | Run for real                                                      |
| Pictures attached to a message in a private Thread                                                                                                   | Tests                                                             |

## Built, not yet seen working end to end

- **Artifacts**: Thread-owned Markdown documents, immutable versions, optimistic Person revisions,
  live RPC queries and runtime write/read tools. Missing: web, mobile and desktop lists, readers,
  revision history, editing and removal surfaces; these still need an end-to-end rehearsal.

| Capability                                                     | What is missing                                                               |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| The Computer panel showing Boat's viewer inside the app        | Never opened in the app against real Boat                                     |
| Clicking and typing inside the Computer's browser on Boat      | The guest driver refuses it (`browser_input_trust_unavailable`)               |
| Vivid using the desktop (`use_desktop`) from a Thread          | Proven at the provider; not driven from a Thread on Boat                      |
| Mobile app                                                     | Tests only; never run on a device                                             |
| Google Integrations                                            | Need an operator sign-in client set up in Executor (`docs/22-one-product.md`) |
| An Approval raised by a real model's action, approved, and run | Tests only                                                                    |
| Routines firing from a real Integration event                  | Tests only                                                                    |

## Not built

- **The durable work log** of a Run (requests, responses, tool calls, model and timing).
- **Vivid-to-Vivid** across People and Companies (`docs/06-communication.md`).
- **The Person's own computer as a device**, and taking over the Computer to teach a task.
- **Push notifications**, **voice**, and **messaging channels** (mail in, Slack and the like).
- **Billing and usage limits.**

## Known limits

- An empty completion from the model is not caught: Vivid has no retry layer of its own, the
  gateway fails over between providers and Flue retries transient errors.
- Pictures in a reply load automatically, so a page Vivid read could have it show a picture whose
  address carries Thread content elsewhere. Loading on tap or through the server would close it.
- Adding by address depends on the operator running Executor with public-only egress.

## Grok Bot parity map

| Grok Bot capability                          | Vivid today                                                                           |
| -------------------------------------------- | ------------------------------------------------------------------------------------- |
| Persistent conversation and background state | Working                                                                               |
| Browser, terminal and filesystem computer    | Working on Boat for commands, files, looking and opening pages; browser input not yet |
| Connectors and MCP services                  | Working through Executor; add by address working                                      |
| Approval before sensitive actions            | Working in tests; not yet seen with a real model                                      |
| Reusable skills                              | Working                                                                               |
| Scheduled and event-triggered routines       | Working in tests; events by polling                                                   |
| Multiple agents collaborating                | Not built                                                                             |
| Files, links, images and richer input        | Pictures and the Library working; Artifact backend built, surfaces missing            |
| Activity transcript and action visibility    | Step lines and the Company record working; the per-Run work log not built             |
| Sharing and organization controls            | Working                                                                               |
