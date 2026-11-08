import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux'
import { describe, expect, it } from '@effect/vitest'
import { ConversationState, RuntimeSearchAnswer, ThreadId } from '@vivid/contracts'
import { Array as Arr, Effect, Option, Order, Schema } from 'effect'
import {
  ada,
  admit,
  delivery,
  grace,
  scenario,
  settled,
  threadPath,
  type Runtime,
} from '../tests/requests.ts'
import type { World } from '../tests/process.ts'
import { readSaid } from './recall.ts'

const decodeAnswer = Schema.decodeUnknownEffect(RuntimeSearchAnswer)
const decodeState = Schema.decodeUnknownEffect(ConversationState)

/** One exchange in a Thread: the Person's words, Vivid's scripted reply, settled. */
const exchange = Effect.fn('RecallTest.exchange')(function* (
  given: World,
  runtime: Runtime,
  { threadId, words, reply }: { threadId: string; words: string; reply: string },
) {
  given.faux.setResponses([fauxAssistantMessage(reply)])
  const receipt = yield* admit(runtime, ada, delivery(threadId, `${threadId}-key`, { body: words }))
  yield* settled(runtime, ada, threadId, receipt.submissionId)
})

const search = Effect.fn('RecallTest.search')(function* (
  runtime: Runtime,
  person: typeof ada,
  query: string,
  threadIds: ReadonlyArray<string>,
) {
  const response = yield* runtime.send(`/persons/${person}/search`, {
    method: 'POST',
    body: { query, threadIds, limit: 10 },
  })
  expect(response.status).toBe(200)
  return (yield* decodeAnswer(response.body)).hits
})

/** The real Person cell and Pi store; the words are read where Pi keeps them, nothing mocked. */
describe('finding and reading earlier conversations', () => {
  it.effect('searches the named Threads by whole words and a last-word prefix, newest first', () =>
    scenario((given, runtime) =>
      Effect.gen(function* () {
        yield* exchange(given, runtime, {
          threadId: 'budget-thread',
          words: 'The quarterly budget for Lagos is ready',
          reply: 'I kept the budgeting notes with the plan.',
        })
        yield* exchange(given, runtime, {
          threadId: 'travel-thread',
          words: 'Book flights to Accra',
          reply: 'Flights booked.',
        })
        yield* exchange(given, runtime, {
          threadId: 'unlisted-thread',
          words: 'Budget secrets',
          reply: 'Noted.',
        })

        const listed = ['budget-thread', 'travel-thread']
        const prefix = yield* search(runtime, ada, 'budg', listed)
        // The unlisted Thread is never read, though it holds a match.
        expect(prefix.map((hit) => [hit.threadId, hit.author])).toEqual(
          expect.arrayContaining([
            ['budget-thread', 'Person'],
            ['budget-thread', 'Vivid'],
          ]),
        )
        expect(prefix).toHaveLength(2)
        const times = prefix.flatMap((hit) => (hit.at === undefined ? [] : [hit.at]))
        expect(times).toHaveLength(prefix.length)
        expect(Arr.sort(times, Order.flip(Order.String))).toEqual(times)

        // Only the last word is a prefix; earlier words match whole.
        expect(yield* search(runtime, ada, 'budg lagos', listed)).toEqual([])
        const both = yield* search(runtime, ada, 'LAGOS budg', listed)
        expect(both.map((hit) => [hit.author, hit.snippet])).toEqual([
          ['Person', 'The quarterly budget for Lagos is ready'],
        ])
        expect(yield* search(runtime, ada, '!!', listed)).toEqual([])

        // A found message has the id the Thread's state gives it, so a screen can open on it.
        const state = yield* runtime
          .send(`${threadPath(ada, 'budget-thread')}/state`, { method: 'GET' })
          .pipe(Effect.flatMap((response) => decodeState(response.body)))
        const ids = new Set(state.messages.map((message) => message.id))
        expect(prefix.every((hit) => ids.has(hit.messageId))).toBe(true)

        // Another Person's cell does not hold these Threads, whatever the request names.
        expect(yield* search(runtime, grace, 'budg', listed)).toEqual([])
      }),
    ),
  )

  it.effect('reads one Thread backward a page at a time', () =>
    scenario((given, runtime) =>
      Effect.gen(function* () {
        yield* exchange(given, runtime, {
          threadId: 'paged-thread',
          words: 'First, the venue',
          reply: 'The venue is booked.',
        })
        const thread = ThreadId.make('paged-thread')
        const newest = yield* runtime.persons.use(ada, ({ harness }) =>
          readSaid(harness, thread, Option.none(), 1),
        )
        expect(newest.messages.map((message) => [message.author, message.text])).toEqual([
          ['Vivid', 'The venue is booked.'],
        ])
        expect(newest.earlier).toEqual(Option.some(1))
        const older = yield* runtime.persons.use(ada, ({ harness }) =>
          readSaid(harness, thread, newest.earlier, 1),
        )
        expect(older.messages.map((message) => [message.author, message.text])).toEqual([
          ['Person', 'First, the venue'],
        ])
        expect(older.earlier).toEqual(Option.none())
        const never = yield* runtime.persons.use(ada, ({ harness }) =>
          readSaid(harness, ThreadId.make('never-spoken'), Option.none(), 5),
        )
        expect(never.messages).toEqual([])
      }),
    ),
  )
})
