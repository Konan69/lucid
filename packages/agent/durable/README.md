# @vivid/durable

Durable bridges Pi Durable conversations and AI SDK chat streams. Tools can wait for task-scoped approvals or person-supplied results without keeping an HTTP connection open. The Promise and Effect entry points share one implementation and preserve conversation work across process restarts.

## Install

This package is private to this workspace:

```sh
pnpm add @vivid/durable@workspace:* ai
```

Use `@vivid/durable` for Promises and platform `ReadableStream`s. Use `@vivid/durable/core` for Effects, Options and Effect Streams. Both export the same tagged failures and public value types; the core also exports the Schema contracts. The pinned runtime is Effect 4.0.0-rc.116, Pi Durable 1.0.4 and AI SDK 7.0.127.

The host opens its Pi Harness, registers an extension from `toolsExtension`, and authorizes each conversation before calling these APIs. Tools with an `execute` run on the server; tools without it wait for an answer. Set `approval: { pay: true }` to hold a server tool for approval, or `answers: { ask: 'later' }` to let the model continue while the question remains answerable. Choose safe replay explicitly only for tools whose interrupted side effects can safely repeat.

## Promise server

[Complete, type-checked HTTP handler](src/examples/main.ts). It serves chat POST/GET, GET history/waiting, and POST abort/decide/answer. The handler maps invalid schema, hold-id and history inputs and unsupported user files to 400, stale interactions to 409, and missing conversations to 404; other failures reject. Decision and answer bodies decode once and validate their opaque task ids with the Promise entry's `holdId` before reaching the durable API.

This is the handler excerpt; imports, compiled decoders and the typed status mapper are in the linked source:

```ts
export function route(
  harness: Harness,
  conversationId: ConversationId,
  request: Request,
  context: Context,
): Promise<Response> {
  return dispatch(harness, conversationId, request, context).catch(routeFailure)
}

/** The framework's Promise-only ingress owns body/query reads and delegates durable work. */
async function dispatch(
  harness: Harness,
  conversationId: ConversationId,
  request: Request,
  context: Context,
): Promise<Response> {
  const url = new URL(request.url)
  const path = url.pathname
  // Example host policy only. Bound raw request bytes in middleware before this route as well.
  if (path === '/chat')
    return respond(
      harness,
      conversationId,
      {
        request,
        options: { maxPartBytes: 5 * 1024 * 1024 },
      },
      context,
    )
  if (path === '/history' && request.method === 'GET') {
    const text = url.searchParams.get('limit')
    const limit = text === null ? 50 : await decodeLimit(text)
    const before = url.searchParams.get('before')
    const page = before === null ? { limit } : { limit, before }
    return Response.json(await history(harness, conversationId, page, context))
  }
  if (path === '/waiting' && request.method === 'GET')
    return Response.json(await waiting(harness, conversationId, context))
  if (request.method !== 'POST') return new Response(null, { status: 405 })
  if (path === '/abort') {
    await abort(harness, conversationId, context)
    return new Response(null, { status: 204 })
  }
  if (path === '/decide') {
    const body = await decodeDecision(await request.text())
    const decision = { ...body, holdId: holdId(body.holdId) }
    return Response.json(await decide(harness, conversationId, decision, context))
  }
  if (path === '/answer') {
    const body = await decodeAnswer(await request.text())
    const output = { ...body, holdId: holdId(body.holdId) }
    const delivered = await answer(harness, conversationId, output, context)
    return Response.json(delivered)
  }
  return new Response(null, { status: 404 })
}
```

Chat `respond` accepts a Request; GET reconnects and returns 204 when idle, POST reads and decodes JSON text. Unsupported methods return 405, missing conversations 404, invalid turns and unsupported file parts 400, oversized parts 413, and missing resume runs or reused message ids with different content 409. Other adapter failures reject with the original tagged error class. `decodeTurn` and `respondTurn` support hosts that already decoded an object body. `holdId(text)` validates an opaque hold id received over another wire and throws `HoldIdInvalid` for malformed values, without requiring a core Schema import.

## Effect server

[Complete, type-checked Effect handler](src/examples/effect.ts). Its `post` reads and decodes the body, calls the transport-neutral core `respond`, and converts the stream at the HTTP boundary; `get` attaches or returns 204. The framework runs the returned Effect at its own entry point.

```ts
export function chat(
  harness: Harness,
  conversationId: ConversationId,
  request: Request,
  context: Context,
) {
  const response = Match.value(request.method).pipe(
    Match.when('POST', () => post(harness, conversationId, request, context)),
    Match.when('GET', () => get(harness, conversationId, context)),
    Match.orElse(() =>
      Effect.succeed(new Response(null, { status: 405, headers: { Allow: 'GET, POST' } })),
    ),
  )
  return response.pipe(
    Effect.catchTag('TurnInvalid', (error) =>
      Effect.succeed(new Response(error.message, { status: 400 })),
    ),
    Effect.catchTag('PartUnsupported', () =>
      Effect.succeed(new Response('Unsupported file; use an inline base64 image', { status: 400 })),
    ),
    Effect.catchTag('PartTooLarge', () =>
      Effect.succeed(new Response('File part too large', { status: 413 })),
    ),
    Effect.catchTag('RunMissing', () =>
      Effect.succeed(new Response('No run made these tool calls', { status: 409 })),
    ),
    Effect.catchTag('ConversationMissing', () =>
      Effect.succeed(new Response('Conversation not found', { status: 404 })),
    ),
  )
}
```

The same source exposes typed `actions` for history, abort, waiting, decide and answer. Decode route bodies before calling them. Core `decodeTurn` is a compiled object decoder; `Schema.fromJsonString(TurnBody)` is the corresponding JSON-text ingress. Core `prepareRun` admits input and returns a one-shot stream whose watch is already open.

## Client protocol

Use the stock `useChat` transport, `DefaultChatTransport`, pointing at the authorized chat endpoint. For approval, use `lastAssistantMessageIsCompleteWithApprovalResponses` and echo the tool part's `approval.id` to `addToolApprovalResponse`; that opaque value identifies a durable tool task. For person-supplied tool output, use `lastAssistantMessageIsCompleteWithToolCalls` and `addToolOutput` with the part's tool name and call id. The SDK resubmits the assistant message and continues it in place. The integration suites exercise the real AbstractChat and these stock predicates.

[Complete, type-checked React component](src/examples/client.tsx): stock `useChat`, the loaded history as its first messages, `resume` to rejoin a run in progress, an approval answered from the tool part, and a tool the person answers. The same flows run against the real hook in [`src/react/chat.test.tsx`](src/react/chat.test.tsx). Client `stop()` drops the fetch only. An application that intends to stop durable work calls its authorized abort endpoint too.

User inputs retain ordered text and file parts. Inline base64 PNG, JPEG, GIF and WebP data URLs with matching binary signatures become native Pi image blocks; history restores their file parts, including filenames retained as bridge metadata on the stored image JSON. Pi Durable 1.0.4 accepts text and image content only. Remote URLs (including image URLs), SVG or unknown image types, mismatched magic bytes, non-image files, malformed base64 and mismatched data-URL media types fail `PartUnsupported` before admission; HTTP chat returns 400. This library never fetches a file URL. Core `ChatTurn.Input` has `parts`, and `RunInput.content` accepts either a plain string or ordered `InputPart` values.

The host should set `options.maxPartBytes` to a nonnegative integer decoded-byte limit per image, and also bound HTTP request bytes in middleware before calling `respond`. There is no default image limit. Invalid budgets (including non-numbers, NaN, infinity, negative or fractional values) reject with `LimitInvalid` before reading the body or admitting input; this is a host configuration fault, not a client 4xx. To preserve the repo’s four-parameter rule, bounded ingress uses `respond(harness, id, { request, options: { maxPartBytes } }, context)` or `respondTurn(harness, id, { turn, options: { maxPartBytes } }, context)`; existing bare Request/turn calls remain valid. Core `respond` accepts the same turn/options bundle. `streamRun` and `prepareRun` take `RunInput.options`. Exceeding the decoded size fails `PartTooLarge { bytes, limit }`, mapped to HTTP 413 before observation or admission. Validation scans base64 once and reads at most twelve signature bytes; it never decodes or copies the full binary. Empty text blocks beside files are omitted from Pi content. The server examples choose a 5 MB decoded-image budget as a host policy, not a library default.

## Guarantees

A held call parks the client response with finish-step/finish while Pi's run remains alive. A decision can arrive with no client attached, after a process restart, or more than once: the first settlement for that hold wins. Direct `decide` and `answer` accept the `holdId` returned by `waiting`, and reject wrong-kind or never-waiting holds with `CallNotWaiting`. Unanswered late questions survive unrelated tasks that reuse a provider call id. A late answer reserves its first output before admission and keeps its question and submission receipt until placement. Abort reopens a withdrawn follow-up; the next answer wins under a fresh `answer:<holdId>:<attempt>` key. Queued/placed repeats cannot change it, and every successful `answer` returns the settlement.

A stale approval POST cannot approve a successor task, even within the same run. The assistant message id is stable from the run's first input; a resume naming an older run settles nothing, and replays only that older run's tail (or returns 409 if it cannot be located). Client tool outputs carry only a tool call id, so replayed client outputs rely on provider ids being unique within a run; approvals do not. Duplicate ids in one tool round are blocked before execution, omitted from waiting and never receive approval requests.

Observation opens before admission. Slow readers do not block Pi delivery. A replacement snapshot fails with `WatchOverflowed`; a cancelled or closed watch fails with `WatchClosed`. Reconnect through `attachRun` or GET to rebuild from a snapshot. Returned attached/continued streams are one-shot and already have their watches open; cancelling them only detaches. Explicit abort interrupts held waits, retains generated partial text and withdraws queued follow-up inputs. A resume without new settlements for a completed message acknowledges that same message with an empty terminal step; aborted tool errors remain visible and the stock client does not repeatedly POST. Calls no run of the conversation made still return 409. Tool replay follows Pi's stored and current policy and does not promise exactly-once external side effects.

## Limits and pending work

Wrap the transport in `resumable()` from `@vivid/durable/client`. After `ConnectionLost`, call `resumeStream()` to replace the partial message with whole-run replay. After a long gap load `history` first, because resume can only bring the run in progress.

`history(harness, conversationId, { limit, before? }, context)` returns oldest-first UI messages and an opaque optional next cursor. `limit` counts messages; a page never splits a multi-entry assistant message. It reads raw fork-aware history, preserving messages removed from model context by compaction. Stable user ids use `entry:<entryId>`; assistant ids use the first assistant entry. During a run, history includes its placed user inputs and any user entries before its first assistant entry; GET reconnect supplies its assistant and tool results. A steer input placed after assistant entries stays out of history until the run settles, because reconnect cannot show it in order. System/reset/compaction/application entries are skipped; late answers are ordinary user messages without special metadata for now. The checked server examples read `limit` and `before` from the GET history query. Invalid cursors fail `HistoryCursorInvalid`; invalid page sizes fail `HistoryPageInvalid`.

Assistant IDs currently differ between live streams (`run:<first submission id>`) and settled history (`entry:<first assistant entry id>`). Pi Durable 1.0.4 cannot list settled receipts through Harness, Session or Tx; only Storage has `scanSubmissions`, which this API does not receive. Raw user entries cannot distinguish an `onYield` continuation inside a run from a queued successor starting another: both carry the preceding generation task and the same payload shape. Until a durable run index is authorized, loading history replaces the message list; do not merge live and stored assistants by ID. `conformance/runs.test.ts` proves the boundary ambiguity, and the upstream ID-parity case remains an expected failure.

`ToolsOptions.execution` (default `parallel`) must equal `HarnessSettings.toolExecution`: Pi does not expose the hidden host setting, so the host must declare it. Every bridged registration has that explicit mode. Pi ORs the harness setting with per-tool modes: explicit `parallel` cannot override a sequential harness; only `sequential` forces sequencing. `ToolsOptions.sequential` lists tools that force a sequential round even in a parallel host. Pi sequences the whole round when any called tool is sequential. The plan retains the host declaration for native tools without an explicit mode; with several bridge extensions, a sequential declaration supplies that conservative default.

If any tool of the agent is sequential under these public declarations, presentation shows only the first tool call of each response while generating. Later calls stay private until their tasks or results exist; a parallel round releases them together when it commits. Agents whose tools are all parallel retain live content order. The live-document watch supplies allocations omitted by the event watch, so the stock approval predicate works for declared sequential held/plain calls and denials. GET reconnect and crash recovery use the same rule. The slow-stream suite also covers late tool identity and OpenAI Responses replacements. An anonymous generating call holds later blocks until its identity arrives or the response ends, preserving content order across delivery batches. Shorter text/reasoning replacements reset and rebuild the current SDK step, removing Responses’ transient summary separator; prior steps remain intact. Live, attachment and history are compared after the replacement.

Known ordering limit: settled history preserves the provider's block order. Any multi-call response of a sequential-capable agent, including a parallel round in a parallel host with an unused sequential tool, may show `text, c1, text, c2`, because c2 stays private until its task exists; history then shows `text, c1, c2, text`. Pi records provider content order and later removes the live slots, without retaining when a reader saw withheld calls. `conformance/ordering.test.ts` proves this difference with the stock SDK client through both live and GET paths.

There is no WebSocket transport. Tool arguments stream as `tool-input-start` and `tool-input-delta` before the final `tool-input-available`. Pi Durable 1.0.4 copies the provider's partial message, including growing raw `partialJson`/`partialArgs` fields when the provider retains them. Its watch can deliver those fields in `block`/`message` updates, alongside parsed arguments; a `block` update is not a block end. The bridge emits final tool input and approval eligibility only at `message_end`. Deltas come only from retained raw JSON, never from stringifying parsed partial objects or grammar input. If the raw text stops extending the already-sent prefix, that call sends no further deltas until final validated input replaces the partial. Shortened or removed started calls reset and rebuild the current step. Reconnect sends the raw text captured so far once, then only new suffixes. Sequential-capable presentation and anonymous identity barriers withhold starts and deltas together. The wrapper in `fixtures/provider.ts` covers the installed `anthropic-messages`, `openai-completions` (including late identity and `customInput`), `bedrock-converse-stream`, `mistral-conversations`, and `openai-responses-shared` implementations, plus `google-generative-ai` mid-stream text signatures; `conformance/arguments.test.ts` proves these shapes through real SQLite and validates the bridge chunks. Interrupted tool inputs become SDK `tool-input-error` / `output-error` parts consistently in live, replay and history, without approval or execution. Live model evaluation stays skipped unless explicitly enabled with real credentials. These Node conformance suites do not establish React Native transport conformance.

Misuse: opening a sequential harness while omitting `ToolsOptions.execution: 'sequential'` declares parallel to the bridge. The hidden Pi default can then queue a call already shown during generation, preventing approval parking or automatic continuation. `conformance/mode.test.ts` preserves the public-mode ambiguity and a bounded demonstration of this misconfiguration. It is the host's responsibility to pass the matching execution policy.

The opt-in live suite defaults to EXPLABS (`EXPLABS_API_KEY`, model `glm-5.3-flash`). To exercise retained partial tool blocks through Pi AI's built-in OpenRouter provider, set `OPENROUTER_API_KEY` in the environment and select a catalogue model:

```sh
DURABLE_LIVE=1 DURABLE_LIVE_PROVIDER=openrouter DURABLE_LIVE_MODEL=anthropic/claude-sonnet-4.6 pnpm exec vitest run src/model.live.test.ts
DURABLE_LIVE=1 DURABLE_LIVE_PROVIDER=openrouter DURABLE_LIVE_MODEL=openai/gpt-4.1 pnpm exec vitest run src/model.live.test.ts
```

Run these from the package directory with a key supplied for this work; no fixture reads another tool's credential store or logs a key. The installed catalogue selects the API independently of the model's brand: `anthropic-messages` retains `partialJson`; `openai-completions` retains `partialArgs`. EXPLABS uses `openai-completions`. The approval case asks for a memo of about 150 words, always checks final client/recorded input equality, approval ordering and exactly one approved execution, and prints whether truncated tool-call blocks and scratch fields were observed. Use `--reporter=verbose --silent=false` to retain this line for successful tests. Absence of truncation is an observation, not a failed precondition. EXPLABS dispatch is capped at two requests per case, and the approval case disables retries.

The truncated-input regression (a tool call closed on a provider's mid-stream block update, so an approval was requested on incomplete arguments) is proven two ways. The source-derived provider wrapper runs the approval suites on a real SQLite harness. And on 6 October 2026 the live approval case ran against a real provider through Pi AI's `openai-completions` implementation (EXPLABS): the provider sent truncated tool-call block updates (`partialArgs` present), the current translator passed, and the same run with the old block-closing dispatch restored showed the client `{ account: '' }` for a call whose recorded arguments were `{ account: 'savings', amount, memo }`. That one provider is the only real one run; the other implementations are covered by the wrapper only. OpenRouter remains opt-in for a host that supplies its own key. Both live cases stay skipped without `DURABLE_LIVE=1`.

A closed run never ends with a step containing tool parts. Live, history and terminal replay append one empty closing step when needed, so both stock automatic-send predicates stay false. A stale closed-run decision restores the durable terminal result and cannot execute a tool.

A host that admits input directly through Pi's `Conversation.submit` can call
`followRun(harness, conversationId, requestId, context)` without a client message. It waits on
that submission's placement, replays its run and follows its live tail; settled runs replay their
stored outcome. The returned stream is one-shot, its watch is already open, and cancelling a
reader only detaches it. Unknown request ids fail `RunMissing`; never-placed withdrawn inputs fail
`TurnWithdrawn`. Each reader owns an independent watch, including after reopening and `harness.resume()`.

Input policy accepts `whenBusy: 'followUp' | 'steer' | 'reject'` in the same options as `maxPartBytes`.
The default is Pi's `followUp` (`harness/submissions.js:149`); `steer` joins the current run at its
next tool boundary, while `reject` fails immediately with `TurnBusy` and HTTP 409. Admission waits
on the input's own receipt, rather than on a future `run_start`: aborting a queued input fails
`TurnWithdrawn` and HTTP 409, including on retry with the same message id. Send a new message id to
admit it again. Observation failures after headers become SDK error chunks rather than successful
completion. Busy policy and decoded byte limits are validated before admission.

Stock SDK regeneration is refused with the distinct `TurnRegenerate` class and HTTP 400; malformed
chat bodies fail `TurnInvalid`. Codec issue annotations preserve these tags through JSON-string
decoding. Neither classification depends on diagnostic text or a constructor default.

A request id names immutable ordered input content, including picture data and filenames. Retrying
that id with the same content returns the same run; different content fails `TurnConflict` (HTTP
409), even while queued or in a concurrent admission race. Send a new message id for changed input.
Pi's existing submission and inbox/entry remain the source of truth; this check adds no receipt store.
