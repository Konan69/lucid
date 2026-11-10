import { useAtomValue } from '@effect/atom-react'
import type { AnswerIntegrationInputRequest } from '@vivid/contracts'
import { filling } from '@vivid/state'
import { Effect, Layer, Result } from 'effect'
import { changing } from './app'
import { engine } from './runtime'

/**
 * Answering an Integration's question from its banner (`filling`, `@vivid/state`). The answer goes
 * over the app's socket as a change; the request's record comes back with the Thread's detail,
 * which is what takes the banner away.
 */
const answers = filling.make(
  Layer.succeed(filling.Answering, {
    answer: Effect.fn('Integrations.answer')(function* (request: AnswerIntegrationInputRequest) {
      const result = yield* changing((client) => client.AnswerIntegrationInput(request))
      if (Result.isFailure(result))
        return yield* new filling.Refused({
          id: request.id,
          words: filling.refusedWords(result.failure),
        })
    }),
  }),
)

// An answer outlives the banner that sent it: the request's record may fold it away first.
engine.registry.mount(answers.reading)

/** Every Integration banner reads the same answer. */
export const useFilling = () => useAtomValue(answers.reading)

/** The machine takes an answer only while no other is on its way. */
export const answerIntegration = (request: AnswerIntegrationInputRequest) =>
  engine.registry.set(answers.send, answers.answer({ request }))
