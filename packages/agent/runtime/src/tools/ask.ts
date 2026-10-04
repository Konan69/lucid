import { defineTool } from '@flue/runtime'
import * as Effect from 'effect/Effect'
import * as v from 'valibot'
import { Scope, type RunTool } from './scope.ts'
import * as views from './views.ts'
import { summary, text } from './inputs.ts'

/** A durable question ends this turn; the server returns the answer as a new delivery. */
export function askTools(runTool: RunTool) {
  return [
    defineTool({
      name: 'ask_person',
      description:
        'Ask the person a question you cannot answer safely yourself. The turn ends immediately until they answer.',
      input: v.object({
        summary,
        question: text('One self-contained question.', 400),
        options: v.pipe(
          v.array(
            v.object({
              label: text('A short choice.', 200),
              detail: text('The consequence of this choice.', 400),
            }),
          ),
          v.maxLength(6),
          v.description('Up to six choices; use an empty list for a written answer.'),
        ),
        allowsOwnAnswer: v.pipe(
          v.boolean(),
          v.description('Whether the person may write their own answer.'),
        ),
      }),
      /** Flue owns input decoding and cancellation; this boundary executes the attributed RPC Effect. */
      run({ data, signal }) {
        return runTool(
          Effect.gen(function* () {
            const { client } = yield* Scope
            const { request } = yield* client.AskInput({
              question: data.question,
              options: data.options,
              allowsOwnAnswer: data.allowsOwnAnswer,
            })
            return { output: views.inputRequest(request), terminate: true }
          }),
          { signal, tool: 'ask_person' },
        )
      },
    }),
  ] as const
}
