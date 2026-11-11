import { createParser, generateSystemPrompt } from '@openuidev/lang-core'
import spec from './parts.json' with { type: 'json' }

/**
 * The parser every surface draws with, over the same library: what it reports is what a screen
 * would fail to draw. Chat answers are checked with it before a run settles (`correction.ts`) and
 * Feed posts before they are stored (`tools/feed.ts`).
 */
const parser = createParser(spec.schema, spec.root)

/**
 * What OpenUI's parser reports about one whole program, one line per error, named by the
 * statement it is in, in words the model can act on.
 */
export const drawingFaults = (program: string) =>
  parser
    .parse(program)
    .meta.errors.map((error) =>
      error.statementId === undefined
        ? error.message
        : `\`${error.statementId}\`: ${error.message}`,
    )

/**
 * Whole displays the model copies the shape of, built only from this library's parts. They lead
 * with the thing itself, as the 13 October Feed design does: a chart, the letter, tiles with their
 * pictures, a map, a week, the invoice, the page. On 11 November 2026 every one of the 17 chat
 * displays read in production was text in a Card, List or Table, the shape the earlier examples
 * taught.
 */
const EXAMPLES = [
  `A number and the months behind it:

root = Col([kpi, chart], 3)
kpi = Row([Col([Caption("September revenue"), Title("$182,400", "2xl")], 0), Spacer(), Badge("+12% on August", "success")], 3, "end")
chart = Chart("bar", months, "month", ["revenue"], "currency", "USD")
months = [{month: "May", revenue: 121000}, {month: "Jun", revenue: 134500}, {month: "Jul", revenue: 149200}, {month: "Aug", revenue: 162900}, {month: "Sep", revenue: 182400}]`,
  `A reply drafted for the Person: the letter itself, bare, and the Buttons that answer:

root = Col([Caption("To Ada Obi · Re: September numbers"), letter, acts], 2)
letter = Text("Ada, here are the September numbers. Revenue is up 12% on August, led by the Lagos accounts.", "md")
acts = Row([Button("Edit", @ToAssistant("Let me edit the reply to Ada"), "ghost"), Button("Send", @ToAssistant("Send the reply to Ada"))], 2, null, "end")`,
  `Places from pages you read, each with the picture read_page listed for it, to pick from:

root = Col([picks, acts], 3)
$pick = "Nok by Alara"
picks = Carousel([p1, p2, p3], 220)
p1 = Pressable([Image("https://nokbyalara.com/images/dining-room.jpg", "The dining room at Nok by Alara", 1.33, "md"), Text("Nok by Alara", "sm", null, "semibold"), Caption("West African · 12 min away")], @Set($pick, "Nok by Alara"), $pick == "Nok by Alara", 2)
p2 = Pressable([Image("https://thewheatbaker.com/media/lagos-cafe.jpg", "The terrace at The Wheatbaker", 1.33, "md"), Text("The Wheatbaker", "sm", null, "semibold"), Caption("Brasserie · 9 min away")], @Set($pick, "The Wheatbaker"), $pick == "The Wheatbaker", 2)
p3 = Pressable([Image("https://cactuslagos.com/img/interior.jpg", "Inside Cactus", 1.33, "md"), Text("Cactus", "sm", null, "semibold"), Caption("Grill · 15 min away")], @Set($pick, "Cactus"), $pick == "Cactus", 2)
acts = Row([Button("Not now", @ToAssistant("Not now"), "ghost"), Button("Book " + $pick, @ToAssistant("Book a table for two at " + $pick + " on Friday at 8"))], 2, null, "end")`,
  `A choice between two options, pressed in place:

root = Col([flights, acts], 3)
$flight = "Arik Air at 7:10"
flights = Grid([f1, f2], 2, null, 2)
f1 = Pressable([Caption("Arik Air"), Title("7:10", "lg"), Caption("Lands 8:25. ₦98,400")], @Set($flight, "Arik Air at 7:10"), $flight == "Arik Air at 7:10", 3)
f2 = Pressable([Caption("Air Peace"), Title("8:40", "lg"), Caption("Lands 9:55. ₦112,750")], @Set($flight, "Air Peace at 8:40"), $flight == "Air Peace at 8:40", 3)
acts = Row([Button("Not now", @ToAssistant("Not now"), "ghost"), Button("Book " + $flight, @ToAssistant("Book " + $flight))], 2, null, "end")`,
  `A drawn Feed card about money: the invoice itself, its amount once, its lines, and the Buttons. No sentence restates what it shows:

root = Col([head, lines, acts], 3)
head = Row([Col([Caption("Lumen Studios · Invoice 0142"), Title("₦420,000", "2xl")], 0), Spacer(), Badge("Due Friday", "warning")], 3, "end")
lines = Table(["Item", "Amount"], [["Brand film, final cut", "₦350,000"], ["Two revision rounds", "₦70,000"]])
acts = Row([Button("Not now", @ToAssistant("Do not pay Lumen Studios yet"), "ghost"), Button("Pay it", @ToAssistant("Pay Lumen Studios invoice 0142"))], 2, null, "end")`,
  `A drawn Feed card about something someone owes the Person: what it is, who and since when, and the Buttons:

root = Col([Title("September report", "lg"), Caption("Ada Obi · asked 7 Nov"), acts], 2)
acts = Row([Button("Leave it", @ToAssistant("Leave Ada's report for now"), "ghost"), Button("Nudge Ada", @ToAssistant("Send Ada a nudge about the September report"))], 2, null, "end")`,
  `A drawn Feed card about the week: the strip of days with the day it is about marked, the one line it needs, the Buttons:

root = Col([week, Caption("Nothing on the calendar for the audit call you took on 7 Nov."), acts], 2)
week = Week([{day: "Mon", date: "9", items: [{time: "11:00", title: "Garden onboarding"}]}, {day: "Tue", date: "10", items: [{time: "17:00", title: "Flow Team Leads"}], marked: true}, {day: "Wed", date: "11"}, {day: "Thu", date: "12", items: [{time: "17:00", title: "Product sync"}]}, {day: "Fri", date: "13"}])
acts = Row([Button("Leave it", @ToAssistant("Leave the audit call for now"), "ghost"), Button("Find a slot", @ToAssistant("Find a slot next week for the audit call"))], 2, null, "end")`,
  `A drawn Feed card about a place: the map, the one line under it, the Buttons:

root = Col([map, Caption("Dinner moved to Nok by Alara, Friday at 8:00 PM."), acts], 2)
map = Map([MapMarker("Office", 6.4281, 3.4219, "🏢"), MapMarker("Nok by Alara", 6.4355, 3.4306, "🍽️")], true)
acts = Row([Button("Not now", @ToAssistant("Not now"), "ghost"), Button("Add to my calendar", @ToAssistant("Add dinner at Nok by Alara on Friday to my calendar"))], 2, null, "end")`,
  `A drawn Feed card about work on your Computer: the page you found, with its picture, and the screen where it waits:

root = Col([page, screen, acts], 2)
page = Page("https://www.airpeace.com/booking/LOS-ABV", "Lagos to Abuja, Thursday 22 Oct", "Air Peace", "https://www.airpeace.com/booking/LOS-ABV/cover.jpg", "Seat 4A held until 6:00 PM. ₦112,750 with one bag.")
screen = Screen("The Air Peace booking, filled in, on its payment page")
acts = Row([Button("Not now", @ToAssistant("Do not book the Air Peace flight yet"), "ghost"), Button("Book it", @ToAssistant("Book the Air Peace flight on Thursday"))], 2, null, "end")`,
] as const

/**
 * Displays that reach the Person's Integrations themselves (OpenUI's `Query` and `Mutation`). The
 * tool is named `tool@account`, with the tool and the account exactly as find_tools returned them.
 */
const TOOL_EXAMPLES = [
  `A live list from an Integration that the Person can filter, with a form that writes back:

root = Col([Title("Open issues", "lg"), search, list, add, failed], 3)
$search = ""
$title = ""
issues = Query("list_issues@GitHub (Work)", {state: "open"}, {rows: []})
shown = @Filter(issues.rows, "title", "contains", $search)
search = Input($search, "Search", "text", "Filter by title")
list = Table(["Issue", "Opened by"], @Each(shown, "i", [i.title, i.author]))
created = Mutation("create_issue@GitHub (Work)", {title: $title})
add = Form([Input($title, "New issue", "text", "What is wrong?"), Button("Open it", Action([@Run(created), @Run(issues), @Reset($title)]))])
failed = created.status == "error" ? Text(created.error, "sm", "danger") : null`,
  `A live answer worked out by a program on the Person's Computer, and a button that runs another:

root = Col([Title("Downloads folder", "lg"), Text(size.text, "sm"), acts], 3)
size = Query("run_code", {code: "const { execSync } = await import('node:child_process'); return { text: execSync('du -sh ~/Downloads').toString().trim() }", summary: "Measure the Downloads folder"}, {text: "Measuring…"})
acts = Row([Button("Not now", @ToAssistant("Leave the Downloads folder as it is"), "ghost"), Button("Clear it", @ToAssistant("Clear my Downloads folder"))], 2, null, "end")`,
] as const

/**
 * An example that does not draw teaches every display the same mistake, so the process does not
 * start with one. This replaces the test that parsed them, removed with the unit tests.
 */
for (const example of [...EXAMPLES, ...TOOL_EXAMPLES]) {
  const faults = drawingFaults(example.slice(example.indexOf('root =')))
  if (faults.length > 0) throw new Error(`A display example does not draw: ${faults.join('; ')}`)
}

/**
 * Query, Mutation and the fence, taught in this library's own parts. OpenUI's `toolCalls` and
 * `inlineMode` options write these sections for its reference library instead: on 11 November
 * 2026 they put `FormControl`, `SelectItem`, `TextContent` and another `Form`, `Input` and
 * `Button` signature in front of the model twelve times, with rules that contradict Vivid's
 * ("NEVER hardcode tool results as literal arrays", "output ONLY the changed statements"). So the
 * prompt is generated with `bindings` alone and these lines say the rest.
 */
const LIVE_DATA = [
  'Put each display in your reply as one fenced block that opens with ```openui-lang and holds a whole program starting with its root statement. Words outside the fence are your message. A later display stands alone: never send only the statements that changed.',
  'A display can reach the Person’s Integrations itself and stay live. name = Query("tool@account", {args}, defaults) reads when the display is drawn and shows defaults until the result arrives; read it with dot access (issues.rows, issues.rows.title). name = Mutation("tool@account", {args}) runs only when a Button runs it with @Run(name); name.status is "idle", "loading", "success" or "error", and name.error says what failed. Action([@Run(created), @Run(issues), @Reset($title)]) runs several steps in order; @Run(query) reads it again. Name a Query or Mutation without $.',
  'Tools in Query and Mutation are the Person’s Integrations, named tool@account with the tool and the account exactly as find_tools returned them ("list_issues@GitHub (Work)"). Never invent one: call find_tools first. A Query only reads; anything that sends, changes or deletes is a Mutation run by a Button the Person presses. Use them when the Person will look at the data again or act on it from the display. A Feed card or a one-off answer draws the values you found as literals.',
  'An Integration you made with make_integration is one of the Person’s Integrations: when no Integration holds what a display needs to keep live or change (a tracker, a list), make one whose tools read and change it, then bind those tools with Query and Mutation.',
  'A display can run a program on the Person’s Computer the way run_code does: Query("run_code", {code, summary}, default) or Mutation("run_code", {code, summary}), with no @account. The program’s returned JSON is the result. A Query program runs whenever the display is drawn and may only read: its Integration calls must be reads and the browser is refused. Anything that changes something is a Mutation run by a Button, and goes through approval like run_code. Write code and summary as literal strings in the declaration itself, never built from variables or other values, or the display will refuse to run it. Never use run_code in both a Query and a Mutation in one display. Prefer an Integration’s own tool when one does the job.',
]

/**
 * How Vivid is taught to draw, the way OpenUI's documentation has an app do it ("System Prompts"):
 * OpenUI's own command writes the library's spec (`parts.json`, from the web app's
 * `src/parts/library.ts`; `pnpm --filter @vivid/web parts` after changing a part), and
 * `generateSystemPrompt` writes the syntax, the part signatures, the built-in functions and the
 * actions from it. `bindings` is on, so a display works on its own (pick a tile, filter a list)
 * with `$variables`, `@Set` and `@Reset`. The lines below are Vivid's own: draw the thing itself,
 * with pictures, and never say twice what the drawing shows.
 */
export const DISPLAYS = generateSystemPrompt({
  library: spec,
  promptOptions: {
    bindings: true,
    preamble:
      'Displays. When an answer has a shape, draw the thing itself instead of describing it: a place is a Map, days and times are a Week, a page you read is a Page with its picture, something with a look (a venue, a dish, a product, a building) is its Image, numbers over time or categories are a Chart, a comparison is a Table, options are tiles to press, a letter is the letter, an invoice or a booking is the document with its amount and its lines. Put the display in your reply with at most one short sentence before it. The display carries the content: never say in words what it shows, never write a sentence inside it that repeats it, and never invent data to fill one. Plain words are only for a short answer, a single fact, or a question.',
    additionalRules: [
      ...LIVE_DATA,
      'Lead with the picture or the thing, then at most one short line of words per block: a Caption under a picture, a Text for the one thing a picture cannot say. A display is a card, not an essay; a paragraph inside one is a mistake.',
      'Draw each kind of thing in its own shape, from the example closest to it; never borrow another kind’s shape. A Table holds two rows or more; one fact is a Title or a Caption, not a one-row Table.',
      'Say each fact once. Every part of a display must tell the Person something no other part, and nothing around the display, already tells them; when two parts say the same thing, keep the one that shows it best and delete the other. ("Pay it", not "Pay ₦420,000" under a ₦420,000 Title.)',
      'The surface already draws the display on a card of its own. Never wrap the whole display in a Card; Card groups one block inside a larger display.',
      'Every page read_page returns lists its pictures, the page’s own lead picture first. Use those addresses for Image and for a Page’s picture, and the page’s own address for a Page. An address must come from a page or tool result you read or from the Person; never make one up. When you have no address for a picture, leave the picture out rather than describe it.',
      'A MapMarker needs the place’s real latitude and longitude, from a tool or a place you know for certain. Never guess coordinates; without them, draw the place’s Page or Image instead.',
      'Whenever your reply asks the Person to choose, confirm or answer, the display holds the controls that do it; never draw the options as static Cards or text and then ask in words ("pick one and I will send it"). Choosing among options is a Pressable tile for each, bound to one $variable with @Set, then one Button whose label and @ToAssistant message say the choice. Confirming or answering is Buttons alone.',
      'Use @ToAssistant on a Button that answers you; its message is what the Person would type, short and first person ("Send the reply to Ada"). A Button’s action is always an @ step, never a string. End such a display with one Row of Buttons, the way out first as variant "ghost", then the answer. That display is the last thing in your reply: stop there and wait.',
      'Write numbers, money and dates the way they should read. Chart data is plain numbers.',
    ],
    examples: [...EXAMPLES],
    toolExamples: [...TOOL_EXAMPLES],
  },
})
