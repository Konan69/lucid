import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import { describe, expect, it } from '@effect/vitest'
import {
  ConversationState,
  ForgetChange,
  ForgetRemaining,
  MemoryAddress,
  MemoryAuthority,
  MemoryCitation,
  MemoryClosed,
  MemoryClosure,
  MemoryEntry,
  MemoryFile,
  MemoryForgetId,
  MemoryRevision,
  MemoryScope,
  MemorySource,
  MemoryTaskId,
  MemoryWrite,
  MessageId,
  ThreadId,
} from '@vivid/contracts'
import { Array as Arr, Deferred, Effect, Layer, Option, Schema } from 'effect'
import { DecisionModel } from 'effect/ai'
import { held, start, world } from '../tests/process.ts'
import { ada, admit, delivery, settled, threadPath, type Runtime } from '../tests/requests.ts'
import { LEARNING_TASK } from './learning.ts'
import { pi } from './threads.ts'

const THREAD = 'forget-proof'
const BUSY = 'forget-busy'
const address = MemoryAddress.make({ layer: 'memory', file: MemoryFile.make('tea.md') })
const decodeState = Schema.decodeUnknownEffect(ConversationState)
const decodeClosed = Schema.decodeUnknownEffect(MemoryClosed)
const decodeMessage = Schema.decodeUnknownEffect(MessageId)

/** Learning's one external decision, answered by the case: never, or only once it is released. */
const decisions = (gate: Deferred.Deferred<void>) =>
  Layer.effect(
    DecisionModel.DecisionModel,
    DecisionModel.make({
      decide: () =>
        Deferred.await(gate).pipe(
          Effect.as({
            answers: { keep: { _tag: 'Probability' as const, probability: 0 } },
            usage: { inputTokens: undefined, outputTokens: undefined },
          }),
        ),
    }),
  )

/** The forget's cell half, sent the way the server's `CellMemory.close` sends it. */
const close = Effect.fn('ForgetProof.close')(function* (
  runtime: Runtime,
  changes: MemoryClosure['changes'],
) {
  const response = yield* runtime.send(`/persons/${ada}/memory/forget`, {
    method: 'POST',
    body: MemoryClosure.make({
      changes,
      authority: MemoryAuthority.make({
        actor: ada,
        source: MemorySource.cases.Forget.make({ forgetId: MemoryForgetId.make('forget-proof') }),
      }),
      writer: ThreadId.make(THREAD),
    }),
  })
  expect(response.status).toBe(200)
  return yield* decodeClosed(response.body)
})

/** Live learning tasks for this cell, read from Pi's own task records. */
const learningTasks = (runtime: Runtime) =>
  runtime.persons.use(ada, (person) =>
    pi(() =>
      person.harness.commit((tx) => tx.scanTasks({ kind: LEARNING_TASK }, 100), BACKGROUND_CONTEXT),
    ),
  )

describe('forgetting in the Person cell', () => {
  it.effect('a reply’s memory cites the message it answers, and the closure removes it', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const gate = yield* Deferred.make<void>()
        const given = { ...(yield* world()), decisions: decisions(gate) }
        given.faux.setResponses([
          fauxAssistantMessage(
            fauxToolCall('write_memory', {
              summary: 'Keep the preference',
              file: 'tea.md',
              expected_revision: 0,
              kind: 'preference',
              basis: 'said',
              description: 'Prefers green tea',
              body: 'Ada prefers green tea.',
            }),
            { stopReason: 'toolUse' },
          ),
          fauxAssistantMessage('Saved.'),
        ])
        const runtime = yield* start(given)
        const receipt = yield* admit(
          runtime,
          ada,
          delivery(THREAD, 'tea', { body: 'Remember that I prefer green tea.' }),
        )
        yield* settled(runtime, ada, THREAD, receipt.submissionId)
        const saved = yield* runtime.memory.read(ada, address)
        const state = yield* decodeState(
          (yield* runtime.send(`${threadPath(ada, THREAD)}/state`, { method: 'GET' })).body,
        )
        const said = state.messages.filter((message) => message.purpose === 'user')
        expect(said).toHaveLength(1)
        const messageId = yield* decodeMessage(said.map((message) => message.id).join())
        // The citation names the Person's message exactly as the conversation names it.
        expect(saved.citations).toEqual([
          MemoryCitation.cases.Run.make({ source: saved.authority.source }),
          MemoryCitation.cases.ThreadMessage.make({
            threadId: ThreadId.make(THREAD),
            messageId,
          }),
        ])
        expect(saved.scope).toEqual(MemoryScope.cases.Personal.make({}))

        const closed = yield* close(runtime, [
          ForgetChange.cases.Retract.make({ address, expected: saved.revision }),
        ])
        expect(closed).toMatchObject({ retracted: 1, rewritten: 0, remaining: [] })
        const gone = yield* Effect.flip(runtime.memory.read(ada, address))
        expect(gone._tag).toBe('MemoryMissing')
        // Repeating the closure converges: nothing is retracted twice and nothing remains.
        expect(
          yield* close(runtime, [
            ForgetChange.cases.Retract.make({ address, expected: saved.revision }),
          ]),
        ).toMatchObject({ retracted: 0, remaining: [] })
        yield* Deferred.succeed(gate, undefined)
      }),
    ),
  )

  it.effect('stops queued learning and names a reply still answering with the old memory', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const gate = yield* Deferred.make<void>()
        const given = { ...(yield* world()), decisions: decisions(gate) }
        const busy = yield* held('Still answering.')
        given.faux.setResponses([fauxAssistantMessage('Okay.'), busy.factory])
        const runtime = yield* start(given)
        const source = MemorySource.cases.ThreadRun.make({
          threadId: ThreadId.make(THREAD),
          taskId: MemoryTaskId.make(1),
        })
        const saved = yield* runtime.memory.write(
          ada,
          MemoryWrite.make({
            entry: MemoryEntry.make({
              layer: 'memory',
              file: address.file,
              kind: 'preference',
              description: 'Prefers green tea',
              body: 'Ada prefers green tea.',
              basis: 'said',
              scope: MemoryScope.cases.Personal.make({}),
            }),
            expected: MemoryRevision.make(0),
            authority: MemoryAuthority.make({ actor: ada, source }),
            citations: [MemoryCitation.cases.Run.make({ source })],
          }),
        )
        // A settled exchange queues learning; its decision is held, so the task stays live.
        const first = yield* admit(runtime, ada, delivery(THREAD, 'chat', { body: 'Hi.' }))
        yield* settled(runtime, ada, THREAD, first.submissionId)
        yield* runtime.persons.use(ada, (person) => person.quiet)
        expect(
          (yield* learningTasks(runtime)).items.filter((task) => task.state.status !== 'terminal'),
        ).toHaveLength(1)
        // Another Thread is mid-reply, its context read before the forget.
        yield* admit(runtime, ada, delivery(BUSY, 'busy', { body: 'What do I drink?' }))
        yield* busy.entered

        const closed = yield* close(runtime, [
          ForgetChange.cases.Retract.make({ address, expected: saved.revision }),
        ])
        expect(closed).toEqual(
          MemoryClosed.make({
            retracted: 1,
            rewritten: 0,
            learning: 1,
            remaining: [ForgetRemaining.cases.Reply.make({ threadId: ThreadId.make(BUSY) })],
          }),
        )
        yield* busy.release
        const task = Option.getOrThrow(Arr.head((yield* learningTasks(runtime)).items))
        const ended = yield* runtime.persons.use(ada, (person) =>
          pi(() => person.harness.waitForTask(task.id, BACKGROUND_CONTEXT)),
        )
        expect(ended.state.outcome.status).toBe('aborted')
        yield* Deferred.succeed(gate, undefined)
      }),
    ),
  )
})
