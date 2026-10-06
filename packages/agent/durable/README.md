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

[Complete, type-checked HTTP handler](src/examples/main.ts). It serves chat POST/GET, GET waiting, and POST abort/decide/answer. The host's HTTP framework maps schema rejection to 400 and records other failures. Decision and answer bodies decode once with the exported HoldId contract before reaching the durable API.

This is the handler excerpt; imports and compiled body decoders are in the linked source:

```ts
export async function route(
  harness: Harness,
  conversationId: ConversationId,
  request: Request,
  context: Context,
): Promise<Response> {
  const path = new URL(request.url).pathname
  if (path === '/chat') return respond(harness, conversationId, request, context)
  if (path === '/waiting' && request.method === 'GET')
    return Response.json(await waiting(harness, conversationId, context))
  if (request.method !== 'POST') return new Response(null, { status: 405 })
  if (path === '/abort') {
    await abort(harness, conversationId, context)
    return new Response(null, { status: 204 })
  }
  if (path === '/decide') {
    const decision = await decodeDecision(await request.text())
    return Response.json(await decide(harness, conversationId, decision, context))
  }
  if (path === '/answer') {
    const output = await decodeAnswer(await request.text())
    const delivered = await answer(harness, conversationId, output, context)
    if (delivered === undefined) return new Response(null, { status: 204 })
    return Response.json(delivered)
  }
  return new Response(null, { status: 404 })
}
```

Chat `respond` accepts a Request; GET reconnects and returns 204 when idle, POST reads and decodes JSON text. Unsupported methods return 405, missing conversations 404, invalid turns 400 and missing resume runs 409. Other adapter failures reject with the original tagged error class. `decodeTurn` and `respondTurn` support hosts that already decoded an object body.

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

The same source exposes typed `actions` for abort, waiting, decide and answer. Decode route bodies before calling them. Core `decodeTurn` is a compiled object decoder; `Schema.fromJsonString(TurnBody)` is the corresponding JSON-text ingress. Core `prepareRun` admits input and returns a one-shot stream whose watch is already open.

## Client protocol

Use the stock `useChat` transport, `DefaultChatTransport`, pointing at the authorized chat endpoint. For approval, use `lastAssistantMessageIsCompleteWithApprovalResponses` and echo the tool part's `approval.id` to `addToolApprovalResponse`; that opaque value identifies a durable tool task. For person-supplied tool output, use `lastAssistantMessageIsCompleteWithToolCalls` and `addToolOutput` with the part's tool name and call id. The SDK resubmits the assistant message and continues it in place. The integration suites exercise the real AbstractChat and these stock predicates.

A React hook/component example must be supplied by the frontend owner; the checked examples here are backend code. Client `stop()` drops the fetch only. An application that intends to stop durable work calls its authorized abort endpoint too.

## Guarantees

A held call parks the client response with finish-step/finish while Pi's run remains alive. A decision can arrive with no client attached, after a process restart, or more than once: the first settlement for that hold wins. Direct `decide` and `answer` accept the `holdId` returned by `waiting`, and reject wrong-kind or never-waiting holds with `CallNotWaiting`. Unanswered late questions survive unrelated tasks that reuse a provider call id; their answer submissions deduplicate on `answer:<holdId>`.

A stale approval POST cannot approve a successor task, even within the same run. Client tool outputs carry only a tool call id, so replayed client outputs rely on provider ids being unique within a run; approvals do not. Duplicate ids in one tool round are blocked before execution, omitted from waiting and never receive approval requests.

Observation opens before admission. Slow readers do not block Pi delivery. A replacement snapshot fails with `WatchOverflowed`; a cancelled or closed watch fails with `WatchClosed`. Reconnect through `attachRun` or GET to rebuild from a snapshot. Returned attached/continued streams are one-shot and already have their watches open; cancelling them only detaches. Explicit abort interrupts held waits, retains generated partial text and withdraws queued follow-up inputs. Tool replay follows Pi's stored and current policy and does not promise exactly-once external side effects.

## Limits and pending work

After a network error, reload settled history and reconnect with fresh SDK stream state. Resuming step 2 into a kept partial message duplicates earlier text and tools: reset-step clears only the current step. This is the one permitted expected-failure test. Creating a new Chat alone does not always fix it: ai/src/ui/chat.ts:852–858 snapshots a last assistant message with an input-streaming tool part. Settled history must replace that failed partial message first.

The planned `history` API is blocked on its Storage authority. Pi exposes the required settled-submission scan only on Storage, not Harness, and raw entries do not carry the original client request id. Until that input is agreed, this package has no history endpoint; an application needs its own authorized settled-history loader for reload-then-resume. No history example or incomplete history implementation is exported.

Sequential presentation remains blocked: Pi 1.0.4 assigns a queued successor its task while leaving its slot pending, but watchEvents emits no task-admission event for that transition. The lower LiveDoc and ConversationView watches do carry it. Parallel approval rounds work with the stock predicate; do not claim the sequential flow is complete or poll around the missing event.

There is no WebSocket transport or streaming tool-argument presentation. Live model evaluation stays skipped unless explicitly enabled with real credentials. These Node conformance suites do not establish React Native transport conformance.
