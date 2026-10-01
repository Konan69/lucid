import { defineTool } from '@flue/runtime'
import { InputRequestMessage } from '@vivid/contracts'
import * as Effect from 'effect/Effect'
import type * as Option from 'effect/Option'
import * as v from 'valibot'
import { asActing, type Acting } from '../client.ts'
import { text } from './inputs.ts'
import { settle } from './result.ts'

/** A durable question ends this turn; the server returns the answer as a new delivery. */
export function askTools(acting: Option.Option<Acting>) {
  return [
    defineTool({
      name: 'ask_person',
      description:
        'Ask the person a question you cannot answer safely yourself. The turn ends immediately until they answer.',
      input: v.object({
        question: text('One self-contained question.', 400),
        options: v.pipe(
          v.array(
            v.object({
              label: text('A short choice.', 200),
              detail: text('The consequence of this choice.', 400),
            }),
          ),
          v.maxLength(4),
          v.description('Up to four choices; use an empty list for a written answer.'),
        ),
        allowsOwnAnswer: v.pipe(
          v.boolean(),
          v.description('Whether the person may write their own answer.'),
        ),
      }),
      /** Flue owns input decoding and cancellation; this boundary executes the attributed RPC Effect. */
      run({ data, signal }) {
        return Effect.runPromise(
          settle(
            asActing(acting, (client) =>
              client.AskInput(data).pipe(
                Effect.map(({ request }) => ({
                  output: {
                    ...InputRequestMessage.make({
                      kind: 'input-request',
                      requestId: request.id,
                      question: request.question,
                    }),
                    message:
                      'End the turn now; the person has been asked and their answer will return here.',
                  },
                  terminate: true,
                })),
              ),
            ),
          ),
          { signal },
        )
      },
    }),
  ] as const
}
