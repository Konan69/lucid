import { describe, expect, it } from '@effect/vitest'
import { Effect } from 'effect'
import { chainArrival, chainLayer, completeRun } from '../runtime/chains.ts'

/**
 * The claim: someone who has just arrived is spoken to before they are asked anything.
 *
 * On 5 October 2026 the first Thread on production opened with a question card and no words: the
 * model loaded the first-conversation skill and went straight to `ask_person`, so a new Person met
 * a form instead of Vivid. Clients draw whatever Vivid writes above the cards of the same reply,
 * so what is checked is the reply itself: it has words of Vivid's own, and they are written
 * before the question is asked. What the words say is the model's; only their presence and their
 * place are observable structure.
 *
 * One real signup, the server's own first Thread and one real model reply; no judge, no retry.
 */
describe.skipIf(process.env['VIVID_LIVE_FIRST_CONVERSATION'] !== '1')(
  'First conversation live chain',
  () => {
    it.live(
      'Vivid says who it is before it asks its first question',
      () =>
        Effect.gen(function* () {
          const fixture = yield* chainArrival()
          const opened = yield* fixture.rpc.GetThread({ id: fixture.threadId })
          const [run] = opened.runs
          if (run === undefined) expect.fail('The first Thread must open with a Run')
          const settled = yield* completeRun(fixture, run.id)
          // A reply is one or more assistant messages; their parts are in the order the model
          // produced them, which is the order the claim is about.
          const parts = settled.messages
            .filter((message) => message.role === 'assistant')
            .flatMap((message) => message.parts)
          const spoke = parts.findIndex(
            (part) => part.type === 'text' && part.text.trim().length > 0,
          )
          const questions = parts.flatMap((part, index) =>
            part.type === 'dynamic-tool' && part.toolName === 'ask_person'
              ? [{ index, state: part.state }]
              : [],
          )
          expect(spoke, 'Vivid must say something of its own in its first reply').not.toBe(-1)
          // A call the runtime refuses is made again, and the Person sees the refused one as a
          // failed step above their first question; one that is only refused leaves no card.
          expect(
            questions.map((question) => question.state),
            'Vivid must ask its first question once, and the call must be accepted',
          ).toEqual(['output-available'])
          expect(spoke, 'The words must come before the question').toBeLessThan(
            Math.min(...questions.map((question) => question.index)),
          )
          // The card is drawn from the stored question, not from the call: it has to be there
          // and still waiting for the Person. This Thread has had one Run, so it is that Run's.
          const asked = yield* fixture.rpc.GetThread({ id: fixture.threadId })
          expect(
            asked.requests.map((request) => request.state._tag),
            'The question must be waiting for the Person in the Thread',
          ).toEqual(['Waiting'])
        }).pipe(Effect.scoped, Effect.provide(chainLayer)),
      { timeout: 240_000 },
    )
  },
)
