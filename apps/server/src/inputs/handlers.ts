import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import type { AnswerInputRequest, AskInputRequest } from '@vivid/contracts'
import { requirePerson, requireVivid, type Actor } from '../auth/access.ts'
import { InputStore } from './store.ts'

export const inputHandlers = {
  /** Vivid supplies all questions together; authenticated Run context supplies identity and Thread. */
  AskInput: Effect.fn('Rpc.AskInput')(function* (request: AskInputRequest) {
    const auth = yield* requireVivid()
    const actor: Actor = {
      person: auth.person,
      workspace: auth.workspace,
      by: 'vivid',
      threadId: Option.some(auth.threadId),
    }
    return { request: yield* (yield* InputStore).ask(actor, request) }
  }),
  /** Answering is reserved to a signed-in Person and the store validates every answer before the once-only settlement. */
  AnswerInput: Effect.fn('Rpc.AnswerInput')(function* (request: AnswerInputRequest) {
    const auth = yield* requirePerson()
    const actor: Actor = {
      person: auth.person,
      workspace: auth.workspace,
      by: 'person',
      threadId: Option.none(),
    }
    return { request: yield* (yield* InputStore).answer(actor, request) }
  }),
}
