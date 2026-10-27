import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import {
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
  type FauxResponseFactory,
} from '@earendil-works/pi-ai/providers/faux'
import { getCurrentSystemPrompt, getCurrentTools } from '@earendil-works/pi-ai/utils/transcript'
import { describe, expect, it } from '@effect/vitest'
import {
  ConversationFrame,
  ConversationState,
  PersonId,
  RuntimeSettlement,
  ThreadId,
} from '@vivid/contracts'
import { Array as Arr, Deferred, Effect, Exit, Option, Schema, Scope } from 'effect'
import { held, start, world } from '../tests/process.ts'
import {
  ada,
  admit,
  decodeSettlement,
  delivery,
  grace,
  scenario,
  settled,
  threadPath,
  type Runtime,
} from '../tests/requests.ts'
import { RESPONSE_ENTRY, ResponseData, RUN_ENTRY } from './response.ts'
import { SIGNAL_ENTRY } from './delivery.ts'
import { conversationOf, pi } from './threads.ts'

const decodeResponse = Schema.decodeUnknownEffect(ResponseData)
const decodeState = Schema.decodeUnknownEffect(ConversationState)

/** A Thread's transcript, oldest first, read from the Person's store as the state link will. */
const transcript = (runtime: Runtime, person: PersonId, threadId: string) =>
  runtime.persons.use(person, ({ harness }) =>
    Effect.gen(function* () {
      const conversation = yield* conversationOf(harness, ThreadId.make(threadId))
      if (Option.isNone(conversation)) return []
      const page = yield* pi(() =>
        conversation.value.entries({ order: 'ascending' }, 200, undefined, BACKGROUND_CONTEXT),
      )
      return Array.from(page.items)
    }),
  )

describe('the runtime over HTTP', () => {
  it.effect('opens a pre-cell Thread empty and its next message starts the conversation', () =>
    scenario((given, runtime) =>
      Effect.gen(function* () {
        const path = threadPath(ada, 'pre-cell-thread')
        const response = yield* runtime.send(`${path}/state`, { method: 'GET' })
        expect(response.status).toBe(200)
        expect(yield* decodeState(response.body)).toMatchObject({ messages: [], working: false })
        const link = yield* runtime.link(`${path}/state`)
        const first = yield* link.frame
        expect(first._tag).toBe('Whole')
        if (ConversationFrame.guards.Whole(first)) expect(first.state.messages).toEqual([])
        given.faux.setResponses([() => fauxAssistantMessage('A new conversation')])
        const receipt = yield* admit(runtime, ada, delivery('pre-cell-thread', 'first-new-message'))
        expect(yield* settled(runtime, ada, 'pre-cell-thread', receipt.submissionId)).toMatchObject(
          RuntimeSettlement.cases.Done.make({
            answeredBy: receipt.submissionId,
            reply: 'A new conversation',
            toolCalls: 0,
          }),
        )
        yield* link.leave
      }),
    ),
  )

  it.effect('answers a Person and tells the model what main told it', () =>
    scenario((given, runtime) =>
      Effect.gen(function* () {
        const seen = yield* Deferred.make<{
          readonly prompt: string
          readonly tools: ReadonlyArray<string>
          readonly said: unknown
        }>()
        const answer: FauxResponseFactory = (context) => {
          Deferred.doneUnsafe(
            seen,
            Effect.succeed({
              prompt: getCurrentSystemPrompt(context.messages),
              tools: getCurrentTools(context.messages).map((tool) => tool.name),
              said: Option.getOrUndefined(
                Arr.findLast(context.messages, (message) => message.role === 'user'),
              ),
            }),
          )
          return fauxAssistantMessage('hi ada')
        }
        given.faux.setResponses([answer])
        const receipt = yield* admit(runtime, ada, delivery('thread-1', 'key-1'))
        expect(receipt.repeated).toBe(false)
        expect(yield* settled(runtime, ada, 'thread-1', receipt.submissionId)).toEqual(
          RuntimeSettlement.cases.Done.make({
            answeredBy: receipt.submissionId,
            reply: 'hi ada',
            toolCalls: 0,
          }),
        )
        const model = yield* Deferred.await(seen)
        expect(model.said).toMatchObject({ role: 'user', content: 'hello' })
        // The instruction, the context for this response and the skill catalogue, in that order,
        // each separated by one blank line and none of it wrapped in a tag.
        expect(model.prompt.startsWith('You are Vivid: one persistent teammate')).toBe(true)
        const [instruction, context, skills] = [
          model.prompt.indexOf('\nToday is '),
          model.prompt.indexOf('\n\nContext for this response (saved facts may be stale'),
          model.prompt.indexOf('\n\n## Available Skills\n\n'),
        ]
        expect(instruction).toBeGreaterThan(0)
        expect(context).toBeGreaterThan(instruction)
        expect(skills).toBeGreaterThan(context)
        expect(model.prompt).toContain(' in the UTC time zone.')
        expect(model.prompt).toContain('- **deep-research** — ')
        expect(model.prompt).not.toContain(ada)
        // Main's order: the Computer's tools, the skill tool, then the product tools.
        expect(model.tools.slice(0, 12)).toEqual([
          'read',
          'write',
          'edit',
          'bash',
          'grep',
          'glob',
          'use_desktop',
          'browse',
          'use_person_computer',
          'copy_signin',
          'activate_skill',
          'search_library',
        ])
        // The response's metadata is one entry of our own after the answer.
        yield* runtime.persons.use(ada, (person) => person.quiet)
        const entries = yield* transcript(runtime, ada, 'thread-1')
        const recorded = entries.find((entry) => entry.kind === RESPONSE_ENTRY)
        expect(entries.map((entry) => entry.kind)).toEqual([
          'pi.user',
          'pi.system',
          RUN_ENTRY,
          'pi.assistant',
          RESPONSE_ENTRY,
        ])
        expect(
          yield* decodeResponse(recorded === undefined ? undefined : recorded.data),
        ).toMatchObject({
          model: 'fixture/text',
          toolCallCount: 0,
        })
      }),
    ),
  )

  it.effect('stores long Markdown and reads every page through the note tools', () =>
    scenario((given, runtime) =>
      Effect.gen(function* () {
        const body = '# Plan\n\n' + 'A lasting detail.\n'.repeat(400) + '\nThe final detail.'
        given.faux.setResponses([
          fauxAssistantMessage(
            fauxToolCall('write_note', {
              summary: 'Remember the plan',
              layer: 'memory',
              file: 'plan.md',
              expected_revision: 0,
              basis: 'said',
              kind: 'workstream',
              description: 'The complete plan',
              note: body,
            }),
            { stopReason: 'toolUse' },
          ),
          fauxAssistantMessage(
            fauxToolCall('read_note', {
              summary: 'Read the plan',
              file: 'plan.md',
              offset: 0,
              characters: 4000,
            }),
            { stopReason: 'toolUse' },
          ),
          fauxAssistantMessage(
            fauxToolCall('read_note', {
              summary: 'Read the rest of the plan',
              file: 'plan.md',
              offset: 4000,
              characters: 4000,
            }),
            { stopReason: 'toolUse' },
          ),
          fauxAssistantMessage(
            fauxToolCall('list_notes', { summary: 'Find saved plans', layer: 'memory', limit: 1 }),
            { stopReason: 'toolUse' },
          ),
          fauxAssistantMessage(
            fauxToolCall('search_notes', { summary: 'Find the lasting detail', query: 'lasting' }),
            { stopReason: 'toolUse' },
          ),
          fauxAssistantMessage('Read the complete plan.'),
        ])
        const receipt = yield* admit(runtime, ada, delivery('long-memory', 'long-note'))
        expect(yield* settled(runtime, ada, 'long-memory', receipt.submissionId)).toMatchObject({
          toolCalls: 5,
          reply: 'Read the complete plan.',
        })
        const response = yield* runtime.send(`${threadPath(ada, 'long-memory')}/state`, {
          method: 'GET',
        })
        const state = yield* decodeState(response.body)
        const parts = state.messages.flatMap((message) => message.parts)
        expect(parts).toContainEqual(
          expect.objectContaining({
            toolName: 'search_notes',
            output: {
              entries: [
                expect.objectContaining({
                  file: 'plan.md',
                  excerpt: expect.stringContaining('lasting'),
                }),
              ],
              next_offset: null,
            },
          }),
        )
        expect(parts).toContainEqual(
          expect.objectContaining({
            toolName: 'list_notes',
            output: {
              entries: [expect.objectContaining({ layer: 'memory', file: 'plan.md' })],
              next_cursor: null,
            },
          }),
        )
        expect(parts).toContainEqual(
          expect.objectContaining({
            toolName: 'read_note',
            output: expect.objectContaining({
              note: body.slice(0, 4000),
              next_offset: 4000,
              complete: false,
              total_characters: body.length,
            }),
          }),
        )
        expect(parts).toContainEqual(
          expect.objectContaining({
            toolName: 'read_note',
            output: expect.objectContaining({
              note: body.slice(4000),
              next_offset: null,
              complete: true,
            }),
          }),
        )
      }),
    ),
  )

  it.effect('keeps suggested replies in the persisted conversation state', () =>
    scenario((given, runtime) =>
      Effect.gen(function* () {
        const replies = ['send it', 'make it shorter']
        given.faux.setResponses([
          fauxAssistantMessage(
            [fauxText('The draft is ready.'), fauxToolCall('suggest_replies', { replies })],
            { stopReason: 'toolUse' },
          ),
          fauxAssistantMessage('Ready when you are.'),
        ])
        const receipt = yield* admit(runtime, ada, delivery('thread-1', 'suggestions'))
        expect(yield* settled(runtime, ada, 'thread-1', receipt.submissionId)).toMatchObject({
          toolCalls: 1,
        })
        const response = yield* runtime.send(`${threadPath(ada, 'thread-1')}/state`, {
          method: 'GET',
        })
        expect(response.status).toBe(200)
        const state = yield* decodeState(response.body)
        expect(state.messages.flatMap((message) => message.parts)).toContainEqual(
          expect.objectContaining({
            type: 'dynamic-tool',
            toolName: 'suggest_replies',
            input: { replies },
            state: 'output-available',
            output: { ok: true },
          }),
        )
      }),
    ),
  )

  it.effect('admits one idempotency key once', () =>
    scenario((given, runtime) =>
      Effect.gen(function* () {
        given.faux.setResponses([fauxAssistantMessage('once')])
        const first = yield* admit(runtime, ada, delivery('thread-1', 'same-key'))
        const again = yield* admit(runtime, ada, delivery('thread-1', 'same-key'))
        expect(again).toEqual({ submissionId: first.submissionId, repeated: true })
        yield* settled(runtime, ada, 'thread-1', first.submissionId)
        // After it settled, too: the key still names the same submission and asks the model nothing.
        expect(yield* admit(runtime, ada, delivery('thread-1', 'same-key'))).toEqual({
          submissionId: first.submissionId,
          repeated: true,
        })
        expect(given.faux.state.callCount).toBe(1)
      }),
    ),
  )

  it.effect('places a signal as its own entry and acts for the Person its scope names', () =>
    scenario((given, runtime) =>
      Effect.gen(function* () {
        const before = yield* Deferred.make<{ readonly asked: number; readonly said: unknown }>()
        const call: FauxResponseFactory = (context) => {
          Deferred.doneUnsafe(
            before,
            Effect.succeed({
              asked: given.asked.length,
              said: Option.getOrUndefined(
                Arr.findLast(context.messages, (message) => message.role === 'user'),
              ),
            }),
          )
          return fauxAssistantMessage(
            fauxToolCall('notify_person', { summary: 'Tell them', title: 'Due', body: 'Now.' }),
            { stopReason: 'toolUse' },
          )
        }
        given.faux.setResponses([call, fauxAssistantMessage('told them')])
        const receipt = yield* admit(
          runtime,
          ada,
          delivery('shared-1', 'signal-1', {
            body: 'is <this> due?',
            attributes: { from: 'Grace "G"', turn: '4' },
            acting: grace,
            turn: 4,
          }),
        )
        expect(yield* settled(runtime, ada, 'shared-1', receipt.submissionId)).toEqual(
          RuntimeSettlement.cases.Done.make({
            answeredBy: receipt.submissionId,
            reply: 'told them',
            toolCalls: 1,
          }),
        )
        const model = yield* Deferred.await(before)
        // Escaped signal text excludes the acting Person's private scope.
        expect(model.said).toMatchObject({
          role: 'user',
          content:
            '<message type="message" from="Grace &quot;G&quot;" turn="4">\nis &lt;this&gt; due?\n</message>',
        })
        const entries = yield* transcript(runtime, ada, 'shared-1')
        expect(entries.find((entry) => entry.kind === SIGNAL_ENTRY)).toMatchObject({
          data: {
            type: 'message',
            attributes: { from: 'Grace "G"', turn: '4' },
            body: 'is <this> due?',
          },
        })
        // Exactly one product client was built after the model asked for the tool, and it was
        // built for the Person the delivery's scope names, not the Thread's creator.
        expect(given.asked.slice(model.asked)).toEqual([
          { threadId: ThreadId.make('shared-1'), personId: grace },
        ])
      }),
    ),
  )

  it.effect('joins a delivery that arrives during a response to that response', () =>
    scenario((given, runtime) =>
      Effect.gen(function* () {
        const round = yield* held('unused')
        const working: FauxResponseFactory = (context, options, state, model) =>
          Promise.resolve(round.factory(context, options, state, model)).then(() =>
            fauxAssistantMessage(fauxToolCall('activate_skill', { name: 'deep-research' }), {
              stopReason: 'toolUse',
            }),
          )
        const heard = yield* Deferred.make<ReadonlyArray<unknown>>()
        const both: FauxResponseFactory = (context) => {
          Deferred.doneUnsafe(
            heard,
            Effect.succeed(
              context.messages.flatMap((message) =>
                message.role === 'user' ? [message.content] : [],
              ),
            ),
          )
          return fauxAssistantMessage('both answered')
        }
        given.faux.setResponses([working, both])
        const first = yield* admit(runtime, ada, delivery('thread-1', 'first', { body: 'one' }))
        yield* round.entered
        const second = yield* admit(
          runtime,
          ada,
          delivery('thread-1', 'second', { body: 'two', turn: 2 }),
        )
        expect(second.submissionId).not.toBe(first.submissionId)
        yield* round.release
        const answers = yield* Effect.all([
          settled(runtime, ada, 'thread-1', first.submissionId),
          settled(runtime, ada, 'thread-1', second.submissionId),
        ])
        const answer = { answeredBy: first.submissionId, reply: 'both answered' }
        expect(answers).toEqual([
          RuntimeSettlement.cases.Done.make({ ...answer, toolCalls: 1 }),
          // The delivery that joined is answered by the whole response, tools included.
          RuntimeSettlement.cases.Done.make({ ...answer, toolCalls: 1 }),
        ])
        expect(yield* Deferred.await(heard)).toEqual(['one', 'two'])
        expect(given.faux.state.callCount).toBe(2)
      }),
    ),
  )

  it.effect('stops a response, and says so when there was none', () =>
    scenario((given, runtime) =>
      Effect.gen(function* () {
        const reply = yield* held('never said')
        given.faux.setResponses([reply.factory])
        const receipt = yield* admit(runtime, ada, delivery('thread-1', 'key-1'))
        yield* reply.entered
        expect(
          yield* runtime.send(`${threadPath(ada, 'thread-1')}/abort`, { method: 'POST' }),
        ).toEqual({ status: 200, body: { aborted: true } })
        expect(yield* settled(runtime, ada, 'thread-1', receipt.submissionId)).toEqual(
          RuntimeSettlement.cases.Stopped.make({}),
        )
        expect(
          yield* runtime.send(`${threadPath(ada, 'thread-1')}/abort`, { method: 'POST' }),
        ).toEqual({ status: 200, body: { aborted: false } })
        expect(
          yield* runtime.send(`${threadPath(ada, 'no-such-thread')}/abort`, { method: 'POST' }),
        ).toEqual({ status: 200, body: { aborted: false } })
      }),
    ),
  )

  it.effect('finishes a reply after a restart with no client attached', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const given = yield* world()
        const interrupted = yield* held('never said')
        const resumed = yield* Deferred.make<string>()
        const afterwards: FauxResponseFactory = (context) => {
          Deferred.doneUnsafe(resumed, Effect.succeed(getCurrentSystemPrompt(context.messages)))
          return fauxAssistantMessage('finished after the restart')
        }
        given.faux.setResponses([interrupted.factory, afterwards])

        const first = yield* Scope.make()
        const before = yield* start(given).pipe(Scope.provide(first))
        const receipt = yield* admit(before, ada, delivery('thread-1', 'key-1'))
        yield* interrupted.entered
        // The process stops in the middle of the model's answer.
        yield* Scope.close(first, Exit.void)

        // The next process, on the same database. Nothing is sent to it before the reply resumes.
        const after = yield* start(given)
        const prompt = yield* Deferred.await(resumed)
        // The context frozen for the response came back from the store, not from memory.
        expect(prompt).toContain('Context for this response')
        expect(prompt).toContain(' in the UTC time zone.')
        expect(yield* settled(after, ada, 'thread-1', receipt.submissionId)).toEqual(
          RuntimeSettlement.cases.Done.make({
            answeredBy: receipt.submissionId,
            reply: 'finished after the restart',
            toolCalls: 0,
          }),
        )
        // The instruction did not change across the restart: Pi wrote the system entry once.
        const entries = yield* transcript(after, ada, 'thread-1')
        expect(entries.filter((entry) => entry.kind === 'pi.system')).toHaveLength(1)
        expect(yield* admit(after, ada, delivery('thread-1', 'key-1'))).toEqual({
          submissionId: receipt.submissionId,
          repeated: true,
        })
      }),
    ),
  )

  it.effect('keeps each Person in a store of their own', () =>
    scenario((given, runtime) =>
      Effect.gen(function* () {
        given.faux.setResponses([
          fauxAssistantMessage('for ada'),
          fauxAssistantMessage('for grace'),
        ])
        const hers = yield* admit(runtime, ada, delivery('ada-thread', 'key-a'))
        yield* settled(runtime, ada, 'ada-thread', hers.submissionId)
        const theirs = yield* admit(
          runtime,
          grace,
          delivery('grace-thread', 'key-g', { creator: grace }),
        )
        yield* settled(runtime, grace, 'grace-thread', theirs.submissionId)
        // Ada's Thread does not exist in Grace's store, and cannot be put there.
        expect(
          yield* runtime.send(
            `${threadPath(grace, 'ada-thread')}/submissions/${hers.submissionId}`,
            { method: 'GET' },
          ),
        ).toEqual({ status: 404, body: { error: 'UnknownThread' } })
        expect(
          yield* runtime.send(threadPath(grace, 'ada-thread'), {
            method: 'POST',
            body: delivery('ada-thread', 'key-x'),
          }),
        ).toEqual({ status: 400, body: { error: 'WrongThread' } })
        expect(
          yield* runtime.send(threadPath(PersonId.make('not.a.name'), 'ada-thread'), {
            method: 'POST',
            body: delivery('ada-thread', 'key-y'),
          }),
        ).toMatchObject({ status: 400 })
      }),
    ),
  )

  it.effect(
    'answers a delivery that was waiting when the response it would have joined failed',
    () =>
      scenario((given, runtime) =>
        Effect.gen(function* () {
          const failing = yield* held(
            fauxAssistantMessage('', { stopReason: 'error', errorMessage: '401 invalid api key' }),
          )
          given.faux.setResponses([failing.factory, fauxAssistantMessage('for the second')])
          const first = yield* admit(runtime, ada, delivery('thread-1', 'first', { body: 'one' }))
          yield* failing.entered
          const second = yield* admit(
            runtime,
            ada,
            delivery('thread-1', 'second', { body: 'two', turn: 2 }),
          )
          yield* failing.release
          expect(yield* settled(runtime, ada, 'thread-1', first.submissionId)).toEqual(
            RuntimeSettlement.cases.Failed.make({ failure: 'ModelUnavailable', status: 401 }),
          )
          // Nothing else is sent to the Thread: the waiting delivery gets a response of its own.
          expect(yield* settled(runtime, ada, 'thread-1', second.submissionId)).toEqual(
            RuntimeSettlement.cases.Done.make({
              answeredBy: second.submissionId,
              reply: 'for the second',
              toolCalls: 0,
            }),
          )
        }),
      ),
  )

  it.effect(
    'keeps a delivery key apart from the keys the runtime writes its own entries under',
    () =>
      Effect.gen(function* () {
        // A fresh store numbers its first delivery the same way every time.
        const number = yield* scenario((given, runtime) =>
          Effect.gen(function* () {
            given.faux.setResponses([
              fauxAssistantMessage('first'),
              fauxAssistantMessage('a new delivery'),
            ])
            const first = yield* admit(runtime, ada, delivery('thread-1', 'key-1'))
            yield* settled(runtime, ada, 'thread-1', first.submissionId)
            yield* runtime.persons.use(ada, (person) => person.quiet)
            // The key of the entry the runtime has just written for that response.
            const collides = `${RESPONSE_ENTRY}:${first.submissionId}`
            const next = yield* admit(
              runtime,
              ada,
              delivery('thread-1', collides, { body: 'again', turn: 2 }),
            )
            expect(next.repeated).toBe(false)
            expect(yield* settled(runtime, ada, 'thread-1', next.submissionId)).toEqual(
              RuntimeSettlement.cases.Done.make({
                answeredBy: next.submissionId,
                reply: 'a new delivery',
                toolCalls: 0,
              }),
            )
            return first.submissionId
          }),
        )
        // The other order: the delivery takes the key first, and its response is still recorded.
        yield* scenario((given, runtime) =>
          Effect.gen(function* () {
            given.faux.setResponses([fauxAssistantMessage('first')])
            const first = yield* admit(
              runtime,
              ada,
              delivery('thread-1', `${RESPONSE_ENTRY}:${number}`),
            )
            expect(first.submissionId).toBe(number)
            yield* settled(runtime, ada, 'thread-1', first.submissionId)
            yield* runtime.persons.use(ada, (person) => person.quiet)
            const entries = yield* transcript(runtime, ada, 'thread-1')
            expect(entries.filter((entry) => entry.kind === RESPONSE_ENTRY)).toHaveLength(1)
          }),
        )
      }),
  )

  it.effect('admits two requests with one key, sent at once, as one delivery', () =>
    scenario((given, runtime) =>
      Effect.gen(function* () {
        given.faux.setResponses([fauxAssistantMessage('once')])
        const [one, other] = yield* Effect.all(
          [
            admit(runtime, ada, delivery('thread-1', 'same-key')),
            admit(runtime, ada, delivery('thread-1', 'same-key')),
          ],
          { concurrency: 2 },
        )
        expect(other.submissionId).toBe(one.submissionId)
        yield* settled(runtime, ada, 'thread-1', one.submissionId)
        yield* runtime.persons.use(ada, (person) => person.quiet)
        expect(given.faux.state.callCount).toBe(1)
        const entries = yield* transcript(runtime, ada, 'thread-1')
        expect(entries.filter((entry) => entry.kind === 'pi.user')).toHaveLength(1)
      }),
    ),
  )

  it.effect(
    'gives the reply every word of the response, and asks the model to think as main did',
    () =>
      scenario((given, runtime) =>
        Effect.gen(function* () {
          const asked = yield* Deferred.make<unknown>()
          const working: FauxResponseFactory = (_context, options) => {
            Deferred.doneUnsafe(
              asked,
              Effect.succeed(options === undefined ? undefined : options.reasoning),
            )
            return fauxAssistantMessage(
              [
                fauxText('I found the report.'),
                fauxToolCall('activate_skill', { name: 'deep-research' }),
              ],
              { stopReason: 'toolUse' },
            )
          }
          given.faux.setResponses([
            working,
            fauxAssistantMessage([fauxText('Sent it.'), fauxText('Anything else?')]),
          ])
          const receipt = yield* admit(runtime, ada, delivery('thread-1', 'key-1'))
          expect(yield* settled(runtime, ada, 'thread-1', receipt.submissionId)).toEqual(
            RuntimeSettlement.cases.Done.make({
              answeredBy: receipt.submissionId,
              reply: 'I found the report.\n\nSent it.\n\nAnything else?',
              toolCalls: 1,
            }),
          )
          expect(yield* Deferred.await(asked)).toBe('medium')
        }),
      ),
  )

  it.effect(
    'places every delivery that arrived during a round of tools before the next request',
    () =>
      scenario((given, runtime) =>
        Effect.gen(function* () {
          const round = yield* held('unused')
          const working: FauxResponseFactory = (context, options, state, model) =>
            Promise.resolve(round.factory(context, options, state, model)).then(() =>
              fauxAssistantMessage(fauxToolCall('activate_skill', { name: 'deep-research' }), {
                stopReason: 'toolUse',
              }),
            )
          const heard = yield* Deferred.make<ReadonlyArray<unknown>>()
          const all: FauxResponseFactory = (context) => {
            Deferred.doneUnsafe(
              heard,
              Effect.succeed(
                context.messages.flatMap((message) =>
                  message.role === 'user' ? [message.content] : [],
                ),
              ),
            )
            return fauxAssistantMessage('all three')
          }
          given.faux.setResponses([working, all])
          const first = yield* admit(runtime, ada, delivery('thread-1', 'a', { body: 'one' }))
          yield* round.entered
          const second = yield* admit(
            runtime,
            ada,
            delivery('thread-1', 'b', { body: 'two', turn: 2 }),
          )
          const third = yield* admit(
            runtime,
            ada,
            delivery('thread-1', 'c', { body: 'three', turn: 3 }),
          )
          yield* round.release
          expect(yield* Deferred.await(heard)).toEqual(['one', 'two', 'three'])
          for (const receipt of [first, second, third])
            expect(yield* settled(runtime, ada, 'thread-1', receipt.submissionId)).toMatchObject({
              answeredBy: first.submissionId,
              reply: 'all three',
            })
          expect(given.faux.state.callCount).toBe(2)
        }),
      ),
  )

  it.effect('measures a failed response without the response that follows it', () =>
    scenario((given, runtime) =>
      Effect.gen(function* () {
        given.faux.setResponses([
          fauxAssistantMessage('', { stopReason: 'error', errorMessage: '401 invalid api key' }),
          fauxAssistantMessage(fauxToolCall('activate_skill', { name: 'deep-research' }), {
            stopReason: 'toolUse',
          }),
          fauxAssistantMessage('the second worked'),
        ])
        const failed = yield* admit(runtime, ada, delivery('thread-1', 'a'))
        yield* settled(runtime, ada, 'thread-1', failed.submissionId)
        const worked = yield* admit(runtime, ada, delivery('thread-1', 'b', { turn: 2 }))
        yield* settled(runtime, ada, 'thread-1', worked.submissionId)
        yield* runtime.persons.use(ada, (person) => person.quiet)
        const entries = yield* transcript(runtime, ada, 'thread-1')
        const recorded = yield* Effect.forEach(
          entries.filter((entry) => entry.kind === RESPONSE_ENTRY),
          (entry) => decodeResponse(entry.data),
        )
        expect(recorded.map((response) => [response.outcome, response.toolCallCount])).toEqual([
          ['failed', 0],
          ['completed', 1],
        ])
      }),
    ),
  )

  it.effect('says how a response failed in closed words, never in the provider’s', () =>
    scenario((given, runtime) =>
      Effect.gen(function* () {
        const marker = '/private/state/person-7f3a/sk-live-SECRET'
        given.faux.setResponses([
          fauxAssistantMessage('', {
            stopReason: 'error',
            errorMessage: `403 forbidden for ${marker}`,
          }),
        ])
        const receipt = yield* admit(runtime, ada, delivery('thread-1', 'key-1'))
        const response = yield* runtime.send(
          `${threadPath(ada, 'thread-1')}/submissions/${receipt.submissionId}`,
          { method: 'GET' },
        )
        expect(yield* decodeSettlement(response.body)).toEqual(
          RuntimeSettlement.cases.Failed.make({ failure: 'ModelUnavailable', status: 403 }),
        )
        expect(JSON.stringify(response.body)).not.toContain('SECRET')
      }),
    ),
  )

  it.effect(
    'leaves an attempt the model made again out of the reply and out of the tool count',
    () =>
      scenario((given, runtime) =>
        Effect.gen(function* () {
          given.faux.setResponses([
            // The provider fails after some words and a call Pi never runs; Pi tries again.
            fauxAssistantMessage(
              [fauxText('The message was sent.'), fauxToolCall('notify_person', { title: 'Sent' })],
              { stopReason: 'error', errorMessage: '503 overloaded' },
            ),
            fauxAssistantMessage('I could not send it.'),
          ])
          const receipt = yield* admit(runtime, ada, delivery('thread-1', 'key-1'))
          expect(yield* settled(runtime, ada, 'thread-1', receipt.submissionId)).toEqual(
            RuntimeSettlement.cases.Done.make({
              answeredBy: receipt.submissionId,
              reply: 'I could not send it.',
              toolCalls: 0,
            }),
          )
          yield* runtime.persons.use(ada, (person) => person.quiet)
          const entries = yield* transcript(runtime, ada, 'thread-1')
          const [recorded] = yield* Effect.forEach(
            entries.filter((entry) => entry.kind === RESPONSE_ENTRY),
            (entry) => decodeResponse(entry.data),
          )
          // Both attempts are in the transcript; only one was a step of the response.
          expect(entries.filter((entry) => entry.kind === 'pi.assistant')).toHaveLength(2)
          expect(recorded).toMatchObject({ outcome: 'completed', toolCallCount: 0 })
          expect(given.faux.state.callCount).toBe(2)
        }),
      ),
  )

  it.effect('refuses a caller without the runtime token and answers health without one', () =>
    scenario((_given, runtime) =>
      Effect.gen(function* () {
        expect(
          yield* runtime.send(threadPath(ada, 'thread-1'), {
            method: 'POST',
            body: delivery('thread-1', 'key-1'),
            token: 'wrong',
          }),
        ).toEqual({ status: 401, body: { error: 'Unauthorized' } })
        expect(yield* runtime.send('/health', { method: 'GET', token: 'wrong' })).toEqual({
          status: 200,
          body: { model: 'fixture/text', service: 'vivid-agent-runtime', status: 'ok' },
        })
      }),
    ),
  )
})
