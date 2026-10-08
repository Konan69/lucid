import { runForPi } from '../pi.ts'
import { consumeReadable, hold } from '../fixtures/reading.ts'
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux'
import { expect, it } from '@effect/vitest'
import { Effect, Deferred, Fiber, Option } from 'effect'
import {
  DefaultChatTransport,
  tool,
  isToolUIPart,
  lastAssistantMessageIsCompleteWithApprovalResponses,
  lastAssistantMessageIsCompleteWithToolCalls,
  type UIMessage,
} from 'ai'
import { z } from 'zod'
import * as NodeEvents from 'node:events'
import type { Harness } from '@earendil-works/pi-durable'
import { requestBudget } from '../fixtures/budget.mjs'
import { PlainChat, client, Decision } from '../fixtures/chat.ts'
import {
  abort,
  decide,
  followRun,
  decodeTurn,
  respond,
  streamRun,
  history,
  TurnWithdrawn,
  TurnStranded,
  TurnWaiting,
  TurnBusy,
  LimitInvalid,
  TurnRegenerate,
  RunMissing,
} from '../main.ts'
import { call, context, host, shop, texts } from './fixtures/host.ts'

/** A lost HTTP response can be retried with the same user identity after its run has settled. */
it.live.each(['done', 'aborted', 'failed', 'active'] as const)(
  'finishes a repeated user POST for a %s run without another model invocation',
  (state) =>
    Effect.gen(function* () {
      const fixture = yield* shop()
      const opened = yield* fixture.open()
      const response =
        state === 'failed'
          ? fauxAssistantMessage('Failed partial', {
              stopReason: 'error',
              errorMessage: 'invalid model request',
            })
          : fauxAssistantMessage('Done.')
      opened.faux.setResponses(
        state === 'active' || state === 'aborted'
          ? [call('pay', { amount: 1 }, 'held')]
          : [response],
      )
      const first = new PlainChat({ transport: opened.transport })
      yield* Effect.promise(() => Promise.resolve(first.sendMessage({ text: 'First' })))
      if (state === 'aborted')
        yield* Effect.promise(() => Promise.resolve(abort(opened.harness, opened.root.id, context)))
      if (state !== 'active')
        yield* Effect.promise(() => Promise.resolve(opened.root.waitForIdle(context)))
      const user = first.messages[0]
      if (user === undefined || user.role !== 'user') throw new Error('Expected user input')
      const finished = Deferred.makeUnsafe<void>()
      const retried = new PlainChat({
        transport: opened.transport,
        onFinish: () => Deferred.doneUnsafe(finished, Effect.void),
      })
      retried.messages = [user]
      yield* Effect.promise(() => Promise.resolve(retried.sendMessage()))
      yield* Deferred.await(finished)
      expect(retried.status).toBe(state === 'failed' ? 'error' : 'ready')
      expect(opened.faux.state.callCount).toBe(1)
      if (retried.lastMessage === undefined || first.lastMessage === undefined)
        throw new Error('Expected messages')
      expect(retried.lastMessage.id).toBe(first.lastMessage.id)
      if (state === 'done') expect(texts(retried.lastMessage)).toEqual(['Done.'])
      if (state === 'active') expect(retried.lastMessage.parts).toEqual(first.lastMessage.parts)
      if (state === 'aborted')
        expect(retried.lastMessage.parts).toContainEqual(
          expect.objectContaining({ toolCallId: 'held', state: 'output-error' }),
        )
    }),
)

/** Pi's transcript is append-only; stock SDK regeneration must be an explicit typed refusal. */
it.live('refuses stock Chat.regenerate with 400 instead of reopening the same input', () =>
  Effect.gen(function* () {
    const opened = yield* (yield* shop()).open()
    opened.faux.setResponses([fauxAssistantMessage('Once')])
    const chat = new PlainChat({ transport: opened.transport })
    yield* Effect.promise(() => Promise.resolve(chat.sendMessage({ text: 'First' })))
    yield* Effect.promise(() => Promise.resolve(chat.regenerate()))
    expect(chat.status).toBe('error')
    expect(chat.error).toBeInstanceOf(Error)
    if (chat.error === undefined) throw new Error('Expected regeneration refusal')
    expect(chat.error.message).toBe('Regeneration is not supported')
    expect(opened.faux.state.callCount).toBe(1)
  }),
)

/** A committed queued receipt, rather than a timer, proves admission before the host aborts. */
const queued = Effect.fn('Test.queued')(function* (harness: Harness, requestId: string) {
  const admitted = Deferred.makeUnsafe<void>()
  const unsubscribe = harness.subscribeCommits((publication) => {
    if (
      publication.changes.some(
        (change) =>
          change.type === 'submission' &&
          change.value.requestId === requestId &&
          change.value.status === 'queued',
      )
    )
      Deferred.doneUnsafe(admitted, Effect.void)
  })
  yield* Effect.addFinalizer(() => Effect.sync(unsubscribe))
  return admitted
})

/** Abort releases this real SDK invocation through its signal; cleanup also releases a failed test. */
const working = Effect.fn('Test.working')(function* () {
  const entered = Deferred.makeUnsafe<void>()
  const release = Deferred.makeUnsafe<void>()
  const fixture = yield* host(
    {
      work: tool({
        inputSchema: z.object({}),
        execute: (_input, options) =>
          runForPi(
            Effect.gen(function* () {
              Deferred.doneUnsafe(entered, Effect.void)
              const abortSignal = options.abortSignal
              if (abortSignal === undefined) throw new Error('Expected tool cancellation signal')
              yield* Effect.raceFirst(
                Deferred.await(release),
                Effect.promise(() => NodeEvents.EventEmitter.once(abortSignal, 'abort')),
              )
              return 'worked'
            }),
            undefined,
          ),
      }),
    },
    {},
  )
  const opened = yield* fixture.open()
  yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined))
  opened.faux.setResponses([
    call('work', {}, 'work'),
    fauxAssistantMessage('First finished.'),
    fauxAssistantMessage('Second finished.'),
  ])
  const first = new PlainChat({ transport: opened.transport })
  const sending = first.sendMessage({ text: 'First' })
  yield* Deferred.await(entered)
  return { ...opened, first, sending, release }
})

/** R10-1: neither a follow-up nor a steer withdrawn before placement has an assistant to acknowledge. */
it.live.each(['followUp', 'steer'] as const)(
  'ends a withdrawn %s POST and refuses its retry',
  (whenBusy) =>
    Effect.gen(function* () {
      const opened = yield* working()
      const admitted = yield* queued(opened.harness, 'withdrawn')
      const transport = new DefaultChatTransport<UIMessage>({
        api: 'http://durable.test/chat',
        fetch: (url, init) => {
          return Promise.resolve(
            respond(
              opened.harness,
              opened.root.id,
              { request: new Request(url, init), options: { whenBusy } },
              context,
            ),
          )
        },
      })
      const chat = new PlainChat({ transport, generateId: () => 'withdrawn' })
      const posting = chat.sendMessage({ text: 'Withdrawn person input' })
      yield* Deferred.await(admitted)
      yield* Effect.promise(() => Promise.resolve(abort(opened.harness, opened.root.id, context)))
      yield* Effect.promise(() => Promise.resolve(posting))
      yield* Effect.promise(() => Promise.resolve(opened.sending))
      expect(chat.status).toBe('error')
      if (chat.error === undefined) throw new Error('Expected admission refusal')
      expect(chat.error.message).toBe(new TurnWithdrawn({ messageId: 'withdrawn' }).message)
      const input = {
        conversationId: opened.root.id,
        content: 'Withdrawn person input',
        requestId: 'withdrawn',
      }
      yield* Effect.promise(() =>
        Promise.resolve(
          expect(streamRun(opened.harness, input, context)).rejects.toBeInstanceOf(TurnWithdrawn),
        ),
      )
      yield* Effect.promise(() =>
        Promise.resolve(
          expect(
            followRun(opened.harness, opened.root.id, 'withdrawn', context),
          ).rejects.toBeInstanceOf(TurnWithdrawn),
        ),
      )
      const retry = yield* Effect.promise(() =>
        Promise.resolve(
          respond(
            opened.harness,
            opened.root.id,
            new Request('http://durable.test/chat', {
              method: 'POST',
              body: JSON.stringify({
                messages: [
                  { role: 'user', id: 'withdrawn', parts: [{ type: 'text', text: input.content }] },
                ],
              }),
            }),
            context,
          ),
        ),
      )
      expect(retry.status).toBe(409)
      const stored = yield* Effect.promise(() =>
        Promise.resolve(history(opened.harness, opened.root.id, { limit: 10 }, context)),
      )
      expect(stored.messages.flatMap(texts)).not.toContain(input.content)
    }),
)

/** Reject is Pi's no-write busy admission, surfaced before any UI stream exists. */
it.live('refuses a busy reject turn immediately without admitting it', () =>
  Effect.gen(function* () {
    const opened = yield* working()
    yield* Effect.promise(() =>
      Promise.resolve(
        expect(
          streamRun(
            opened.harness,
            {
              conversationId: opened.root.id,
              content: 'No queue',
              requestId: 'rejected',
              options: { whenBusy: 'reject' },
            },
            context,
          ),
        ).rejects.toBeInstanceOf(TurnBusy),
      ),
    )
    yield* Effect.promise(() =>
      Promise.resolve(
        expect(
          followRun(opened.harness, opened.root.id, 'rejected', context),
        ).rejects.toBeInstanceOf(RunMissing),
      ),
    )
    const chat = new PlainChat({
      transport: new DefaultChatTransport<UIMessage>({
        api: 'http://durable.test/chat',
        fetch: (url, init) => {
          return Promise.resolve(
            respond(
              opened.harness,
              opened.root.id,
              { request: new Request(url, init), options: { whenBusy: 'reject' } },
              context,
            ),
          )
        },
      }),
    })
    yield* Effect.promise(() => Promise.resolve(chat.sendMessage({ text: 'No queue either' })))
    expect(chat.status).toBe('error')
    if (chat.error === undefined) throw new Error('Expected admission refusal')
    expect(chat.error.message).toBe(new TurnBusy({ conversationId: opened.root.id }).message)
    yield* Effect.promise(() => Promise.resolve(abort(opened.harness, opened.root.id, context)))
    yield* Effect.promise(() => Promise.resolve(opened.sending))
  }),
)

/** The observer acquires its own receipt and follows only the queued request's eventual run. */
it.live('follows a queued host input when it is placed, with two independent readers', () =>
  Effect.gen(function* () {
    const opened = yield* working()
    const handle = yield* Effect.promise(() =>
      Promise.resolve(
        opened.root.submit({ type: 'input', content: 'Second', requestId: 'host-second' }, context),
      ),
    )
    expect((yield* Effect.promise(() => Promise.resolve(handle.status(context)))).status).toBe(
      'queued',
    )
    const one = followRun(opened.harness, opened.root.id, 'host-second', context)
    const two = followRun(opened.harness, opened.root.id, 'host-second', context)
    Deferred.doneUnsafe(opened.release, Effect.void)
    yield* Effect.promise(() => Promise.resolve(opened.sending))
    const a = yield* consumeReadable(
      yield* Effect.promise(() => Promise.resolve(one)),
      Option.none(),
    )
    const b = yield* consumeReadable(
      yield* Effect.promise(() => Promise.resolve(two)),
      Option.none(),
    )
    expect(a.message).toEqual(b.message)
    expect(texts(a.message)).toEqual(['Second finished.'])
    if (opened.first.lastMessage === undefined) throw new Error('Expected first assistant message')
    expect(a.message.id).not.toBe(opened.first.lastMessage.id)
    const stored = yield* consumeReadable(
      yield* Effect.promise(() =>
        Promise.resolve(followRun(opened.harness, opened.root.id, 'host-second', context)),
      ),
      Option.none(),
    )
    expect(stored.message).toEqual(a.message)
  }),
)

/** Stored completed/aborted responses remain reacquirable even while a successor run waits. */
it.live.each(['completed', 'aborted'] as const)(
  'follows the stored %s run rather than a newer active run',
  (state) =>
    Effect.gen(function* () {
      const opened = yield* (yield* shop()).open()
      opened.faux.setResponses([
        state === 'completed'
          ? fauxAssistantMessage('Completed.')
          : call('pay', { amount: 1 }, 'old'),
      ])
      yield* Effect.promise(() =>
        Promise.resolve(
          opened.root.submit({ type: 'input', content: 'Old', requestId: 'host-old' }, context),
        ),
      )
      const old = yield* consumeReadable(
        yield* Effect.promise(() =>
          Promise.resolve(followRun(opened.harness, opened.root.id, 'host-old', context)),
        ),
        Option.none(),
      )
      if (state === 'aborted')
        yield* Effect.promise(() => Promise.resolve(abort(opened.harness, opened.root.id, context)))
      else yield* Effect.promise(() => Promise.resolve(opened.root.waitForIdle(context)))
      opened.faux.setResponses([call('pay', { amount: 2 }, 'new')])
      const next = yield* consumeReadable(
        yield* Effect.promise(() =>
          Promise.resolve(
            streamRun(
              opened.harness,
              { conversationId: opened.root.id, content: 'New', requestId: 'host-new' },
              context,
            ),
          ),
        ),
        Option.none(),
      )
      const stored = yield* consumeReadable(
        yield* Effect.promise(() =>
          Promise.resolve(followRun(opened.harness, opened.root.id, 'host-old', context)),
        ),
        Option.none(),
      )
      expect(stored.message.id).toBe(old.message.id)
      expect(stored.message.id).not.toBe(next.message.id)
      if (state === 'completed') expect(stored.message).toEqual(old.message)
      else
        expect(stored.message.parts).toContainEqual(
          expect.objectContaining({ toolCallId: 'old', state: 'output-error' }),
        )
      expect(
        stored.message.parts.some((part) => 'toolCallId' in part && part.toolCallId === 'new'),
      ).toBe(false)
    }),
)

/** Non-TypeScript hosts must receive the same tagged refusal, preserving the offending wire value. */
// @effect/vitest uses it.for; object rows preserve a literal null rather than an absent row.
it.live.each(['5', null, {}].map((value) => ({ value, label: JSON.stringify(value) })))(
  'tags a non-numeric host part budget $label without reading or submitting',
  ({ value }) =>
    Effect.gen(function* () {
      const opened = yield* (yield* shop()).open()
      const request = requestBudget(
        opened.harness,
        { conversationId: opened.root.id, value },
        context,
      )
      yield* Effect.promise(() =>
        Promise.resolve(expect(request).rejects.toBeInstanceOf(LimitInvalid)),
      )
      yield* Effect.promise(() => Promise.resolve(expect(request).rejects.toMatchObject({ value })))
      expect(opened.faux.state.callCount).toBe(0)
      expect(
        (yield* Effect.promise(() =>
          Promise.resolve(opened.root.entries({}, 10, undefined, context)),
        )).items,
      ).toEqual([])
    }),
)

/** Regeneration keeps its own tag through object and JSON-string codecs, never a text comparison. */
it.live(
  'rejects regeneration with its own class through both body decoder and Request ingress',
  () =>
    Effect.gen(function* () {
      const opened = yield* (yield* shop()).open()
      const body = {
        trigger: 'regenerate-message',
        messages: [{ role: 'user', id: 'regenerate', parts: [{ type: 'text', text: 'Again' }] }],
      }
      yield* Effect.promise(() =>
        Promise.resolve(expect(decodeTurn(body)).rejects.toBeInstanceOf(TurnRegenerate)),
      )
      const response = yield* Effect.promise(() =>
        Promise.resolve(
          respond(
            opened.harness,
            opened.root.id,
            new Request('http://durable.test/chat', { method: 'POST', body: JSON.stringify(body) }),
            context,
          ),
        ),
      )
      expect(response.status).toBe(400)
      expect(yield* Effect.promise(() => Promise.resolve(response.text()))).toBe(
        new TurnRegenerate({}).message,
      )
      expect(opened.faux.state.callCount).toBe(0)
    }),
)

/** A final boundary places a queued successor under the predecessor generation task (Pi
 * generation.js:408–421). Task attribution is not a run boundary; replay must stop before B. */
it.live.each(['running', 'ended'] as const)(
  'bounds a completed predecessor while its queued successor is %s',
  (state) =>
    Effect.gen(function* () {
      const opened = yield* (yield* shop()).open()
      const entered = Deferred.makeUnsafe<void>()
      const release = Deferred.makeUnsafe<void>()
      yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined))
      opened.faux.setResponses([
        () =>
          runForPi(
            Effect.gen(function* () {
              Deferred.doneUnsafe(entered, Effect.void)
              yield* Deferred.await(release)
              return fauxAssistantMessage('Recovered initial.')
            }),
            undefined,
          ),
        call('pay', { amount: 2 }, 'successor'),
        fauxAssistantMessage('Queued final.'),
      ])
      yield* Effect.promise(() =>
        Promise.resolve(
          opened.root.submit(
            { type: 'input', content: 'First', requestId: 'bounded-first' },
            context,
          ),
        ),
      )
      yield* Deferred.await(entered)
      const successorInput = yield* Effect.promise(() =>
        Promise.resolve(
          opened.root.submit(
            { type: 'input', content: 'Second', requestId: 'bounded-second' },
            context,
          ),
        ),
      )
      expect(
        (yield* Effect.promise(() => Promise.resolve(successorInput.status(context)))).status,
      ).toBe('queued')
      const original = yield* Effect.forkScoped(
        consumeReadable(
          yield* Effect.promise(() =>
            Promise.resolve(followRun(opened.harness, opened.root.id, 'bounded-first', context)),
          ),
          Option.none(),
        ),
      )
      Deferred.doneUnsafe(release, Effect.void)
      const first = yield* Fiber.join(original)
      yield* consumeReadable(
        yield* Effect.promise(() =>
          Promise.resolve(followRun(opened.harness, opened.root.id, 'bounded-second', context)),
        ),
        Option.none(),
      )
      if (state === 'ended') {
        yield* Effect.gen(function* () {
          const awaited1 = yield* hold(opened.harness, opened.root.id, 'successor', context)
          return yield* Effect.promise(() =>
            Promise.resolve(
              decide(opened.harness, opened.root.id, { holdId: awaited1, approved: true }, context),
            ),
          )
        })
        yield* Effect.promise(() => Promise.resolve(opened.root.waitForIdle(context)))
      }
      const replayed = yield* consumeReadable(
        yield* Effect.promise(() =>
          Promise.resolve(followRun(opened.harness, opened.root.id, 'bounded-first', context)),
        ),
        Option.none(),
      )
      expect(texts(replayed.message)).toEqual(['Recovered initial.'])
      expect(replayed.message).toEqual(first.message)
      expect(replayed.chunks.at(-1)).toEqual({
        type: 'finish',
        messageMetadata: first.message.metadata,
      })
    }),
)

/** A failed predecessor leaves queued inputs in Pi's inbox. Library POSTs withdraw only their
 * own input and answer 409; retries observe the same durable withdrawal instead of hanging. */
it.live.each(['followUp', 'steer'] as const)(
  'withdraws a %s POST stranded by model failure',
  (whenBusy) =>
    Effect.gen(function* () {
      const entered = Deferred.makeUnsafe<void>()
      const release = Deferred.makeUnsafe<void>()
      const opened = yield* (yield* host(
        {},
        {},
        { retry: { enabled: false, baseDelayMs: 0 } },
      )).open()
      yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined))
      opened.faux.setResponses([
        () =>
          runForPi(
            Effect.gen(function* () {
              Deferred.doneUnsafe(entered, Effect.void)
              yield* Deferred.await(release)
              return fauxAssistantMessage('partial', {
                stopReason: 'error',
                errorMessage: 'invalid model request',
              })
            }),
            undefined,
          ),
      ])
      const first = new PlainChat({ transport: opened.transport })
      const sending = first.sendMessage({ text: 'Predecessor' })
      yield* Deferred.await(entered)
      const admitted = yield* queued(opened.harness, 'stranded-post')
      const chat = new PlainChat({
        generateId: () => 'stranded-post',
        transport: new DefaultChatTransport<UIMessage>({
          api: 'http://durable.test/chat',
          fetch: (url, init) => {
            return Promise.resolve(
              respond(
                opened.harness,
                opened.root.id,
                { request: new Request(url, init), options: { whenBusy } },
                context,
              ),
            )
          },
        }),
      })
      const posting = chat.sendMessage({ text: 'Not placed' })
      yield* Deferred.await(admitted)
      Deferred.doneUnsafe(release, Effect.void)
      yield* Effect.promise(() => Promise.resolve(sending))
      yield* Effect.promise(() => Promise.resolve(posting))
      expect(chat.status).toBe('error')
      expect(chat.error === undefined ? undefined : chat.error.message).toBe(
        new TurnWithdrawn({ messageId: 'stranded-post' }).message,
      )
      yield* Effect.promise(() =>
        Promise.resolve(
          expect(
            streamRun(
              opened.harness,
              {
                conversationId: opened.root.id,
                content: 'Not placed',
                requestId: 'stranded-post',
              },
              context,
            ),
          ).rejects.toBeInstanceOf(TurnWithdrawn),
        ),
      )
      expect(
        (yield* Effect.promise(() =>
          Promise.resolve(history(opened.harness, opened.root.id, { limit: 10 }, context)),
        )).messages.flatMap(texts),
      ).not.toContain('Not placed')
    }),
)

/** A host-owned input remains untouched on both the run-end event and a subsequent idle watch.
 * A later submission places it, after which following the same id succeeds. */
it.live('reports a stranded host input without withdrawing it, then follows its placed run', () =>
  Effect.gen(function* () {
    const opened = yield* working()
    opened.faux.setResponses([
      fauxAssistantMessage('partial', {
        stopReason: 'error',
        errorMessage: 'invalid model request',
      }),
    ])
    const submission = yield* Effect.promise(() =>
      Promise.resolve(
        opened.root.submit(
          { type: 'input', content: 'Host queued', requestId: 'host-stranded' },
          context,
        ),
      ),
    )
    const followed = followRun(opened.harness, opened.root.id, 'host-stranded', context)
    const rejected = expect(followed).rejects.toBeInstanceOf(TurnStranded)
    Deferred.doneUnsafe(opened.release, Effect.void)
    yield* Effect.promise(() => Promise.resolve(opened.sending))
    yield* Effect.promise(() => Promise.resolve(rejected))
    yield* Effect.promise(() => Promise.resolve(opened.root.waitForIdle(context)))
    expect((yield* Effect.promise(() => Promise.resolve(submission.status(context)))).status).toBe(
      'queued',
    )
    yield* Effect.promise(() =>
      Promise.resolve(
        expect(
          followRun(opened.harness, opened.root.id, 'host-stranded', context),
        ).rejects.toBeInstanceOf(TurnStranded),
      ),
    )
    opened.faux.setResponses([
      fauxAssistantMessage('Queued answer.'),
      fauxAssistantMessage('Next answer.'),
    ])
    yield* Effect.promise(() =>
      Promise.resolve(
        opened.root.submit({ type: 'input', content: 'Unstick', requestId: 'unstick' }, context),
      ),
    )
    const result = yield* consumeReadable(
      yield* Effect.promise(() =>
        Promise.resolve(followRun(opened.harness, opened.root.id, 'host-stranded', context)),
      ),
      Option.none(),
    )
    expect(texts(result.message)).toEqual(['Queued answer.'])
  }),
)

/** A new message cannot be answered while this Chat's predecessor waits for a person.
 * Both installed stock predicates (ui/last-assistant-message-is-complete-*.ts) require a last
 * assistant message: remove the refused user before approving, then the stock flow works. */
it.live.each(
  (['followUp', 'steer', 'reject'] as const).flatMap((whenBusy) =>
    (['approval', 'answer'] as const).map((kind) => ({ whenBusy, kind })),
  ),
)('refuses new $whenBusy input while parked on $kind without queuing it', ({ whenBusy, kind }) =>
  Effect.gen(function* () {
    const fixture = yield* shop()
    const opened = yield* fixture.open()
    opened.faux.setResponses([
      kind === 'approval'
        ? call('pay', { amount: 3 }, 'pay')
        : call('ask', { question: 'Account?' }, 'ask'),
      fauxAssistantMessage('Paid.'),
    ])
    const { chat, next } = client({
      sendAutomaticallyWhen:
        kind === 'approval'
          ? lastAssistantMessageIsCompleteWithApprovalResponses
          : lastAssistantMessageIsCompleteWithToolCalls,
      transport: new DefaultChatTransport<UIMessage>({
        api: 'http://durable.test/chat',
        fetch: (url, init) => {
          return Promise.resolve(
            respond(
              opened.harness,
              opened.root.id,
              { request: new Request(url, init), options: { whenBusy } },
              context,
            ),
          )
        },
      }),
    })
    const initial = next()
    yield* Effect.promise(() => Promise.resolve(chat.sendMessage({ text: 'Pay' })))
    expect(yield* initial).toEqual(Decision.cases.Settled.make({}))
    const held = chat.lastMessage
    if (held === undefined) throw new Error('Expected held assistant')
    const part = held.parts.find(isToolUIPart)
    if (part === undefined) throw new Error('Expected waiting call')
    yield* Effect.promise(() => Promise.resolve(chat.sendMessage({ text: 'Another message' })))
    expect(chat.status).toBe('error')
    if (chat.error === undefined) throw new Error('Expected waiting refusal')
    expect(chat.error.message).toBe(new TurnWaiting({ conversationId: opened.root.id }).message)
    const refused = chat.lastMessage
    if (refused === undefined) throw new Error('Expected refused user message')
    yield* Effect.promise(() =>
      Promise.resolve(
        expect(
          followRun(opened.harness, opened.root.id, refused.id, context),
        ).rejects.toBeInstanceOf(RunMissing),
      ),
    )
    expect(lastAssistantMessageIsCompleteWithApprovalResponses({ messages: chat.messages })).toBe(
      false,
    )
    expect(lastAssistantMessageIsCompleteWithToolCalls({ messages: chat.messages })).toBe(false)
    chat.messages = chat.messages.slice(0, -1)
    chat.clearError()
    const finished = next()
    if (kind === 'approval') {
      if (part.state !== 'approval-requested') throw new Error('Expected approval')
      yield* Effect.promise(() =>
        Promise.resolve(chat.addToolApprovalResponse({ id: part.approval.id, approved: true })),
      )
    } else
      yield* Effect.promise(() =>
        Promise.resolve(
          chat.addToolOutput({ tool: 'ask', toolCallId: part.toolCallId, output: 'yes' }),
        ),
      )
    expect(yield* finished).toEqual(Decision.cases.Settled.make({}))
    expect(chat.status).toBe('ready')
    expect(fixture.paid).toEqual(kind === 'approval' ? [3] : [])
    if (chat.lastMessage === undefined) throw new Error('Expected final message')
    expect(texts(chat.lastMessage)).toEqual(['Paid.'])
  }),
)

/** A queued POST is withdrawn when the predecessor parks, using the same waiting rule as
 * admission. Host-owned receipts may deliberately wait there and are not withdrawn. */
it.live('withdraws a queued POST when its predecessor parks, but keeps a host follower', () =>
  Effect.gen(function* () {
    const entered = Deferred.makeUnsafe<void>()
    const release = Deferred.makeUnsafe<void>()
    const fixture = yield* shop()
    const held = yield* fixture.open()
    yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined))
    held.faux.setResponses([
      () =>
        runForPi(
          Effect.gen(function* () {
            Deferred.doneUnsafe(entered, Effect.void)
            yield* Deferred.await(release)
            return call('pay', { amount: 4 }, 'held')
          }),
          undefined,
        ),
      fauxAssistantMessage('Paid.'),
      fauxAssistantMessage('Host answered.'),
    ])
    const first = new PlainChat({ transport: held.transport })
    const sending = first.sendMessage({ text: 'First' })
    yield* Deferred.await(entered)
    const admitted = yield* queued(held.harness, 'queued-before-hold')
    const next = new PlainChat({
      transport: held.transport,
      generateId: () => 'queued-before-hold',
    })
    const posting = next.sendMessage({ text: 'Queued POST' })
    yield* Deferred.await(admitted)
    const hostInput = yield* Effect.promise(() =>
      Promise.resolve(
        held.root.submit(
          { type: 'input', content: 'Host input', requestId: 'host-behind-hold' },
          context,
        ),
      ),
    )
    const following = followRun(held.harness, held.root.id, 'host-behind-hold', context)
    Deferred.doneUnsafe(release, Effect.void)
    yield* Effect.promise(() => Promise.resolve(sending))
    yield* Effect.promise(() => Promise.resolve(posting))
    expect(next.status).toBe('error')
    if (next.error === undefined) throw new Error('Expected parked refusal')
    expect(next.error.message).toBe(new TurnWaiting({ conversationId: held.root.id }).message)
    expect((yield* Effect.promise(() => Promise.resolve(hostInput.status(context)))).status).toBe(
      'queued',
    )
    yield* Effect.gen(function* () {
      const awaited2 = yield* hold(held.harness, held.root.id, 'held', context)
      return yield* Effect.promise(() =>
        Promise.resolve(
          decide(held.harness, held.root.id, { holdId: awaited2, approved: true }, context),
        ),
      )
    })
    expect(
      texts(
        (yield* consumeReadable(
          yield* Effect.promise(() => Promise.resolve(following)),
          Option.none(),
        )).message,
      ),
    ).toEqual(['Host answered.'])
  }),
)
