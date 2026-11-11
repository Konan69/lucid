import { defineTool } from './tool.ts'
import { FeedSource, PostRequest, Tool, PostOutcome } from '@vivid/contracts'
import { Effect, Match, Option, Schema } from 'effect'
import * as v from 'valibot'
import { drawingFaults } from '../agents/displays.ts'
import { Scope, type RunTool } from './scope.ts'
import { summary, text } from './inputs.ts'

/**
 * The Feed is the only way work Vivid does on its own reaches the Person. This wording is the
 * whole contract the model gets, so it says when to post and when to stay quiet.
 */
const instructions =
  'Put something on the Person’s Feed when work you did on your own found something that needs them or that they would want to know. Most cards are drawn: the drawing is the whole card, the thing itself (the letter you wrote, the invoice with its amount and lines, the numbers as a chart, the options as tiles with their pictures, the place as a map, the week as a strip of days, the web page you read with its picture, your Computer’s screen) as one openui-lang display with its own Buttons that answer you (@ToAssistant), the way a reply’s display does. The Feed already shows where the card came from and when, so the drawing never repeats its title, its source or a date line, and holds at most one short line of words per block; never a paragraph. Never wrap the drawing in a Card. Only when there is nothing to draw, say it in a sentence or two with up to two buttons. One card per piece of work: posting again replaces the card. When what you found came from a page or record with a link, give it in sources so the Person can open it. Say in from where it came from, in their words (a note you keep, a goal, a letter, a recent conversation, a check-in), in two to five words that name the source and never what the card says about it. Cards appear silently. An ordinary card waits for a quiet moment in their waking hours, and at most one a day is announced; mark a card urgent only when it cannot wait for that (a deadline today, money or access at risk, someone waiting on them now), and it is announced at once with sound. Follow what their attention page says they want to hear about, never want brought up, and when. If nothing needs them, do not post.'

const title = text(
  'A short name for the card, read aloud and shown where it is listed once handled: what needs them, as a question or a fact. A drawn card does not show it above the drawing.',
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
      'The whole card as one openui-lang program (no fence) that starts with its root statement (root = Col([...])), leading with the thing itself. Its Buttons with @ToAssistant are how the Person answers.',
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

/**
 * The pages or records the finding came from, as links Vivid actually obtained. The server checks
 * each is an absolute http or https address; it adds the event and the Run itself.
 */
const sources = v.pipe(
  v.array(
    v.strictObject({
      label: text('What the page or record is, as the Person would name it.', 120),
      url: text('Its full http or https address, exactly as you obtained it.', 2000),
    }),
  ),
  v.maxLength(10),
  v.description(
    'The pages or records you read this from that have a link: an email, a document, an issue, a web page. Give only links you actually obtained in this work, never one you made up or an address inside Vivid. Empty when the event itself is all you used.',
  ),
)

const checkSource = Schema.decodeUnknownOption(FeedSource)

const from = text(
  'Where this came from, in two to five plain words the Person would use, naming the source and never repeating what the card says: "a note you keep", "your trip next week", "a check-in", "yesterday’s conversation".',
  120,
)
const urgency = v.pipe(
  v.picklist(['ordinary', 'urgent']),
  v.description(
    'ordinary unless it cannot wait for a quiet moment in their waking hours: urgent is announced at once, with sound.',
  ),
)

/** The model's card, its sources, where it came from and how soon, as the contract's case. */
const postOf = (
  input: v.InferOutput<typeof card>,
  shown: Pick<PostRequest, 'sources' | 'from' | 'urgency'>,
) =>
  Match.value(input).pipe(
    Match.discriminatorsExhaustive('kind')({
      Drawn: ({ title, display }) => PostRequest.cases.Drawn.make({ title, display, ...shown }),
      Said: ({ title, words, actions }) =>
        PostRequest.cases.Said.make({ title, words, actions, ...shown }),
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
      // Most posts cite nothing beyond the event, so leaving sources out means none.
      input: v.object({ summary, card, from, urgency, sources: v.optional(sources, []) }),
      /** Runtime authority supplies the Person and the Thread; the server keeps one card per Thread. */
      run({ data, signal }) {
        return runTool(
          Effect.gen(function* () {
            // A link the contract would refuse is said back to the model, not failed in transport.
            const invalid = data.sources.find((source) => Option.isNone(checkSource(source)))
            if (invalid !== undefined)
              return {
                output: {
                  ok: false,
                  message: `“${invalid.url}” is not a full http or https address. Give links exactly as you obtained them, or leave sources empty.`,
                },
              }
            // A drawing the screens' parser rejects is said back to the model, as a chat display
            // is (`correction.ts`), so it draws the card again instead of posting a broken one.
            const faults = data.card.kind === 'Drawn' ? drawingFaults(data.card.display) : []
            if (faults.length > 0)
              return {
                output: {
                  ok: false,
                  message: `The display does not draw. OpenUI reported:\n${faults.map((fault) => `- ${fault}`).join('\n')}\nPost it again, fixed.`,
                },
              }
            const { client } = yield* Scope
            return resultOf(
              yield* client.Post(
                postOf(data.card, {
                  sources: data.sources,
                  from: data.from,
                  urgency: data.urgency,
                }),
              ),
            )
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
