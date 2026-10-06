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

[Complete, type-checked HTTP handler](src/examples/main.ts). It serves chat POST/GET, GET history/waiting, and POST abort/decide/answer. The handler maps invalid schema, hold-id and history inputs to 400, stale interactions to 409, and missing conversations to 404; other failures reject. Decision and answer bodies decode once and validate their opaque task ids with the Promise entry's `holdId` before reaching the durable API.

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
  if (path === '/chat') return respond(harness, conversationId, request, context)
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

Chat `respond` accepts a Request; GET reconnects and returns 204 when idle, POST reads and decodes JSON text. Unsupported methods return 405, missing conversations 404, invalid turns 400 and missing resume runs 409. Other adapter failures reject with the original tagged error class. `decodeTurn` and `respondTurn` support hosts that already decoded an object body. `holdId(text)` validates an opaque hold id received over another wire and throws `HoldIdInvalid` for malformed values, without requiring a core Schema import.

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

## Guarantees

A held call parks the client response with finish-step/finish while Pi's run remains alive. A decision can arrive with no client attached, after a process restart, or more than once: the first settlement for that hold wins. Direct `decide` and `answer` accept the `holdId` returned by `waiting`, and reject wrong-kind or never-waiting holds with `CallNotWaiting`. Unanswered late questions survive unrelated tasks that reuse a provider call id. A late answer reserves its first output before admission and keeps its question and submission receipt until placement. Abort reopens a withdrawn follow-up; the next answer wins under a fresh `answer:<holdId>:<attempt>` key. Queued/placed repeats cannot change it, and every successful `answer` returns the settlement.

A stale approval POST cannot approve a successor task, even within the same run. The assistant message id is stable from the run's first input; a resume naming an older run settles nothing, and replays only that older run's tail (or returns 409 if it cannot be located). Client tool outputs carry only a tool call id, so replayed client outputs rely on provider ids being unique within a run; approvals do not. Duplicate ids in one tool round are blocked before execution, omitted from waiting and never receive approval requests.

Observation opens before admission. Slow readers do not block Pi delivery. A replacement snapshot fails with `WatchOverflowed`; a cancelled or closed watch fails with `WatchClosed`. Reconnect through `attachRun` or GET to rebuild from a snapshot. Returned attached/continued streams are one-shot and already have their watches open; cancelling them only detaches. Explicit abort interrupts held waits, retains generated partial text and withdraws queued follow-up inputs. Tool replay follows Pi's stored and current policy and does not promise exactly-once external side effects.

## Limits and pending work

After a network error, reload history and reconnect with fresh SDK stream state. Resuming step 2 into a kept partial message duplicates earlier text and tools: reset-step clears only the current step. This is the one permitted expected-failure test. Creating a new Chat alone does not always fix it: ai/src/ui/chat.ts:852–858 snapshots a last assistant message with an input-streaming tool part. History must replace that failed partial message first.

`history(harness, conversationId, { limit, before? }, context)` returns oldest-first UI messages and an opaque optional next cursor. `limit` counts messages; a page never splits a multi-entry assistant message. It reads raw fork-aware history, preserving messages removed from model context by compaction. Stable user ids use `entry:<entryId>`; assistant ids use the first assistant entry. During a run, history includes its placed user inputs and any user entries before its first assistant entry; GET reconnect supplies its assistant and tool results. A steer input placed after assistant entries stays out of history until the run settles, because reconnect cannot show it in order. System/reset/compaction/application entries are skipped; late answers are ordinary user messages without special metadata for now. The checked server examples read `limit` and `before` from the GET history query. Invalid cursors fail `HistoryCursorInvalid`; invalid page sizes fail `HistoryPageInvalid`.

Parallel calls being generated are shown in content order. Only committed sequential slots without a task stay private until Pi allocates their tasks or stores their results. The live-document watch supplies allocations that the event watch omits, so the stock approval predicate works for committed sequential held/plain calls and denials. GET reconnect and crash recovery apply the same presentation rule.

There is no WebSocket transport. This library does not stream tool arguments yet. Pi Durable 1.0.4 copies the provider's partial message, including growing raw `partialJson`/`partialArgs` fields when the provider retains them. Its watch can deliver those fields in `block`/`message` updates, alongside parsed arguments; a `block` update is not a block end. The bridge emits final tool input and approval eligibility only at `message_end`. The wrapper in `fixtures/provider.ts` follows Anthropic, OpenAI, Bedrock and Mistral scratch fields and Google's mid-stream text signatures; `conformance/arguments.test.ts` proves these shapes through real SQLite and validates the bridge chunks. Live model evaluation stays skipped unless explicitly enabled with real credentials. These Node conformance suites do not establish React Native transport conformance.

Known sequential-generation limit: the global `HarnessSettings.toolExecution` is private to Pi Durable 1.0.4's harness, and the public agent does not default its registered tools' `executionMode` from that setting. The bridge cannot know the global mode before the round commits. A slow sequential response can expose a second call before it becomes queued; that call cannot be removed from an SDK message and may prevent approval parking or automatic continuation. The bounded evidence in `conformance/mode.test.ts` proves both the indistinguishable public agents and the two visible starts before any tool slots exist. Fixing this requires an explicit execution-policy input or an upstream public resolved-mode contract; no policy is guessed here.

The opt-in live suite defaults to EXPLABS (`EXPLABS_API_KEY`, model `glm-5.3-flash`). To exercise retained partial tool blocks through Pi AI's built-in OpenRouter provider, set `OPENROUTER_API_KEY` in the environment and select a catalogue model:

```sh
DURABLE_LIVE=1 DURABLE_LIVE_PROVIDER=openrouter DURABLE_LIVE_MODEL=anthropic/claude-sonnet-4.6 pnpm exec vitest run src/model.live.test.ts
DURABLE_LIVE=1 DURABLE_LIVE_PROVIDER=openrouter DURABLE_LIVE_MODEL=openai/gpt-4.1 pnpm exec vitest run src/model.live.test.ts
```

Run these from the package directory. The pinned OpenRouter catalogue routes that Claude model through `anthropic-messages` (retained `partialJson`) and the OpenAI model through `openai-completions` (retained `partialArgs`). EXPLABS also uses `openai-completions`, but that upstream endpoint need not deliver incremental tool arguments. The OpenRouter approval case requires an observed truncated partial block before the final input; if the chosen provider/model emits no such update, it fails rather than claiming N1 was proved. Both live cases stay skipped without `DURABLE_LIVE=1`; no fixture reads or logs the key's value.
