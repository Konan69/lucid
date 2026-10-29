import { defineTool } from './tool.ts'
import { FeedPost, Tool, PostOutcome } from '@vivid/contracts'
import { Effect, Match } from 'effect'
import * as v from 'valibot'
import { Scope, type RunTool } from './scope.ts'
import { summary, text } from './inputs.ts'

/**
 * The Feed is the only way work Vivid does on its own reaches the Person. This wording is the
 * whole contract the model gets, so it says when to post and when to stay quiet.
 */
export const instructions =
  'Put something on the Person’s Feed when work you did on your own found something that needs them or that they would want to know. Most cards are drawn: the drawing is the whole card, the letter you wrote, the numbers as a chart, the options as tiles, the page you made, as one openui-lang display with its own Buttons that answer you (@ToAssistant), the way a reply’s display does; nothing is written above or under it. Your drawing sits on a card the Feed already gives it, under your title as its heading: never wrap the drawing in a Card, and start it with what the title does not already say (under the title "September revenue is in", the number itself, never Caption("September revenue")). Only when there is nothing to draw, say it in a sentence or two with up to two buttons. One card per piece of work: posting again replaces the card. If nothing needs them, do not post.'

const title = text(
  'A short name for the card where it is listed once handled: what needs them, as a question or a fact.',
  120,
)

/**
 * The card is one of the contract's two cases (`FeedPost`): drawn, where the display is the whole
 * card, or said, words and buttons when there is nothing to draw.
 */
const card = v.variant('kind', [
  v.strictObject({
    kind: v.literal('Drawn'),
    title,
    display: text(
      'The whole card as one openui-lang program (no fence) that starts with its root statement (root = Col([...])). Its Buttons with @ToAssistant are how the Person answers.',
      20_000,
    ),
  }),
  v.strictObject({
    kind: v.literal('Said'),
    title,
    words: text('One or two sentences: what happened and what it needs from them.', 600),
    actions: v.pipe(
      v.array(text('A button label, what the Person would say.', 60)),
      v.maxLength(2),
      v.description('Up to two buttons, primary last, such as ["Not now", "Book it"].'),
    ),
  }),
])

/** The model's card as the contract's case. */
const postOf = (input: v.InferOutput<typeof card>) =>
  Match.value(input).pipe(
    Match.discriminatorsExhaustive('kind')({
      Drawn: ({ title, display }) => FeedPost.cases.Drawn.make({ title, display }),
      Said: ({ title, words, actions }) => FeedPost.cases.Said.make({ title, words, actions }),
    }),
  )

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
      input: v.object({ summary, card }),
      /** Runtime authority supplies the Person and the Thread; the server keeps one card per Thread. */
      run({ data, signal }) {
        return runTool(
          Effect.gen(function* () {
            const { client } = yield* Scope
            return resultOf(yield* client.Post(postOf(data.card)))
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
