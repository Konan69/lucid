# @vivid/durable

Pi Durable conversations exposed as AI SDK chat streams. The Promise and Effect APIs share one implementation. Pi owns submissions, tasks, transcript storage and recovery; this package translates their state into messages, approvals and person-supplied tool results.

## Install and entries

The package is private to this workspace. Use Node 22.19 or newer on the server and the pinned peers: Pi Durable, Pi AI and Chord 1.0.4, Effect 4.0.0-rc.116, and AI SDK 7.0.127.

```sh
pnpm add @vivid/durable@workspace:* ai@7.0.127
```

| Import                    | API                                                                                                                      |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `@vivid/durable`          | Promises, platform `ReadableStream`s, tagged error classes and public types.                                             |
| `@vivid/durable/core`     | Effects, Options, Effect Streams and Schema contracts.                                                                   |
| `@vivid/durable/client`   | Browser/RN-compatible `resumable`, `ConnectionLost` and the reserved interruption marker; no Effect, Pi or Node imports. |
| `@vivid/durable/postgres` | Pi's Storage interface over a host-owned `pg` Pool; `pg` is an optional peer.                                            |

`pnpm build` emits JavaScript and declarations for all four entries. `pnpm check:package` packs the actual artifact, checks its imports with native and classic TypeScript under bundler and NodeNext resolution, and streams through it.

## Server

The host opens its Harness, installs tool extensions, and authorizes the conversation. Given those inputs, the chat boundary is ten lines:

```ts
import type { Context } from '@earendil-works/chord'
import type { ConversationId, Harness } from '@earendil-works/pi-durable'
import { respond } from '@vivid/durable'

export const chat = (
  harness: Harness,
  id: ConversationId,
  request: Request,
  context: Context,
): Promise<Response> => respond(harness, id, request, context)
```

POST decodes the newest user input or assistant tool settlements; the client's historical transcript is not trusted or persisted. Bodyless GET attaches to the run in progress, or returns 204 when idle. Other methods return 405. `decodeTurn(body)` and `respondTurn(harness, id, turn, context)` support hosts that decode their own ingress; the core accepts decoded `ChatTurn` values.

The complete [Promise handler](src/examples/main.ts) and [Effect handler](src/examples/effect.ts) add history, waiting, decide, answer and abort routes. They map malformed turns, unsupported parts, invalid hold ids and history inputs to 400; stale holds/runs, busy rejection, withdrawn input and conflicting retries to 409; missing conversations to 404; and oversized image parts to 413. Invalid host limits/policies are configuration failures, not client refusals. Failures after headers become SDK error chunks; unexpected failures still reject.

Observation opens before admission. Cancelling a reader detaches its watch and never aborts Pi's work. Replacement snapshots fail with `WatchOverflowed`; cancelled or closed watches fail with `WatchClosed`.

## Client and reconnect

Wrap the transport in `resumable`. After `ConnectionLost`, call `resumeStream()`. After a long gap load `history` first, because resume can only bring the run in progress.

```ts
import { DefaultChatTransport } from 'ai'
import { ConnectionLost, closeInputs, resumable } from '@vivid/durable/client'

const transport = resumable(new DefaultChatTransport({ api: '/chat' }))
// Pass transport to the host's Chat or useChat. On a ConnectionLost error:
if (chat.error instanceof ConnectionLost) await chat.resumeStream()
```

The wrapper works on chunks returned by any `ChatTransport`, including transports that do not use HTTP. At acquisition, only a `TypeError` or `TimeoutError` becomes `ConnectionLost`; HTTP refusals keep their original status text. Once a chunk stream exists, a non-abort reading failure first closes unfinished tool inputs with a reserved local error, then throws the plain `ConnectionLost` Error with the original cause. The SDK therefore discards its private resumable state and whole-run replay replaces the partial message by id. `stop()` and AbortError pass through unchanged. After `stop()`, or when seeding a Chat from messages saved on the client, set `chat.messages = closeInputs(chat.messages)` before `resumeStream()`; this pure helper closes unfinished inputs with the same reserved marker. The local marker is never a tool settlement, even if a stale client posts it back.

Resume only after `ConnectionLost`, not after an HTTP refusal. If a lost POST resumes with no stream, it may not have been admitted: resend its existing user id with `chat.sendMessage({ messageId: user.id, text })`, which joins the same submission or admits it once.

The client uses the SDK's stock `lastAssistantMessageIsCompleteWithApprovalResponses` or `lastAssistantMessageIsCompleteWithToolCalls` predicate for continuation. Approvals use `part.approval.id`; applications do not need to derive hold ids. After reloading, seed the message list from history rather than a retained partial message. Without the wrapper, same-instance resumes can repeat earlier steps. A resume with no stream means load history; after a lost POST, the same-id retry above also determines whether it was admitted. `onToolCall` fires again for every replayed call, so the host must account for replay before executing side effects there.

## Tools

`toolsExtension(name, tools, options)` converts an AI SDK ToolSet into a Pi extension. Server tools have `execute`; tools without it wait for a person's result. JSON Schema is built at registration, and calls are Pi-coerced then validated with the SDK schema, including defaults and transforms. Returned JSON is persisted; absent output becomes `null`. Replay defaults to `unsafe`; opt into `safe` only when repeating an interrupted external side effect is safe.

```ts
const extension = await toolsExtension('payments', tools, {
  context: (scope) => readAuthority(scope),
  approval: { pay: true },
  replay: { pay: 'unsafe' },
  execution: 'parallel',
})
```

Here `tools` and `readAuthority` belong to the host. The context resolver receives `ToolScope { conversationId, taskId, callId, toolName }` once per execution attempt. Promise hosts may return a value or Promise; core hosts return an Effect. Without a resolver, context is the ToolScope itself. A declared `contextSchema` requires a context resolver at registration and validates its value before execution. Resolver or validation failures become named tool errors. SDK execution options carry the real call id, abort signal and resolved context; `messages` is an empty array. SDK sandbox and per-tool timeout options are not supported. Keep secrets out of resolver error messages, which reach the model and transcript.

Approval comes from an own `options.approval[name]` entry, otherwise from the tool's `needsApproval`. Explicit false overrides an enabled SDK policy. Predicates must be pure, synchronous and input-only: they receive the SDK-validated input, but cannot read SDK approval options such as context, messages or toolCallId. Async functions, non-boolean results, thrown exceptions and unavailable options are named failures that block that call without killing the stream or history. A shared decision function serves the hook and active readers. The hook pins its winner with Pi's task memo; recovery reuses the pin, and both reconnect presentation and `waiting()` read it when present. Impure predicates violate the contract and can disagree with live presentation, although waiting still reads the pin. Settled history reads durable decisions and denial reasons rather than today's predicate.

`ToolsOptions.execution` defaults to `parallel` and must equal the host's hidden `HarnessSettings.toolExecution`. Every bridged registration declares its mode. Pi ORs the host setting with tool modes, so explicit parallel cannot override a sequential harness. `sequential: ['slow']` forces rounds containing those tools to run sequentially. If any registered tool is sequential under the declarations, presentation conservatively withholds later generating calls until their tasks or results exist; all-parallel agents keep provider content order. The live document watch supplies queued task allocations, so sequential approvals and mixed held/plain calls work with the stock predicates. Omitting the sequential host declaration is unsupported and can prevent parking; [mode.test.ts](src/conformance/mode.test.ts) demonstrates the ambiguity.

Tool names must be unique across composed extensions. Owner pins block a duplicate when a later bridged hook encounters another extension's pin. A held first hook can prevent later hooks from running, so this check cannot detect every duplicate before the wait; presentation rejects ambiguous names. Pi replaces an earlier extension with the same extension name, which `toolsExtension` cannot detect. Hosts must use unique extension names too.

`toModelOutput` separates the original stored/streamed JSON output from what the model reads. It is computed once per execution attempt and stored, rather than recomputed for every prompt conversion. Supported projections are text, JSON, and content containing text or inline PNG/JPEG/GIF/WebP image data with matching binary signatures. Base64 strings, Uint8Array and ArrayBuffer image data are supported where the SDK shape accepts them. Unsupported projections fail with `ToolOutputFailed`; no remote content is fetched. Tool image output has no built-in size bound.

Async-generator execution is supported. Only the last yielded value is stored, streamed and passed to `toModelOutput`; intermediate values and the iterator's return value are not emitted. Empty iteration yields null. A failure after a yield is a tool error, and interruption requests iterator cleanup.

`dynamicTool` registrations, including MCP tools, produce SDK `dynamic-tool` parts. Registered static and dynamic tools carry titles on their chunks through live observation, reconnect and history. History presents a finished unregistered or renamed tool as `dynamic-tool` without its title; only decided approvals retain stored identity. Approval and answer holds work for both.

Registration refuses provider-defined/executed tools, functional descriptions, deferred discovery, nonempty providerOptions and onInputStart/onInputDelta/onInputAvailable callbacks. Answer-only tools cannot also require approval. `inputExamples` and SDK metadata have no Pi projection. `outputSchema` does not validate local execute results, matching the SDK; persisted outputs must still be JSON-serializable. Supported strict schemas map to Pi's preferred strict mode. Unknown tool names in `approval`, `answers`, `replay` or `sequential` fail registration.

Tool parts and `waiting().input` contain the model's raw arguments, rather than the SDK-parsed value used for execution and approval.
Tool `errorText` includes Pi's `<harness>\n[error] …\n</harness>` wrapping instead of the bare SDK message.
A denial reaches the model as an error tool result, rather than the SDK's `execution-denied` result.
Invalid arguments become Pi validation errors; tool-call repair and SDK `invalid` parts are not supported.
Argument-rewriting hooks with input-dependent approval are unsupported: Pi's public hook reads do not expose the original model call needed to compare decisions.

Tool arguments emit one `tool-input-start`, raw JSON growth as `tool-input-delta`, and final `tool-input-available` only at `message_end`; approvals cannot precede that final input. Parsed-only partials and grammar/custom input produce no synthesized JSON deltas. If raw text stops extending the sent prefix, further deltas stop until the final input arrives. Removed or shortened calls rebuild the current step with reset-step. Reconnect emits the captured raw prefix once and then new suffixes. Anonymous identity barriers and sequential withholding preserve the same rules for starts and deltas. Aborted inputs end with `tool-input-error` rather than becoming approvable.

## People in the loop

`waiting(harness, id, context)` returns `{ holdId, callId, toolName, input, kind }` rows. `decide` accepts `{ holdId, approved, reason? }`; `answer` accepts `{ holdId, output }`. Both return the durable settlement. Promise hosts can validate an opaque wire id with `holdId(text)`, which throws `HoldIdInvalid` on malformed input. Wrong-kind or never-waiting tasks fail `CallNotWaiting`. A denial without a reason stores and shows the default text "The person denied this call".

Hold identity is the Pi tool task, not a provider call id. First settlement wins for that task; approvals remain safe against retries, another tab and reused provider ids. Duplicate call ids in one tool round are blocked before execution, omitted from waiting and never request approval. A parked HTTP stream finishes while Pi's run remains alive. Decisions work with no reader and survive process restart.

Client tools use `chat.addToolOutput`, including `{ state: 'output-error', errorText }`. A real error settles the waiting answer call as an error the model reads; repeats are no-ops. An error whose text exactly equals the reserved connection-lost marker is ignored even when it is a real client error, and the call stays waiting. Resume settlement first checks the assistant run id, then matches client outputs by call id, so provider ids must be unique within a run for client-supplied outputs. Approvals are task-scoped and do not have that limitation.

`answers: { ask: 'later' }` lets the model finish while a question stays answerable. A late answer reserves its output before submitting a follow-up and remains tracked until placement. Queued/placed repeats cannot change the chosen output. If abort withdraws the follow-up, waiting lists the question again and the next answer wins under a fresh delivery-attempt key.

`abort(harness, id, context)` explicitly interrupts ordinary conversation work and withdraws queued inputs. A closed run never ends with a step containing tool parts: live, history and terminal replay append one empty closing step when needed, keeping both stock automatic-send predicates false. Stale closed-run settlements restore durable terminal results without executing anything.

## History, identity and metadata

`history(harness, id, { limit, before? }, context)` returns oldest-first UI messages and an optional opaque next cursor. Limits count messages and pages never split an assistant stretch. It reads raw fork-aware entries, including history removed from model context by compaction. Invalid, foreign or interior cursors fail `HistoryCursorInvalid`; non-positive, fractional or non-finite page sizes fail `HistoryPageInvalid`. One shared desk reads plans, holds and unresolved task provenance per page. The core takes and returns Options for cursor absence.

During a run, history includes placed user inputs before its first assistant entry; GET reconnect supplies the assistant and tool results. A steer placed after assistant entries stays out until settlement because reconnect cannot show it in order. System/reset/compaction/application entries are skipped. Late-answer entries are ordinary user messages without answerTo metadata.

There is not yet one assistant id shared by live and settled history. Live and reconnect use `run:<first submission id>`; history uses `entry:<first assistant entry id>`, and user ids use `entry:<user entry id>`. The public `Harness.submission(id)` reads settled receipts too. What Pi lacks is a read from an entry to its submission; receipt scanning is exposed only on Storage, and Harness inspection excludes settled receipts. Raw entries cannot distinguish an onYield continuation inside a run from a queued successor starting another: both have the preceding generation task and the same user payload. [runs.test.ts](src/conformance/runs.test.ts) proves this boundary ambiguity. The upstream ID-parity case remains an expected failure pending an authorized durable run index. No id in the live list equals an id in history, including user messages. Replace the list with a history page; never merge by id. A steer or an `onYield` continuation remains one assistant message while streaming but splits into several assistants around user entries after reload. An `onYield` user entry is the hook’s own text, not text a Person wrote.

Assistant `messageMetadata` carries recorded provider/model identities and summed token usage on start/finish chunks and in history, including failed response attempts without double-counting replayed entries. Live usage is summed over the whole run, while history splits that usage at steer/user boundaries. The Promise entry exports the Metadata type; core exports its Schema too. Optional provider token breakdowns are retained when reported. Pi's entries and run records contain no creation/start/end time, so no lifecycle timestamps are invented.

A failed model run ends live and in stored replay with the same SDK error chunk. Its last assistant history message carries the terminal failure text as optional `metadata.failure`; core state keeps absence as an `Option`. A failed steer retains the first-input identity when the original snapshot or `run_end.inputs` proves its membership. After that watch is gone, an unanswered receipt has no shared answer entry to prove membership, so a restarted follower keeps its own input identity.

## Busy input and retries

Per-turn options accept `whenBusy: 'followUp' | 'steer' | 'reject'`. Pi's public default remains followUp (`harness/submissions.js:149`). Steer joins the current run at its next tool boundary; followUp starts a successor; reject fails before admission with `TurnBusy` and HTTP 409. Busy policy and decoded image limits are validated before admission.

A new input is refused with `TurnWaiting` (409), before admission, when every active call waits for a decision or wait-form answer and nothing is generating or executing. An input already queued is withdrawn if the run in front parks. Decide or answer first, or deny with the refusal text as the reason, then send. A refused user message remains last in `Chat`, preventing both stock predicates from sending an approval: remove that refused message before resolving the held call. Unchanged retries of an already admitted input still observe their own run.

Admission waits for the input's own placement or settlement, not only run_start. If the preceding run ends with this input still queued, admission withdraws it. A never-placed withdrawn input fails `TurnWithdrawn` and HTTP 409 on its original POST and subsequent retries; use a new message id to submit it again. A request id names immutable ordered input content, including images and filenames. An unchanged retry joins the same submission; changed content fails `TurnConflict` and HTTP 409 without replacing it. SDK regenerate-message is refused with `TurnRegenerate` and HTTP 400.

Admission precedes the HTTP response: a queued POST sends no status or bytes until placement. Behind a proxy with a time-to-first-byte limit, use `whenBusy: 'reject'` or expect the proxy’s own error when the run in front lasts too long.

## Following host-admitted input

A host that calls Pi's `Conversation.submit` itself can use `followRun(harness, id, requestId, context)` without a client message. It waits while that submission is queued, follows its own run while active, or streams its stored outcome when ended. It never follows a different run now in progress. The one-shot stream already has its watch open, and reader cancellation only detaches. Unknown request ids fail `RunMissing`; withdrawn inputs fail `TurnWithdrawn`. If the predecessor ends while the input is still queued, `TurnStranded` explains that Pi places it with the next submission; following again then works. A host may queue behind a parked run: its follower stays open and never withdraws anything. Independent readers and reopening with `harness.resume()` use the same durable identity.

## PostgreSQL storage

Install the optional pinned driver:

```sh
pnpm add pg@8.23.0
```

Pass a host-owned Pool and required schema identifier to `openPgStorage(pool, schema)`, then supply the result to the Pi Harness:

```ts
import { openPgStorage } from '@vivid/durable/postgres'

const storage = await openPgStorage(pool, 'durable')
```

PostgreSQL 16 or newer is required; the adapter is tested against PostgreSQL 18. Records stay JSON text. The leased connection must use UTF8; both standard_conforming_strings modes work without silently changing host settings. Raw NUL in SQL text is refused with RawNul, while JSON-escaped NUL and binary zero bytes round-trip. Closing storage releases its lease and does not end the host Pool.

One connection owns a schema at a time, enforced by a nonblocking session advisory lock acquired before migrations. A competing opener receives StorageOwned. Ownership is released on close or backend/process death; reopen after the previous owner closes. Initialization failure destroys the lease. Migrations are transactional and reject newer unsupported schema versions.

The [round-trip report](src/postgres/bench/report.md) counts actual driver calls on local PostgreSQL 18; these are not throughput guarantees:

| Workload                                             | Driver calls |
| ---------------------------------------------------- | -----------: |
| Commit one entry or 100 entries                      |            2 |
| Commit a submission plus entry                       |            2 |
| Mixed entry/task/submission/document creation        |            6 |
| Task update plus document revision                   |            8 |
| Read a 100-entry page                                |            2 |
| Read a document, including a 1,024-delta replay tail |            1 |

All 23 upstream Pi Storage conformance cases pass through this adapter. Its 48 database tests use only disposable schemas through VIVID_TEST_DATABASE_URL and skip when that variable is absent.

## Runnable example

From this package:

```sh
pnpm example
```

[serve.ts](src/examples/serve.ts) runs a faux model and SQLite with chat, reconnect, history, waiting, decide, answer and abort routes. POST /chat uses the SDK envelope; GET /chat/:id/stream reconnects. History accepts limit and before query parameters. Send pay for approval, ask for a person-supplied output, or slow/slow steps for interrupted-stream recovery. HOST defaults to loopback and PORT to 8787. DURABLE_DATA selects a retained directory; otherwise startup creates a temporary one. Startup resumes persisted work and shutdown handles SIGINT/SIGTERM. This example is unauthenticated with permissive CORS; it is for isolated development, not exposure to untrusted networks.

## Remaining limits and verification

Settled history preserves provider content order. Every multi-call response of a sequential-capable agent can differ from its live order, even when that particular round is parallel: withheld calls may follow trailing text, giving live text/c1/text/c2 versus history text/c1/c2/text. Pi does not retain per-reader presentation timing after deleting live slots.

User files must be inline base64 PNG/JPEG/GIF/WebP data URLs with matching magic bytes. Remote URLs, SVG, other files, malformed base64 and media mismatches fail PartUnsupported before admission; nothing is fetched or silently dropped. Empty text beside files is omitted. Hosts should set maxPartBytes for decoded image size and bound raw HTTP request bytes before calling respond; there is no default size bound. PartTooLarge carries decoded bytes/limit. Validation scans base64 linearly and decodes only twelve signature bytes.

There is no WebSocket transport or cross-tab notification layer. Node SDK/SQLite/TCP tests establish server and protocol behavior, not React Native transport conformance. Pi's replay policy does not promise exactly-once external side effects. Product authorization, expiry, audit policy and client rendering belong to the host.

Provider-shape tests cover anthropic-messages, openai-completions (late identity/customInput), bedrock-converse-stream, mistral-conversations, openai-responses-shared replacements, and google-generative-ai text signatures. The truncated-input fix is also proven against a real EXPLABS openai-completions run: restoring the old block-closing dispatch exposed `{ account: '' }`; current code passes. Other implementations are wrapper-only. The two live tests remain skipped unless explicitly opted into with credentials supplied for that work; fixtures never read credential stores.

[Upstream coverage](COVERAGE.md) maps 624 source cases: 363 ported, 175 not applicable, 85 owned by durable-core and 1 gap. The four ported upstream files execute 77 cases: 76 pass and the assistant-ID boundary is the one expected failure. This inventory is not a claim that complete unmodified upstream project suites were run.
