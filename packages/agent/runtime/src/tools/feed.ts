import { defineTool } from './tool.ts'
import { Tool, PostOutcome } from '@vivid/contracts'
import { Effect } from 'effect'
import * as v from 'valibot'
import { Scope, type RunTool } from './scope.ts'
import { summary, text } from './inputs.ts'

/**
 * The Feed is the only way work Vivid does on its own reaches the Person. This wording is the
 * whole contract the model gets, so it says when to post and when to stay quiet.
 */
export const instructions =
  'Put something on the Person’s Feed when work you did on your own found something that needs them or that they would want to know. The card is the thing itself, drawn: the letter you wrote, the numbers as a chart, the options as tiles, the page you made, as one openui-lang display. Words only for what the drawing cannot say, one sentence, never a restatement of the title. Buttons for what they can do next. One card per piece of work: posting again replaces the card. If nothing needs them, do not post.'

/** The model sees whether its card is new or replaced, never the card's or Thread's identity. */
const resultOf = (outcome: PostOutcome) =>
  PostOutcome.match(outcome, {
    Posted: () => ({ output: { ok: true, message: 'The card is on the Person’s Feed.' } }),
    Updated: () => ({ output: { ok: true, message: 'The card on the Feed now says this.' } }),
  })

export function feedTools(runTool: RunTool) {
  return [
    defineTool({
      name: Tool.post,
      description: `Post a card to the Person’s Feed. ${instructions}`,
      input: v.object({
        summary,
        title: text('A short title: what needs them, as a question or a fact.', 120),
        words: v.nullable(
          text(
            'One or two sentences only when the display does not say it; null when the drawing is the card.',
            600,
          ),
        ),
        display: v.nullable(
          text(
            'The thing itself as one whole openui-lang program (no fence) that starts with its root statement (root = Card([...])), or null when words say it all.',
            20_000,
          ),
        ),
        actions: v.pipe(
          v.array(text('A button label; $name inserts what they chose in the display.', 60)),
          v.maxLength(2),
          v.description('Up to two buttons, primary last, such as ["Not now", "Book $flight"].'),
        ),
      }),
      /** Runtime authority supplies the Person and the Thread; the server keeps one card per Thread. */
      run({ data, signal }) {
        return runTool(
          Effect.gen(function* () {
            const { client } = yield* Scope
            const { summary: _summary, ...card } = data
            return resultOf(yield* client.Post(card))
          }).pipe(
            // The server refused a display that draws nothing; the model draws it again.
            Effect.catchTag('FeedDisplayInvalid', () =>
              Effect.succeed({
                output: {
                  ok: false,
                  message: 'The display has no root statement: start it with root = …',
                },
              }),
            ),
          ),
          { signal, tool: 'post' },
        )
      },
    }),
  ] as const
}
