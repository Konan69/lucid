import type { AnswerIntegrationInputRequest } from '@vivid/contracts'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import type {
  AnswerInputRequest,
  AskInputRequest,
  FillHandoffRequest,
  HandoffIdRequest,
  PrepareHandoffRequest,
} from '@vivid/contracts'
import { requireActor, requirePerson, requireVivid, type Actor } from '../auth/access.ts'
import {
  beginHandoff,
  completeHandoff,
  fillHandoff,
  prepareHandoff,
  withdrawHandoff,
} from './handoff.ts'
import { InputStore } from './store.ts'

/** A Person's own call: their identity, their workspace, never a Thread from a Run. */
const personActor = Effect.fn('Inputs.person')(function* () {
  const auth = yield* requirePerson()
  return {
    person: auth.person,
    workspace: auth.workspace,
    by: 'person',
    threadId: Option.none(),
    helper: Option.none(),
  } satisfies Actor
})

export const inputHandlers = {
  /** Vivid supplies all questions together; authenticated Run context supplies identity and Thread. */
  AskInput: Effect.fn('Rpc.AskInput')(function* (request: AskInputRequest) {
    const auth = yield* requireVivid()
    const actor: Actor = {
      person: auth.person,
      workspace: auth.workspace,
      by: 'vivid',
      threadId: Option.some(auth.threadId),
      helper: Option.none(),
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
      helper: Option.none(),
    }
    return { request: yield* (yield* InputStore).answer(actor, request) }
  }),
  /** Only a Run hands a step over; the acting Run supplies the Thread, the Run and the Person. */
  PrepareHandoff: Effect.fn('Rpc.PrepareHandoff')(function* (request: PrepareHandoffRequest) {
    yield* requireVivid()
    return yield* prepareHandoff(yield* requireActor(), request)
  }),
  /** The Person calls below act only on a handoff addressed to them (`handoff.ts` `addressed`). */
  BeginHandoff: Effect.fn('Rpc.BeginHandoff')(function* ({ id }: HandoffIdRequest) {
    return { handoff: yield* beginHandoff(yield* personActor(), id) }
  }),
  /** Values go from this request to the Computer's browser; the response holds receipts only. */
  FillHandoff: Effect.fn('Rpc.FillHandoff')(function* (request: FillHandoffRequest) {
    return { handoff: yield* fillHandoff(yield* personActor(), request) }
  }),
  CompleteHandoff: Effect.fn('Rpc.CompleteHandoff')(function* ({ id }: HandoffIdRequest) {
    return { handoff: yield* completeHandoff(yield* personActor(), id) }
  }),
  WithdrawHandoff: Effect.fn('Rpc.WithdrawHandoff')(function* ({ id }: HandoffIdRequest) {
    return { handoff: yield* withdrawHandoff(yield* personActor(), id) }
  }),
}

/** A typed form answers the saved Input request through its ordinary owner and Thread checks. */
export const answerIntegrationInput = Effect.fn('Rpc.AnswerIntegrationInput')(function* (
  request: AnswerIntegrationInputRequest,
) {
  return yield* (yield* InputStore).answerIntegration(yield* personActor(), request)
})
