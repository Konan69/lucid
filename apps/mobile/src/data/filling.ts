import { useAtomValue } from '@effect/atom-react'
import type { AnswerIntegrationInputRequest } from '@vivid/contracts'
import { filling, type makeLive } from '@vivid/state'
import { Effect, Layer, Result } from 'effect'
import { confirm, warn } from './haptics'
import { useLiveData, type LiveData } from './live'

/**
 * The phone's answers to an Integration's question (`filling`, `@vivid/state`), one machine for
 * the signed-in session as the web keeps one for the page (`apps/web/src/data/filling.ts`). The
 * request's record comes back with the Thread's detail, which is what slides the banner away.
 */
export const makeIntegrationAnswers = (engine: ReturnType<typeof makeLive>) => {
  const answers = filling.make(
    Layer.succeed(filling.Answering, {
      answer: Effect.fn('Integrations.answer')(function* (request: AnswerIntegrationInputRequest) {
        const result = yield* engine.change((client) => client.AnswerIntegrationInput(request))
        if (Result.isFailure(result)) {
          warn()
          return yield* new filling.Refused({
            id: request.id,
            words: filling.refusedWords(result.failure),
          })
        }
      }),
    }),
  )
  // An answer outlives the banner that sent it: the request's record may slide it away first.
  engine.registry.mount(answers.reading)
  return answers
}

/** Every Integration banner of the session reads the same answer. */
export const useFilling = () => {
  const data = useLiveData()
  return useAtomValue(data.filling.reading)
}

/** The machine takes an answer only while no other is on its way. A send is felt as a yes. */
export const answerIntegration = (data: LiveData, request: AnswerIntegrationInputRequest) => {
  if (request.response.action === 'accept') confirm()
  data.registry.set(data.filling.send, data.filling.answer({ request }))
}
