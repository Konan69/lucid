import { applyImmutable, assertValidOp, type Op } from '@earendil-works/chord/delta'
import {
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
  type FauxResponseFactory,
} from '@earendil-works/pi-ai/providers/faux'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import type {
  ConversationId,
  ConversationView,
  EntryId,
  EntryRecord,
} from '@earendil-works/pi-durable'
import { describe, expect, it } from '@effect/vitest'
import { ConversationFrame, ConversationState, emptyConversation, ThreadId } from '@vivid/contracts'
import { Deferred, Effect, Option, Schema } from 'effect'
import * as TestClock from 'effect/testing/TestClock'
import { databaseConfigured } from '../../tests/database.ts'
import { held } from '../../tests/process.ts'
import { conversationOf, pi } from '../threads.ts'
import { transcript } from './link.ts'
import {
  ada,
  admit,
  delivery,
  grace,
  scenario,
  settled,
  threadPath,
  untilResting,
  type Runtime,
} from '../../tests/requests.ts'

const decodeState = Schema.decodeUnknownEffect(ConversationState)

const isEntryId = (value: number): value is EntryId => Number.isSafeInteger(value)
const isConversationId = (value: number): value is ConversationId => Number.isSafeInteger(value)
const stub = (id: number): EntryRecord => {
  const conversationId = 1
  if (!isEntryId(id) || !isConversationId(conversationId)) return expect.fail('ids are integers')
  return { id, conversationId, kind: 'pi.user' }
}
const viewOf = (entries: ReadonlyArray<EntryRecord>): ConversationView => {
  const id = 1
  if (!isConversationId(id)) return expect.fail('ids are integers')
  return { conversation: { id }, entries, docs: {} }
}
type Link = Effect.Success<ReturnType<Runtime['link']>>

/** The whole state by the plain read, which keeps no link. */
const read = Effect.fn('LinkTest.read')(function* (runtime: Runtime, threadId: string) {
  const response = yield* runtime.send(`${threadPath(ada, threadId)}/state`, { method: 'GET' })
  expect(response.status).toBe(200)
  return yield* decodeState(response.body)
})

/** Whether a state says the reply is over and recorded: not working, and the reply has its times. */
const settledIn = (state: ConversationState) =>
  !state.working &&
  state.messages.some((message) => message.role === 'assistant' && message.metadata !== undefined)

/**
 * Read a link as a screen does: take the whole state, then apply each frame of changes with the
 * library that made them, until `until` holds. Every frame has already been decoded with the
 * contract's schema by the fixture.
 */
const replay = Effect.fn('LinkTest.replay')(function* (
  link: Link,
  from: Option.Option<ConversationState>,
  until: (state: ConversationState) => boolean,
) {
  let state = from
  const frames: Array<ConversationFrame> = []
  for (;;) {
    if (Option.isSome(state) && until(state.value)) return { state: state.value, frames }
    const frame = yield* link.frame
    frames.push(frame)
    state = Option.some(
      ConversationFrame.match(frame, {
        Whole: (whole) => whole.state,
        Changes: ({ ops }) => {
          for (const op of ops) assertValidOp(op)
          const valid: ReadonlyArray<Op> = ops.filter((op): op is Op => Array.isArray(op))
          return applyImmutable(Option.getOrUndefined(state), valid)
        },
      }),
    )
  }
})

describe.skipIf(!databaseConfigured)('the state link', () => {
  it.effect('sends the whole state, then the changes of a reply with a tool call', () =>
    scenario((given, runtime) =>
      Effect.gen(function* () {
        const first = yield* held('unused')
        const working: FauxResponseFactory = (context, options, state, model) =>
          Promise.resolve(first.factory(context, options, state, model)).then(() =>
            fauxAssistantMessage(
              [fauxText('Looking.'), fauxToolCall('activate_skill', { name: 'deep-research' })],
              { stopReason: 'toolUse' },
            ),
          )
        given.faux.setResponses([working, fauxAssistantMessage('Found it.')])
        const receipt = yield* admit(runtime, ada, delivery('thread-1', 'key-1'))
        yield* first.entered

        const link = yield* runtime.link(`${threadPath(ada, 'thread-1')}/state`)
        expect([link.status, link.contentType]).toEqual([200, 'text/event-stream'])
        const opening = yield* link.frame
        if (!ConversationFrame.guards.Whole(opening)) return expect.fail('a link opens whole')
        expect(opening.state).toMatchObject({
          messages: [
            {
              role: 'user',
              submissionId: String(receipt.submissionId),
              parts: [{ type: 'text', text: 'hello', state: 'done' }],
            },
          ],
          settlements: [],
          working: true,
          queued: 0,
        })
        yield* first.release
        const { state, frames } = yield* replay(link, Option.some(opening.state), settledIn)
        // Every later frame was a change, and applying them is the state a plain read gives.
        expect(frames.every(ConversationFrame.guards.Changes)).toBe(true)
        expect(state).toEqual(yield* read(runtime, 'thread-1'))
        expect(state.settlements).toEqual([
          {
            submissionId: String(receipt.submissionId),
            outcome: 'completed',
            answeredBy: String(receipt.submissionId),
          },
        ])
        expect(state.messages.map((message) => message.role)).toEqual(['user', 'assistant'])
        expect(state.messages[1]).toMatchObject({
          submissionId: String(receipt.submissionId),
          parts: [
            { type: 'text', text: 'Looking.', state: 'done' },
            {
              type: 'dynamic-tool',
              toolName: 'activate_skill',
              state: 'output-available',
              input: { name: 'deep-research' },
            },
            { type: 'text', text: 'Found it.', state: 'done' },
          ],
        })
        return yield* link.leave
      }),
    ),
  )

  it.effect('gives a reader who joins in the middle of a reply the state as it is', () =>
    scenario((given, runtime) =>
      Effect.gen(function* () {
        const second = yield* held('Found it.')
        given.faux.setResponses([
          fauxAssistantMessage(fauxToolCall('activate_skill', { name: 'deep-research' }), {
            stopReason: 'toolUse',
          }),
          second.factory,
        ])
        yield* admit(runtime, ada, delivery('thread-1', 'key-1'))
        yield* second.entered
        const early = yield* runtime.link(`${threadPath(ada, 'thread-1')}/state`)
        const late = yield* runtime.link(`${threadPath(ada, 'thread-1')}/state`)
        const joined = yield* late.frame
        // The tool round is already in the reply; nothing is replayed to get there.
        expect(joined).toMatchObject({
          state: {
            working: true,
            messages: [
              { role: 'user' },
              { role: 'assistant', parts: [{ state: 'output-available' }] },
            ],
          },
        })
        expect(yield* early.frame).toEqual(joined)
        yield* second.release
        const ended = yield* replay(
          late,
          ConversationFrame.guards.Whole(joined) ? Option.some(joined.state) : Option.none(),
          settledIn,
        )
        expect(ended.state).toEqual(yield* read(runtime, 'thread-1'))
        yield* early.leave
        yield* late.leave
      }),
    ),
  )

  it.effect(
    'follows a Thread from before its first message, and says it is alive while quiet',
    () =>
      scenario((given, runtime) =>
        Effect.gen(function* () {
          given.faux.setResponses([fauxAssistantMessage('hi')])
          expect(yield* read(runtime, 'thread-1')).toEqual(emptyConversation)
          const link = yield* runtime.link(`${threadPath(ada, 'thread-1')}/state`)
          expect(yield* link.frame).toEqual(
            ConversationFrame.cases.Whole.make({ state: emptyConversation }),
          )
          yield* TestClock.adjust('15 seconds')
          expect(yield* link.event).toEqual(Option.some(': alive'))
          const receipt = yield* admit(runtime, ada, delivery('thread-1', 'key-1'))
          const { state } = yield* replay(link, Option.some(emptyConversation), settledIn)
          expect(state).toEqual(yield* read(runtime, 'thread-1'))
          expect(yield* settled(runtime, ada, 'thread-1', receipt.submissionId)).toMatchObject({
            reply: 'hi',
          })
          yield* link.leave
        }),
      ),
  )

  it.effect(
    'gives a reader who fell far behind everything that was said, across a reset',
    () =>
      scenario((given, runtime) =>
        Effect.gen(function* () {
          const later = Array.from({ length: 40 }, (_, index) => index + 2)
          given.faux.setResponses(
            [1, ...later, 99].map((turn) => fauxAssistantMessage(`reply ${turn}`)),
          )
          const say = (turn: number) =>
            Effect.gen(function* () {
              const receipt = yield* admit(
                runtime,
                ada,
                delivery('thread-1', `key-${turn}`, { body: `message ${turn}`, turn }),
              )
              yield* settled(runtime, ada, 'thread-1', receipt.submissionId)
            })
          yield* say(1)
          const link = yield* runtime.link(`${threadPath(ada, 'thread-1')}/state`)
          const opening = yield* link.frame
          if (!ConversationFrame.guards.Whole(opening)) return expect.fail('a link opens whole')
          // The reader stops reading. Far more is committed than the link and Pi's watch hold
          // for it, so Pi replaces what it had queued with its newest view.
          yield* Effect.forEach(later, say, { discard: true })
          // Then the context starts over: Pi's view no longer carries anything said so far.
          yield* runtime.persons.use(ada, ({ harness }) =>
            Effect.gen(function* () {
              const conversation = yield* conversationOf(harness, ThreadId.make('thread-1'))
              if (Option.isNone(conversation)) return yield* Effect.void
              return yield* pi(() => conversation.value.reset(undefined, BACKGROUND_CONTEXT))
            }),
          )
          yield* say(99)
          yield* runtime.persons.use(ada, (person) => person.quiet)
          const expected = yield* read(runtime, 'thread-1')
          expect(expected.messages).toHaveLength(84)
          // The reader comes back. What it replays is what a new reader is given.
          const { state } = yield* replay(
            link,
            Option.some(opening.state),
            (current) =>
              current.messages.length >= expected.messages.length &&
              current.messages.every(
                (message) => message.role !== 'assistant' || message.metadata !== undefined,
              ),
          )
          expect(state).toEqual(expected)
          return yield* link.leave
        }),
      ),
    30_000,
  )

  it.effect('says a reply failed in the same change that says it is over', () =>
    scenario((given, runtime) =>
      Effect.gen(function* () {
        const failing = yield* held(
          fauxAssistantMessage('', { stopReason: 'error', errorMessage: '401 invalid api key' }),
        )
        given.faux.setResponses([failing.factory])
        const receipt = yield* admit(runtime, ada, delivery('thread-1', 'key-1'))
        yield* failing.entered
        const link = yield* runtime.link(`${threadPath(ada, 'thread-1')}/state`)
        const opening = yield* link.frame
        if (!ConversationFrame.guards.Whole(opening)) return expect.fail('a link opens whole')
        yield* failing.release
        // The first state that is no longer working: nothing later has to arrive for a screen
        // to know how the reply ended.
        const { state } = yield* replay(
          link,
          Option.some(opening.state),
          (current) => !current.working,
        )
        expect(state.settlements).toEqual([
          { submissionId: String(receipt.submissionId), outcome: 'failed' },
        ])
        expect(state.messages.at(-1)).toMatchObject({
          purpose: 'advisory',
          settlement: { outcome: 'failed' },
        })
        return yield* link.leave
      }),
    ),
  )

  it.effect('reads only what is new after the first read of a transcript', () =>
    Effect.gen(function* () {
      const stored = [1, 2, 3, 4, 5].map((id) => stub(id))
      const asked: Array<unknown> = []
      const known = transcript({
        entries: (query) => {
          asked.push(query)
          const from = query.minEntryId === undefined ? 0 : query.minEntryId
          const to = query.maxEntryId === undefined ? Infinity : query.maxEntryId
          return Promise.resolve({
            items: stored.filter((entry) => entry.id >= from && entry.id <= to),
          })
        },
      })
      yield* known.take(viewOf(stored.slice(0, 3)))
      expect(known.entries.map((entry) => entry.id)).toEqual([1, 2, 3])
      // A view that shows only its newest entries, as after a reset, and nothing before them.
      yield* known.take(viewOf(stored.slice(4)))
      expect(known.entries.map((entry) => entry.id)).toEqual([1, 2, 3, 4, 5])
      expect(asked).toEqual([
        { maxEntryId: 3, order: 'ascending' },
        { minEntryId: 4, maxEntryId: 5, order: 'ascending' },
      ])
      // A view with nothing newer reads nothing.
      yield* known.take(viewOf(stored.slice(4)))
      expect(asked).toHaveLength(2)
    }),
  )

  it.effect('names the delivery whose reply answered one that joined it', () =>
    scenario((given, runtime) =>
      Effect.gen(function* () {
        const round = yield* held('unused')
        const working: FauxResponseFactory = (context, options, state, model) =>
          Promise.resolve(round.factory(context, options, state, model)).then(() =>
            fauxAssistantMessage(fauxToolCall('activate_skill', { name: 'deep-research' }), {
              stopReason: 'toolUse',
            }),
          )
        given.faux.setResponses([working, fauxAssistantMessage('both answered')])
        const first = yield* admit(runtime, ada, delivery('thread-1', 'a', { body: 'one' }))
        yield* round.entered
        const second = yield* admit(
          runtime,
          ada,
          delivery('thread-1', 'b', { body: 'two', turn: 2 }),
        )
        yield* round.release
        yield* settled(runtime, ada, 'thread-1', second.submissionId)
        const state = yield* read(runtime, 'thread-1')
        const answerer = String(first.submissionId)
        expect(state.settlements).toEqual([
          { submissionId: answerer, outcome: 'completed', answeredBy: answerer },
          { submissionId: String(second.submissionId), outcome: 'completed', answeredBy: answerer },
        ])
      }),
    ),
  )

  it.effect(
    'gives a sent message back with the key its sender made, and the model none of it',
    () =>
      scenario((given, runtime) =>
        Effect.gen(function* () {
          const heard = yield* Deferred.make<string>()
          const answer: FauxResponseFactory = (context) => {
            Deferred.doneUnsafe(heard, Effect.succeed(JSON.stringify(context.messages)))
            return fauxAssistantMessage('hi')
          }
          given.faux.setResponses([
            fauxAssistantMessage('first'),
            fauxAssistantMessage('second'),
            answer,
          ])
          const say = (body: ReturnType<typeof delivery>) =>
            Effect.gen(function* () {
              const receipt = yield* admit(runtime, ada, body)
              yield* settled(runtime, ada, 'thread-1', receipt.submissionId)
              return receipt
            })
          // A private message from a client, a shared message from a client, a message the server
          // made itself, and the first sent again with another client key.
          const sent = yield* say(delivery('thread-1', 'k-1', { clientKey: 'CLIENT-KEY-ONE' }))
          yield* say(
            delivery('thread-1', 'k-2', {
              attributes: { from: 'Grace', turn: '2' },
              turn: 2,
              clientKey: 'CLIENT-KEY-TWO',
            }),
          )
          yield* say(delivery('thread-1', 'k-3', { body: 'no key', turn: 3 }))
          expect(
            yield* admit(
              runtime,
              ada,
              delivery('thread-1', 'k-1', { clientKey: 'CLIENT-KEY-LATE' }),
            ),
          ).toEqual({ submissionId: sent.submissionId, repeated: true })

          const state = yield* read(runtime, 'thread-1')
          expect(
            state.messages
              .filter((message) => message.role !== 'assistant')
              .map((message) => [message.purpose, message.key]),
          ).toEqual([
            ['user', 'CLIENT-KEY-ONE'],
            ['dispatch', 'CLIENT-KEY-TWO'],
            ['user', undefined],
          ])
          expect(state.messages.filter((message) => message.role === 'assistant')).toSatisfy(
            (replies: ReadonlyArray<{ readonly key?: string }>) =>
              replies.every((reply) => reply.key === undefined),
          )
          // Everything the provider was given for the last request, earlier messages included.
          expect(yield* Deferred.await(heard)).not.toContain('CLIENT-KEY')
        }),
      ),
  )

  it.effect('lets the Person rest once the last reader has gone', () =>
    scenario((given, runtime) =>
      Effect.gen(function* () {
        given.faux.setResponses([fauxAssistantMessage('hi')])
        const receipt = yield* admit(runtime, ada, delivery('thread-1', 'key-1'))
        yield* settled(runtime, ada, 'thread-1', receipt.submissionId)
        const link = yield* runtime.link(`${threadPath(ada, 'thread-1')}/state`)
        yield* link.frame
        // While the link is read the Person is held; the countdown to close starts only after.
        yield* link.leave
        yield* untilResting(runtime, ada)
        expect(yield* link.event).toEqual(Option.none())
      }),
    ),
  )

  it.effect('serves a picture a Person sent under the address its message carries', () =>
    scenario((given, runtime) =>
      Effect.gen(function* () {
        const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3])
        given.faux.setResponses([fauxAssistantMessage('a picture')])
        const receipt = yield* admit(
          runtime,
          ada,
          delivery('thread-1', 'key-1', {
            body: 'what is this?',
            attachments: [{ type: 'image', data: bytes.toString('base64'), mimeType: 'image/png' }],
          }),
        )
        yield* settled(runtime, ada, 'thread-1', receipt.submissionId)
        const state = yield* read(runtime, 'thread-1')
        const [message] = state.messages
        const file =
          message === undefined ? undefined : message.parts.find((part) => part.type === 'file')
        if (file === undefined || file.type !== 'file' || file.url === undefined)
          return expect.fail('the message carries its picture')
        expect(JSON.stringify(state)).not.toContain(bytes.toString('base64'))
        const served = yield* runtime.bytes(`${threadPath(ada, 'thread-1')}/${file.url}`)
        expect(served).toEqual({ status: 200, contentType: 'image/png', bytes })
        // Not a picture, not a name at all, and nothing in another Person's store.
        for (const path of [
          `${threadPath(ada, 'thread-1')}/attachments/1-0`,
          `${threadPath(ada, 'thread-1')}/attachments/nonsense`,
        ])
          expect(yield* runtime.send(path, { method: 'GET' })).toEqual({
            status: 404,
            body: { error: 'NotFound' },
          })
        expect(
          yield* runtime.send(`${threadPath(grace, 'thread-1')}/${file.url}`, { method: 'GET' }),
        ).toEqual({ status: 404, body: { error: 'UnknownThread' } })
        return yield* Effect.void
      }),
    ),
  )

  it.effect('refuses a reader without the runtime token', () =>
    scenario((_given, runtime) =>
      Effect.gen(function* () {
        expect(
          yield* runtime.send(`${threadPath(ada, 'thread-1')}/state`, {
            method: 'GET',
            token: 'wrong',
          }),
        ).toEqual({ status: 401, body: { error: 'Unauthorized' } })
      }),
    ),
  )
})
