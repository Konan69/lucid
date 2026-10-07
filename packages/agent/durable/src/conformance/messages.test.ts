import { Deferred, Effect, Option, Fiber } from 'effect'
import { FixtureFailed } from '../fixtures/harness.ts'
import { consumeReadable } from '../fixtures/reading.ts'
import { runForPi } from '../pi.ts'
import { expect, it } from '@effect/vitest'
import { tool, type UIMessage } from 'ai'
import { z } from 'zod'
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux'
import {
  AssistantEntry,
  UserEntry,
  GenerationTask,
  defineExtension,
  hook,
} from '@earendil-works/pi-durable'
import { PlainChat } from '../fixtures/chat.ts'
import { continueRun, followRun, history, RunMissing } from '../main.ts'
import { call, context, host } from './fixtures/host.ts'
/** IDs must agree as lists are reloaded, not merely have the right prefix. */
function savedAssistant(messages: readonly UIMessage[]) {
  const message = messages.findLast((item) => item.role === 'assistant')
  if (message === undefined) throw new Error('Expected stored assistant')
  return message
}
/** The cursor lies between two consecutive user entries; assistant identity must come from
 * its own first assistant, never the user's position or which page began the stretch. */
it.live('keeps generation identity when a page boundary falls inside a user block', () =>
  Effect.gen(function* () {
    const fixture = yield* host({}, {})
    const opened = yield* fixture.open()
    yield* Effect.promise(() =>
      opened.root.commit(
        (tx) =>
          tx.appendEntry(UserEntry, opened.root.id, {
            model: [{ role: 'user', content: 'Earlier', timestamp: 1 }],
          }),
        context,
      ),
    )
    opened.faux.setResponses([fauxAssistantMessage('Answer.')])
    const chat = new PlainChat({ transport: opened.transport })
    yield* Effect.promise(() => chat.sendMessage({ text: 'Current' }))
    const page = yield* Effect.promise(() =>
      history(opened.harness, opened.root.id, { limit: 2 }, context),
    )
    if (chat.lastMessage === undefined || page.next === undefined) throw new Error('Expected page')
    expect(page.messages.map((message) => message.role)).toEqual(['user', 'assistant'])
    expect(savedAssistant(page.messages).id).toBe(chat.lastMessage.id)
    const previous = yield* Effect.promise(() =>
      history(opened.harness, opened.root.id, { limit: 2, before: page.next }, context),
    )
    expect(previous.messages.map((message) => message.role)).toEqual(['user'])
    const whole = yield* Effect.promise(() =>
      history(opened.harness, opened.root.id, { limit: 10 }, context),
    )
    expect(savedAssistant(whole.messages).id).toBe(chat.lastMessage.id)
  }),
)
/** A queued successor gets its own generation id, shared by live Chat and stored followRun.
 * Gates hold the predecessor at the provider boundary; no token-rate timer admits the successor. */
it.live('keeps queued live, stored followRun and paged history assistant identities equal', () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void, FixtureFailed>()
    const release = yield* Deferred.make<void, FixtureFailed>()
    const secondEntered = yield* Deferred.make<void, FixtureFailed>()
    const secondRelease = yield* Deferred.make<void, FixtureFailed>()
    yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined))
    yield* Effect.addFinalizer(() => Deferred.succeed(secondRelease, undefined))
    const fixture = yield* host({}, {})
    const opened = yield* fixture.open()
    opened.faux.setResponses([
      () =>
        runForPi(
          Effect.gen(function* () {
            Deferred.doneUnsafe(entered, Effect.void)
            yield* Deferred.await(release)
            return fauxAssistantMessage('First.')
          }),
          undefined,
        ),
      () =>
        runForPi(
          Effect.gen(function* () {
            Deferred.doneUnsafe(secondEntered, Effect.void)
            yield* Deferred.await(secondRelease)
            return fauxAssistantMessage('Second.')
          }),
          undefined,
        ),
    ])
    const first = new PlainChat({ transport: opened.transport })
    const firstTurn = first.sendMessage({ text: 'First' })
    yield* Deferred.await(entered)
    const input = yield* Effect.promise(() =>
      opened.root.submit({ type: 'input', content: 'Second', requestId: 'queued' }, context),
    )
    expect((yield* Effect.promise(() => input.status(context))).status).toBe('queued')
    const second = new PlainChat({ transport: opened.transport })
    const secondTurn = second.sendMessage({
      id: 'queued',
      role: 'user',
      parts: [{ type: 'text', text: 'Second' }],
    })
    const live = followRun(opened.harness, opened.root.id, 'queued', context)
    Deferred.doneUnsafe(release, Effect.void)
    yield* Effect.promise(() => firstTurn)
    yield* Deferred.await(secondEntered)
    const reading = yield* consumeReadable(yield* Effect.promise(() => live), Option.none()).pipe(
      Effect.forkScoped,
    )
    Deferred.doneUnsafe(secondRelease, Effect.void)
    const observed = yield* Fiber.join(reading)
    yield* Effect.promise(() => secondTurn)
    const stored = yield* consumeReadable(
      yield* Effect.promise(() => followRun(opened.harness, opened.root.id, 'queued', context)),
      Option.none(),
    )
    const page = yield* Effect.promise(() =>
      history(opened.harness, opened.root.id, { limit: 1 }, context),
    )
    if (second.lastMessage === undefined) throw new Error('Expected live assistant')
    expect(second.status).toBe('ready')
    expect(observed.message.id).toBe(second.lastMessage.id)
    expect(stored.message.id).toBe(second.lastMessage.id)
    expect(savedAssistant(page.messages).id).toBe(second.lastMessage.id)
    const complete = yield* Effect.promise(() =>
      history(opened.harness, opened.root.id, { limit: 10 }, context),
    )
    if (first.lastMessage === undefined) throw new Error('Expected first assistant')
    expect(
      complete.messages
        .filter((message) => message.role === 'assistant')
        .map((message) => message.id),
    ).toEqual([first.lastMessage.id, second.lastMessage.id])
    second.messages = complete.messages
    expect(second.messages.filter((message) => message.id === stored.message.id)).toHaveLength(1)
  }),
)
/** Steers and hook continuations extend the live run but create separate stored stretches.
 * Their first stretch shares the live id; a later generation cannot rename it or reuse it. */
it.live.each(['steer', 'continuation'] as const)(
  'keeps the first %s stretch on the live generation id',
  (mode) =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void, FixtureFailed>()
      const release = yield* Deferred.make<void, FixtureFailed>()
      yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined))
      const fixture = yield* host(
        {
          work: tool({
            inputSchema: z.object({}),
            execute: () =>
              runForPi(
                Effect.gen(function* () {
                  Deferred.doneUnsafe(entered, Effect.void)
                  yield* Deferred.await(release)
                  return 'Worked.'
                }),
                undefined,
              ),
          }),
        },
        {},
      )
      const opened = yield* fixture.open([
        defineExtension({
          name: 'continued',
          hooks: [
            hook(GenerationTask, {
              onYield: (message) =>
                mode === 'continuation' &&
                message.content.some((part) => part.type === 'text' && part.text === 'First.')
                  ? { continue: 'Continue' }
                  : undefined,
            }),
          ],
        }),
      ])
      opened.faux.setResponses([
        mode === 'steer' ? call('work', {}, 'work') : fauxAssistantMessage('First.'),
        fauxAssistantMessage('Final.'),
      ])
      const chat = new PlainChat({ transport: opened.transport })
      const sending = chat.sendMessage({ text: 'Start' })
      if (mode === 'steer') {
        yield* Deferred.await(entered)
        yield* Effect.promise(() =>
          opened.root.submit(
            { type: 'input', content: 'Steer', requestId: 'steer', whenBusy: 'steer' },
            context,
          ),
        )
        Deferred.doneUnsafe(release, Effect.void)
      }
      yield* Effect.promise(() => sending)
      const saved = yield* Effect.promise(() =>
        history(opened.harness, opened.root.id, { limit: 10 }, context),
      )
      const assistants = saved.messages.filter((message) => message.role === 'assistant')
      if (chat.lastMessage === undefined || assistants[0] === undefined)
        throw new Error('Expected assistants')
      expect(assistants).toHaveLength(2)
      expect(assistants[0].id).toBe(chat.lastMessage.id)
      expect(new Set(saved.messages.map((message) => message.id)).size).toBe(saved.messages.length)
      expect(chat.messages.filter((message) => message.role === 'assistant')).toHaveLength(1)
    }),
)
/** A closed queued run has attribution, but T-1 is not its receipt. Refuse that client resume
 * instead of searching adjacent ids; host-admitted followRun still supplies its stored outcome. */
it.live('refuses a closed queued generation when its one receipt candidate does not verify', () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void, FixtureFailed>()
    const release = yield* Deferred.make<void, FixtureFailed>()
    yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined))
    const fixture = yield* host(
      {
        work: tool({
          inputSchema: z.object({}),
          execute: () => runForPi(Effect.succeed('Worked.'), undefined),
        }),
      },
      {},
    )
    const opened = yield* fixture.open()
    opened.faux.setResponses([
      () =>
        runForPi(
          Effect.gen(function* () {
            Deferred.doneUnsafe(entered, Effect.void)
            yield* Deferred.await(release)
            return fauxAssistantMessage('First.')
          }),
          undefined,
        ),
      call('work', {}, 'queued-call'),
      fauxAssistantMessage('Done.'),
    ])
    yield* Effect.promise(() =>
      opened.root.submit({ type: 'input', content: 'First', requestId: 'first' }, context),
    )
    yield* Deferred.await(entered)
    yield* Effect.promise(() =>
      opened.root.submit({ type: 'input', content: 'Queued', requestId: 'queued' }, context),
    )
    Deferred.doneUnsafe(release, Effect.void)
    yield* Effect.promise(() => opened.root.waitForIdle(context))
    const result = yield* consumeReadable(
      yield* Effect.promise(() => followRun(opened.harness, opened.root.id, 'queued', context)),
      Option.none(),
    )
    expect(result.message.id).toMatch(/^gen:/u)
    const rejection1 = yield* Effect.tryPromise({
      try: () =>
        continueRun(
          opened.harness,
          opened.root.id,
          { messageId: result.message.id, known: new Set(['queued-call']) },
          context,
        ),
      catch: (cause) => new FixtureFailed({ cause }),
    }).pipe(Effect.flip)
    expect(rejection1.cause).toBeInstanceOf(RunMissing)
    const rejection2 = yield* Effect.tryPromise({
      try: () =>
        continueRun(
          opened.harness,
          opened.root.id,
          { messageId: 'run:1', known: new Set(['queued-call']) },
          context,
        ),
      catch: (cause) => new FixtureFailed({ cause }),
    }).pipe(Effect.flip)
    expect(rejection2.cause).toBeInstanceOf(RunMissing)
  }),
)
/** generation.failNoModel writes no assistant (generation.js:235–244). Stored replay has no
 * task provenance to claim: the SDK honestly sees an empty input:<entry> assistant, and gen resume
 * cannot verify it. No task result or neighboring receipt is consulted. */
it.live(
  'names an empty failed stored run from its input entry and refuses its generation resume',
  () =>
    Effect.gen(function* () {
      const fixture = yield* host({}, {})
      const opened = yield* fixture.open()
      yield* Effect.promise(() =>
        opened.root.configure({ model: { provider: 'missing', modelId: 'missing' } }, context),
      )
      const receipt = yield* Effect.promise(() =>
        opened.root.submit({ type: 'input', content: 'Go', requestId: 'empty' }, context),
      )
      yield* Effect.promise(() => opened.root.waitForIdle(context))
      const status = yield* Effect.promise(() => receipt.status(context))
      if (status.type !== 'input' || status.entry === undefined)
        throw new Error('Expected placed input')
      expect(status).toMatchObject({ status: 'unanswered', reason: 'no_model' })
      const entries = yield* Effect.promise(() => opened.root.entries({}, 100, undefined, context))
      expect(entries.items.filter((entry) => entry.kind === 'pi.assistant')).toEqual([])
      const stored = yield* consumeReadable(
        yield* Effect.promise(() => followRun(opened.harness, opened.root.id, 'empty', context)),
        Option.none(),
      )
      expect(stored.message.id).toBe(`input:${status.entry}`)
      expect(stored.message.parts).toEqual([])
      const rejection3 = yield* Effect.tryPromise({
        try: () =>
          continueRun(
            opened.harness,
            opened.root.id,
            { messageId: `gen:${receipt.id + 1}`, known: new Set() },
            context,
          ),
        catch: (cause) => new FixtureFailed({ cause }),
      }).pipe(Effect.flip)
      expect(rejection3.cause).toBeInstanceOf(RunMissing)
    }),
)
/** A host-written assistant has no task; its tagged Written branch preserves entry identity. */
it.live('keeps entry identity for a host-written assistant without generation attribution', () =>
  Effect.gen(function* () {
    const fixture = yield* host({}, {})
    const opened = yield* fixture.open()
    const entry = yield* Effect.promise(() =>
      opened.root.commit(
        (tx) =>
          tx.appendEntry(AssistantEntry, opened.root.id, {
            model: [fauxAssistantMessage('Host-written.')],
          }),
        context,
      ),
    )
    expect(entry.byTaskId).toBeUndefined()
    const page = yield* Effect.promise(() =>
      history(opened.harness, opened.root.id, { limit: 10 }, context),
    )
    expect(savedAssistant(page.messages).id).toBe(`entry:${entry.id}`)
  }),
)
