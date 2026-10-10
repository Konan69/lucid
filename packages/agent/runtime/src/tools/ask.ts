import { defineTool } from '@flue/runtime'
import * as Arr from 'effect/Array'
import * as Effect from 'effect/Effect'
import { INPUT_QUESTIONS_MOST } from '@vivid/contracts'
import * as v from 'valibot'
import { Scope, type RunTool } from './scope.ts'
import * as views from './views.ts'
import { text } from './inputs.ts'

/** Each question is self-contained; several picks are allowed only when the choices truly coexist. */
const question = v.object({
  question: text('One self-contained question the person can answer without another turn.', 400),
  options: v.pipe(
    v.array(
      v.object({
        label: text('A short choice.', 200),
        detail: text('The consequence of this choice.', 400),
      }),
    ),
    v.maxLength(6),
    v.description(
      'Zero to six choices; use an empty list and allowsOwnAnswer true for written words.',
    ),
  ),
  several: v.pipe(
    v.boolean(),
    v.description(
      'True only when more than one option can truly apply together; false for alternatives.',
    ),
  ),
  allowsOwnAnswer: v.pipe(
    v.boolean(),
    v.description('Whether the person may write their own answer instead of choosing options.'),
  ),
})

/** One durable request asks everything needed together and ends this turn; the server returns the answer as a new delivery. */
export function askTools(runTool: RunTool) {
  return [
    defineTool({
      name: 'ask_person',
      description:
        'Ask the person everything you need to decide safely in ONE call: one to four questions, answered together. Gather all missing details that block this work instead of asking one question per turn. Set several true only when more than one option can truly apply. End your turn immediately; work resumes after every question has an answer.',
      // No `summary`, unlike the other tools: the question is already the sentence the Person
      // reads for this step, and asking for it twice cost a turn. With it required, five of six
      // first Threads on 5 October 2026 had this call refused for the missing field and made
      // again, so the first question arrived a model round late behind a failed step.
      input: v.object({
        questions: v.pipe(
          v.tupleWithRest([question], question),
          v.maxLength(INPUT_QUESTIONS_MOST),
          v.description(
            'One to four questions. Include everything needed to continue this work in this request.',
          ),
        ),
      }),
      /** Flue owns input decoding and cancellation; this boundary executes the attributed RPC Effect. */
      run({ data, signal }) {
        return runTool(
          Effect.gen(function* () {
            const { client } = yield* Scope
            const { request } = yield* client.AskInput({
              questions: Arr.map(data.questions, (item) => ({
                question: item.question,
                options: item.options,
                selection: item.several ? 'Several' : 'One',
                allowsOwnAnswer: item.allowsOwnAnswer,
              })),
            })
            return { output: views.inputRequest(request), terminate: true }
          }),
          { signal, tool: 'ask_person' },
        )
      },
    }),
  ] as const
}
