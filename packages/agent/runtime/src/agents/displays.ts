import { generateSystemPrompt } from '@openuidev/lang-core'
import spec from './parts.json' with { type: 'json' }

/**
 * Two whole displays the model can copy the shape of. `displays.test.ts` parses both, because a
 * wrong example teaches every reply the same mistake.
 */
export const EXAMPLES = [
  `root = Col([kpi, chart, draft, acts], 3)
kpi = Row([Col([Caption("September revenue"), Title("$182,400", "2xl")], 0), Spacer(), Text([Icon("trending-up", "sm"), " 12% on August"], "sm", "success", "semibold")], 3, "end")
chart = Chart("bar", months, "month", ["revenue"], "currency", "USD", false, 132, "Sep")
months = [{month: "May", revenue: 121000}, {month: "Jun", revenue: 134500}, {month: "Jul", revenue: 149200}, {month: "Aug", revenue: 162900}, {month: "Sep", revenue: 182400}]
draft = Card([Caption("To Ada Obi"), Text("Ada, here are the September numbers. Revenue is up 12% on August.", "sm")], "soft", 3, 1)
acts = Row([Button("Edit", @ToAssistant("Let me edit the reply to Ada"), "soft"), Button("Send", @ToAssistant("Send the reply to Ada"))], 2, null, "end")`,
  `root = Col([flights, acts], 3)
$flight = "Arik Air at 7:10"
flights = Grid([f1, f2], 2, null, 2)
f1 = Pressable([Caption("Arik Air"), Title("7:10", "lg"), Caption("Lands 8:25. ₦98,400")], @Set($flight, "Arik Air at 7:10"), $flight == "Arik Air at 7:10", 3, "canvas")
f2 = Pressable([Caption("Air Peace"), Title("8:40", "lg"), Caption("Lands 9:55. ₦112,750")], @Set($flight, "Air Peace at 8:40"), $flight == "Air Peace at 8:40", 3, "canvas")
acts = Row([Button("Not now", @ToAssistant("Not now"), "soft"), Button("Book " + $flight, @ToAssistant("Book " + $flight))], 2, null, "end")`,
] as const

/**
 * How Vivid is taught to draw a display, the way OpenUI's documentation has an app do it
 * (thesysdev/openui, "Connect the Backend"): OpenUI's own command writes the library's handover
 * spec (`parts.json`, from the web app's `src/parts/library.ts`; run `pnpm --filter @vivid/web
 * parts` after changing a part), and `generateSystemPrompt` turns it into the model's instructions.
 *
 * Vivid uses OpenUI's inline mode: a reply stays ordinary text and holds a display as a fenced
 * `openui-lang` block, which each surface draws while the reply is still arriving. There is no
 * tool between the model and the display. OpenUI writes the syntax, the part signatures and the
 * built-in functions; the lines here are only Vivid's own: when a display is the right answer,
 * that it is a card and not an essay, and that a Button which answers Vivid ends the reply.
 */
export const DISPLAYS = generateSystemPrompt({
  library: spec,
  promptOptions: {
    inlineMode: true,
    bindings: true,
    preamble:
      'Displays. Your replies are ordinary text. When a display makes an answer clearer than words (numbers over time or by category, things compared on the same attributes, a plan and its progress, a choice the Person must make, a letter for them to send, a day’s events, pictures), put one in your reply as a fenced openui-lang block, written in the language described below. Say one sentence before it, never repeat in words what it shows, and never invent data to fill one. Do not draw a display for a single fact or a short answer.',
    additionalRules: [
      'Each fenced block is one whole display with its own root statement. Never send only the changed statements: a later display stands alone.',
      'Lead with the thing itself: a Chart, a Table, tiles to choose from, or the letter in a soft Card. Keep words few; a display is a card, not an essay.',
      'A choice is a row of Pressable tiles bound to one $variable with @Set, and one Button whose label and @ToAssistant message say the choice, as in the second example.',
      'Use @ToAssistant only on a Button that answers you. Its message is what the Person would type, short and first person ("Send the reply to Ada"). End such a display with one Row of Buttons, the way out first as variant "soft", then the answer. That display is the last thing in your reply: stop there and wait for the Person.',
      'Write numbers, money and dates the way they should read. Chart data is plain numbers; name the one bar a single-series bar chart is about with highlight.',
      'Image takes only an http(s) address a tool or the Person gave you. Never guess an address.',
      'Start a display that has pictures with Media([...]) as the first child of the root Col.',
    ],
    examples: [...EXAMPLES],
  },
})
