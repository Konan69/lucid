# Vivid runtime

A plain Node process on Pi Durable `1.2.0` (`@earendil-works/pi-durable`, `pi-ai`, `chord`). This
package owns conversation transport, durable conversation history, the model adapter, and runtime
lifecycle. Product records, schedulers, authorization, and provider execution belong to
`apps/server`. Runtime tools call that server through the schema-derived `VividRpcClient`; they do
not own product tables or credentials.

## Run

From the repository root, use the Alchemy stack:

```sh
pnpm install
pnpm infra:dev
```

Supply the application credentials described in the root README before starting Alchemy.
The workspace requires Node 24 or newer and pnpm `12.4.2`; this package's own engine floor is
Node `22.19.0`. For an independently started runtime, supply these variables:

| Variable                | Purpose                                                                |
| ----------------------- | ---------------------------------------------------------------------- |
| `DATABASE_URL`          | The product database; its `runtime` schema holds every Person's store. |
| `VIVID_MEMORY_DIR`      | Directory of Vivid's notes.                                            |
| `VIVID_RUNTIME_TOKEN`   | Authority shared only with the application server.                     |
| `VIVID_SERVER_URL`      | Application-server origin for runtime tool calls.                      |
| `OPENCODE_API_KEY`      | OpenCode Go key; the default model answers through it.                 |
| `EXPLABS_API_KEY`       | Experiential Labs gateway key, for an `explabs/<id>` model.            |
| `VIVID_MODEL`           | Optional model selection; defaults to `opencode-go/glm-5.3-flash`.     |
| `VIVID_RUNTIME_IDLE_MS` | Optional; how long an idle Person stays open. Ten minutes by default.  |
| `HOST`, `PORT`          | Optional; `0.0.0.0` and `5173` by default.                             |

```sh
pnpm --filter @vivid/agent-runtime dev
```

The process does not start without the first four. Each Person's conversations are one logical
Pi Durable store in shared tables of the product database (`src/storage/tables.ts`), keyed by
an opaque store id. Root `pnpm db:migrate` creates those tables after the server's; in production the
runtime service's pre-deploy step (`pnpm --filter @vivid/agent-runtime db:migrate`) does. The
process never migrates and refuses to start without them (`MigrationsPending`). One runtime process owns every store: it takes a PostgreSQL advisory lock on a
connection of its own and a new owner generation, and every write checks that generation in its
own transaction. A second process does not start while the lock is held, and a process that
loses its control connection stops so the platform can start a fresh one.

## Server boundary

The server checks Thread access and records the Run before forwarding a typed delivery to
`POST /persons/:personId/threads/:threadId`, where the Person is the Thread's creator. It stops a
Thread with `POST …/abort` and reads how a delivery ended with `GET …/submissions/:id`
(`packages/contracts/src/runtime.ts`). Browsers, phones, and desktop renderers never receive the
runtime token. `src/app.ts` also serves an unauthenticated `/health` response.

The server owns the Library, Watches, Skills, Input requests, Approvals, Artifacts, and memory.
Integrations run through Executor; the Computer's Boat adapter is server-owned and was proven
against real Boat on 3 October 2026. See the domain READMEs and
[current feature status](../../../docs/14-product-feature-set-and-grok-bot-parity.md) for evidence
and remaining limits.

## Live reply reconciliation

The runtime patch in `patches/@flue__runtime@2.2.2.patch` reconciles each settled
assistant response through Flue's existing `message-appended` upsert. Flue 2.2.2 keeps
provider content indexes in canonical records but omits block identity from UI deltas.
Its SDK splits a part whenever text and reasoning alternate. A single provider text block can
therefore appear as several live parts, while distinct blocks must remain distinct.

The first settlement resolving to a response projects only that response with history's own projector,
retaining the first-step message ID, earlier model steps, tool outputs, anchored data, and metadata.
It stops at the response's first entry rather than projecting older replies. Joined deliveries
settle before their host, so the replacement precedes the first joined settlement in its own
batch. Later settlements resolving to that response do not resend it. Model-step completions
keep their original markers and send no replacement for a tracked response.

Each tool output travels in its original chunk and once in the final replacement. Reconciliation
bytes therefore grow with the final response, rather than with the sum of every intermediate
response. An untracked step has no settlement and no accumulated response, so it reconciles
at its own completion. Neither path requests a conversation reset or resends older replies.
During streaming, delta parts still follow Flue's original kind boundaries. A failed step that
Flue never materializes can disappear from final history; this upsert cannot delete a live
ghost when no canonical response remains. Dangling in-progress steps are excluded from the
replacement before joined settlement, matching the later host settlement.
The model recovery
loop also checks cancellation before returning a completed turn, so a provider that closes
normally after an abort cannot turn a stopped partial reply into a completed submission.

Remove this change when Flue carries block identity through live projection or reconciles
settlement upstream. No SDK patch is required. `@flue/react` uses the SDK observer, so web,
phone, desktop, and server observation all consume the same message upsert. The shared `textOf`
in contracts joins canonical text blocks as paragraphs without guessing from reasoning.
`src/stream.test.ts` exercises the public storage, HTTP router, SDK observation, and wire through
SSE and long-poll. It covers both block sequences, tool outputs, joined deliveries, aborted
partial replies, and terminating tools. It checks stable message IDs, one replacement before
the first settlement, no reset, and no older replies resent.

`src/payload.live.test.ts` measures a real twelve-tool-call response through the production
OpenRouter provider and compares live output with history. It requires
`VIVID_LIVE_RECONCILIATION=1`, `OPENROUTER_API_KEY`, and an isolated database supplied through
`VIVID_TEST_DATABASE_URL`. It stays skipped in the ordinary gate.

## Models and rehearsal

`src/providers/opencode.ts` declares OpenCode Go and `src/providers/explabs.ts` the Experiential
Labs gateway. A model must be declared in one of them before `VIVID_MODEL` selects it as
`opencode-go/<id>` or `explabs/<id>`. Vivid has no model retry or fallback layer of its own: the
gateway fails over upstreams, the request budget is the Harness's stream settings, and Pi retries
a failed generation up to three times. A response that is interrupted (a deploy, a restart) is
continued by the next process from its last checkpoint: Pi keeps recorded tool results and never
re-runs those calls, and a tool call the interruption cut short is reported to the model as
interrupted instead of being run again.

`VIVID_MODEL=rehearsal/script` opts into the deterministic rehearsal provider. It calls real
tools with fixed inputs and reports real receipts; it proves plumbing, not model judgement.

## Deployment limits

```sh
pnpm --filter @vivid/agent-runtime start
```

There is no build: the process runs from source with `tsx`, as the application server does. The
checked-in Dockerfile runs that command on port `5173` with a `/health` check. It has not been
built or run since the move to Pi Durable.
