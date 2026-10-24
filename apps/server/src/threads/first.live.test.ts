import { describe, expect, layer } from '@effect/vitest'
import { Effect } from 'effect'
import { chainArrival, chainLayer, completeRun } from '../runtime/chains.ts'

/**
 * The claim: someone who has just arrived is spoken to before they are asked anything.
 *
 * On 5 October 2026 the first Thread on production opened with a question card and no words: the
 * model loaded the first-conversation skill and went straight to `ask_person`, so a new Person met
 * a form instead of Vivid. Clients draw whatever Vivid writes above the cards of the same reply,
 * so what is checked is the reply itself: it has words of Vivid's own, and they are written
 * before any question. Whether to ask at all is the model's choice. The introduction identifies Vivid by name; the remaining
 * wording belongs to the model and is not compared against the prompt.
 *
 * One real signup, the server's own first Thread and one real model reply; no judge, no retry.
 */
layer(chainLayer, { excludeTestServices: true })((it) => {
  describe.skipIf(process.env['VIVID_LIVE_FIRST_CONVERSATION'] !== '1')(
    'First conversation live chain',
    () => {
      it.effect(
        'Vivid says who it is before it asks anything',
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
            // Asking is the model's choice since 21 October 2026. When it does ask, it asks once,
            // the call is accepted, and the words come first; a refused call would show the
            // Person a failed step above the card.
            expect(
              questions.map((question) => question.state),
              'Vivid asks at most one accepted question',
            ).toEqual(questions.length === 0 ? [] : ['output-available'])
            const firstQuestion = Math.min(
              parts.length,
              ...questions.map((question) => question.index),
            )
            expect(spoke, 'The words must come before any question').toBeLessThan(firstQuestion)
            const introduction = parts
              .slice(0, firstQuestion)
              .flatMap((part) => (part.type === 'text' ? [part.text] : []))
              .join(' ')
            expect(introduction, 'The introduction must identify Vivid').toMatch(/\bVivid\b/u)
            // A card is drawn from the stored question, not from the call, so an asked question
            // must be waiting for the Person. This Thread has had one Run, so it is that Run's.
            const asked = yield* fixture.rpc.GetThread({ id: fixture.threadId })
            expect(
              asked.requests.map((request) => request.state._tag),
              'An asked question must be waiting for the Person in the Thread',
            ).toEqual(questions.map(() => 'Waiting'))
          }).pipe(Effect.scoped),
        { timeout: 240_000 },
      )
    },
  )
})
