import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import type { JsonValue } from '@earendil-works/chord'
import type { Harness } from '@earendil-works/pi-durable'
import {
  ForgetChange,
  ForgetRemaining,
  MemoryClosed,
  MemoryRetraction,
  MemoryWrite,
  type MemoryAddress,
  type MemoryClosure,
  type PersonId,
} from '@vivid/contracts'
import { Effect, Option, Predicate, Result, Schema } from 'effect'
import { LEARNING_TASK, LearningInput } from './learning.ts'
import {
  Memory,
  type MemoryConflict,
  type MemoryMissing,
  type MemoryUnavailable,
} from './memory.ts'
import { pi, threadOf, type PiRejected } from './threads.ts'

const decodeLearning = Schema.decodeUnknownOption(LearningInput)

/** Whether a learning task's input holds an exchange of this Person. */
const learnsFor = (input: JsonValue, person: PersonId) =>
  Option.exists(decodeLearning(input), ({ groups }) =>
    groups.some((group) => group.personId === person),
  )

/**
 * Stop every live learning task in this cell that holds an exchange of this Person: a learner
 * reads captured words and writes memory, so one queued before the forget could write the fact
 * back. Which exchange mentions it cannot be told from data, so all of them stop; learning is
 * opportunistic and the next conversation learns again. Pi's abort cascades to the learner's
 * child conversation (`Harness.abortTask`).
 */
const stopLearning = Effect.fn('Forget.stopLearning')(function* (
  harness: Harness,
  person: PersonId,
) {
  const inspection = yield* pi(() => harness.inspect(BACKGROUND_CONTEXT))
  const learning = inspection.tasks.filter(
    (task) =>
      task.record.kind === LEARNING_TASK &&
      !task.record.abortRequested &&
      learnsFor(task.record.input, person),
  )
  yield* Effect.forEach(learning, (task) =>
    pi(() => harness.abortTask(task.record.id, BACKGROUND_CONTEXT)),
  )
  return learning.length
})

/**
 * Work admitted before the forget whose frozen context (`deliveries.ts` `Kept`) was read with the
 * old memory: every queued or placed submission of a Thread other than the forget's own. Its
 * prompt is not rewritten under it; it is reported, and it ends on its own.
 */
const admittedElsewhere = Effect.fn('Forget.admittedElsewhere')(function* (
  harness: Harness,
  closure: MemoryClosure,
) {
  const inspection = yield* pi(() => harness.inspect(BACKGROUND_CONTEXT))
  const conversations = [...new Set(inspection.submissions.map((item) => item.conversationId))]
  const threads = yield* Effect.forEach(conversations, (id) => threadOf(harness, id))
  return [
    ...new Set(
      threads.flatMap((thread) =>
        Option.isSome(thread) && thread.value.threadId !== closure.writer
          ? [thread.value.threadId]
          : [],
      ),
    ),
  ].map((threadId) => ForgetRemaining.cases.Reply.make({ threadId }))
})

const addressOf = (change: ForgetChange): MemoryAddress =>
  ForgetChange.match(change, {
    Retract: ({ address }) => address,
    Rewrite: ({ entry }) => ({ layer: entry.layer, file: entry.file }),
  })

/** What one change did, counted on the receipt. */
type Made = 'retracted' | 'rewritten'

/**
 * Make one change at the revision the plan read. A rewrite keeps the page's citations, because
 * the other facts on it still rest on them. A refusal (the entry moved, or storage failed) leaves
 * the entry as it was and is read back below.
 */
const change = Effect.fn('Forget.change')(function* (
  person: PersonId,
  closure: MemoryClosure,
  item: ForgetChange,
) {
  const memory = yield* Memory
  return yield* ForgetChange.match<
    Effect.Effect<Made, MemoryConflict | MemoryMissing | MemoryUnavailable>
  >(item, {
    Retract: ({ address, expected }) =>
      memory
        .delete(person, MemoryRetraction.make({ address, expected, authority: closure.authority }))
        .pipe(Effect.as<Made>('retracted')),
    Rewrite: ({ entry, expected }) =>
      Effect.gen(function* () {
        const before = yield* memory.read(person, addressOf(item))
        yield* memory.write(
          person,
          MemoryWrite.make({
            entry,
            expected,
            authority: closure.authority,
            citations: before.citations,
          }),
        )
        const made: Made = 'rewritten'
        return made
      }),
  }).pipe(Effect.option)
})

/**
 * Whether the entry now says what the forget left: absent after a retraction, the new body after
 * a rewrite. Anything else, including memory that cannot be read, still holds the fact.
 */
const stillThere = Effect.fn('Forget.stillThere')(function* (person: PersonId, item: ForgetChange) {
  const memory = yield* Memory
  const read = yield* Effect.result(memory.read(person, addressOf(item)))
  return ForgetChange.match(item, {
    Retract: () =>
      !Result.match(read, {
        onSuccess: () => false,
        onFailure: Predicate.isTagged('MemoryMissing'),
      }),
    Rewrite: ({ entry }) =>
      !Result.match(read, {
        onSuccess: (saved) => saved.body === entry.body,
        onFailure: () => false,
      }),
  })
})

/**
 * The cell's part of a forget, after the server stopped the Watches and owed records: stop
 * learning first so nothing writes the fact back while it is removed, change each entry, read
 * every one back, then name the admitted work still holding the old memory. Repeating it after a
 * crash converges: stopped learning stays stopped, a retracted entry reads as missing, and a
 * rewrite already made reads back as made.
 */
export const closeMemory: (
  harness: Harness,
  person: PersonId,
  closure: MemoryClosure,
) => Effect.Effect<MemoryClosed, PiRejected, Memory> = Effect.fn('Forget.closeMemory')(function* (
  harness: Harness,
  person: PersonId,
  closure: MemoryClosure,
) {
  const learning = yield* stopLearning(harness, person)
  const outcomes = yield* Effect.forEach(closure.changes, (item) => change(person, closure, item))
  const left = yield* Effect.filter(closure.changes, (item) => stillThere(person, item))
  const replies = yield* admittedElsewhere(harness, closure)
  const made = outcomes.flatMap((outcome) => Option.toArray(outcome))
  return MemoryClosed.make({
    retracted: made.filter((outcome) => outcome === 'retracted').length,
    rewritten: made.filter((outcome) => outcome === 'rewritten').length,
    learning,
    remaining: [
      ...left.map((item) => ForgetRemaining.cases.Entry.make({ address: addressOf(item) })),
      ...replies,
    ],
  })
})
