import {
  fauxAssistantMessage,
  type FauxResponseFactory,
} from '@earendil-works/pi-ai/providers/faux'
import type { Message } from '@earendil-works/pi-ai'
import { describe, expect, it } from '@effect/vitest'
import { ConversationState, RuntimeSettlement } from '@vivid/contracts'
import { Effect, Predicate, Schema } from 'effect'
import {
  ada,
  admit,
  delivery,
  scenario,
  settled,
  threadPath,
  type Runtime,
} from '../tests/requests.ts'

const decodeState = Schema.decodeUnknownEffect(ConversationState)

/** The production display that did not draw on 27 October 2026: `flat` is not a `Card` variant. */
const display = (variant: string) =>
  [
    'here is your week.',
    '',
    '```openui-lang',
    'root = Col([Title("This week", "lg"), day], 3)',
    `day = Card([Caption("Mon 3 Nov"), Text("9:00 standup", "sm")], "${variant}")`,
    '```',
  ].join('\n')
const BROKEN = display('flat')
const FIXED = display('soft')
const FAULT = 'field "/variant" expects one of ["outline", "soft"] but got "flat"'

const userWords = (messages: ReadonlyArray<Message>) =>
  messages.flatMap((message) =>
    message.role === 'user' && Predicate.isString(message.content) ? [message.content] : [],
  )

/** Answer with `answer` and keep what the model was asked with. */
const asked =
  (answer: string, seen: Array<ReadonlyArray<string>>): FauxResponseFactory =>
  (context) => {
    seen.push(userWords(context.messages))
    return fauxAssistantMessage(answer)
  }

/** The Thread as a screen reads it, through the runtime's state route. */
const stateOf = (runtime: Runtime, threadId: string) =>
  Effect.gen(function* () {
    const response = yield* runtime.send(`${threadPath(ada, threadId)}/state`, { method: 'GET' })
    expect(response.status).toBe(200)
    return yield* decodeState(response.body)
  })

describe('a display that does not draw', () => {
  it.effect('is sent back once with the error, and the correction is not the Person’s words', () =>
    scenario((given, runtime) =>
      Effect.gen(function* () {
        const seen: Array<ReadonlyArray<string>> = []
        given.faux.setResponses([asked(BROKEN, seen), asked(FIXED, seen)])
        const receipt = yield* admit(
          runtime,
          ada,
          delivery('week', 'week', { body: 'show me my week' }),
        )
        const settlement = yield* settled(runtime, ada, 'week', receipt.submissionId)
        expect(settlement).toEqual(
          RuntimeSettlement.cases.Done.make({
            answeredBy: receipt.submissionId,
            reply: FIXED,
            toolCalls: 0,
          }),
        )
        expect(given.faux.state.callCount).toBe(2)
        expect(seen[0]).toEqual(['show me my week'])
        const [person, correction, ...more] = seen[1] ?? []
        expect(person).toBe('show me my week')
        expect(correction).toContain('display 1, `day`')
        expect(correction).toContain(FAULT)
        expect(more).toEqual([])

        const state = yield* stateOf(runtime, 'week')
        const people = state.messages.filter((message) => message.role === 'user')
        expect(people.map((message) => message.parts)).toEqual([
          [{ type: 'text', text: 'show me my week', state: 'done' }],
        ])
        const replies = state.messages.filter((message) => message.role === 'assistant')
        expect(replies.map((message) => message.parts)).toEqual([
          [{ type: 'text', text: FIXED, state: 'done' }],
        ])
        expect(JSON.stringify(state)).not.toContain('flat')
        expect(JSON.stringify(state)).not.toContain('does not draw')
      }),
    ),
  )

  it.effect('is sent back at most once in a run', () =>
    scenario((given, runtime) =>
      Effect.gen(function* () {
        const seen: Array<ReadonlyArray<string>> = []
        given.faux.setResponses([asked(BROKEN, seen), asked(BROKEN, seen)])
        const receipt = yield* admit(runtime, ada, delivery('again', 'again'))
        const settlement = yield* settled(runtime, ada, 'again', receipt.submissionId)
        expect(RuntimeSettlement.guards.Done(settlement)).toBe(true)
        expect(given.faux.state.callCount).toBe(2)
      }),
    ),
  )

  it.effect('a display that draws gets no correction', () =>
    scenario((given, runtime) =>
      Effect.gen(function* () {
        const seen: Array<ReadonlyArray<string>> = []
        given.faux.setResponses([asked(FIXED, seen)])
        const receipt = yield* admit(runtime, ada, delivery('clean', 'clean'))
        const settlement = yield* settled(runtime, ada, 'clean', receipt.submissionId)
        expect(settlement).toEqual(
          RuntimeSettlement.cases.Done.make({
            answeredBy: receipt.submissionId,
            reply: FIXED,
            toolCalls: 0,
          }),
        )
        expect(given.faux.state.callCount).toBe(1)
      }),
    ),
  )
})
