import { generateSystemPrompt } from '@openuidev/lang-core'
import spec from './parts.json' with { type: 'json' }

/**
 * Whole displays the model can copy the shape of, built only from OpenUI's own parts. The test
 * parses each with OpenUI's parser, because a wrong example teaches every reply the same mistake.
 */
export const EXAMPLES = [
  `A number, the months behind it, and a reply waiting on a yes:

root = Col([kpi, chart, draft, acts], 3)
kpi = Row([Col([Caption("September revenue"), Title("$182,400", "2xl")], 0), Spacer(), Badge("12% on August", "success")], 3, "end")
chart = Chart("bar", months, "month", ["revenue"], "currency", "USD")
months = [{month: "May", revenue: 121000}, {month: "Jun", revenue: 134500}, {month: "Jul", revenue: 149200}, {month: "Aug", revenue: 162900}, {month: "Sep", revenue: 182400}]
draft = Card([Caption("To Ada Obi"), Text("Ada, here are the September numbers. Revenue is up 12% on August.", "sm")], "soft")
acts = Row([Button("Edit", @ToAssistant("Let me edit the reply to Ada"), "ghost"), Button("Send", @ToAssistant("Send the reply to Ada"))], 2, null, "end")`,
  `A choice between two options, pressed in place:

root = Col([Title("Which flight on Thursday?", "lg"), flights, acts], 3)
$flight = "Arik Air at 7:10"
flights = Grid([f1, f2], 2, null, 2)
f1 = Pressable([Caption("Arik Air"), Title("7:10", "lg"), Caption("Lands 8:25. ₦98,400")], @Set($flight, "Arik Air at 7:10"), $flight == "Arik Air at 7:10", 3)
f2 = Pressable([Caption("Air Peace"), Title("8:40", "lg"), Caption("Lands 9:55. ₦112,750")], @Set($flight, "Air Peace at 8:40"), $flight == "Air Peace at 8:40", 3)
acts = Row([Button("Not now", @ToAssistant("Not now"), "ghost"), Button("Book " + $flight, @ToAssistant("Book " + $flight))], 2, null, "end")`,
  `Times to pick from: tiles that select, then one Button that books the pick:

root = Col([Title("Call with Iyin", "lg"), wed, thu, acts], 3)
$slot = "Wed 21 Oct at 9:00"
wed = Col([Caption("Wed 21 Oct"), Row([Pressable([Text("9:00", "sm")], @Set($slot, "Wed 21 Oct at 9:00"), $slot == "Wed 21 Oct at 9:00", 2), Pressable([Text("10:30", "sm")], @Set($slot, "Wed 21 Oct at 10:30"), $slot == "Wed 21 Oct at 10:30", 2), Pressable([Text("1:30 PM", "sm")], @Set($slot, "Wed 21 Oct at 1:30 PM"), $slot == "Wed 21 Oct at 1:30 PM", 2)], 2, null, "start", true)], 1)
thu = Col([Caption("Thu 22 Oct"), Row([Pressable([Text("9:00", "sm")], @Set($slot, "Thu 22 Oct at 9:00"), $slot == "Thu 22 Oct at 9:00", 2), Pressable([Text("11:00", "sm")], @Set($slot, "Thu 22 Oct at 11:00"), $slot == "Thu 22 Oct at 11:00", 2), Pressable([Text("2:00 PM", "sm")], @Set($slot, "Thu 22 Oct at 2:00 PM"), $slot == "Thu 22 Oct at 2:00 PM", 2)], 2, null, "start", true)], 1)
acts = Row([Button("None of these work", @ToAssistant("None of these times work"), "ghost"), Button("Book " + $slot, @ToAssistant("Book Iyin for " + $slot))], 2, null, "end")`,
] as const

/**
 * Displays that reach the Person's Integrations themselves (OpenUI's `Query` and `Mutation`). The
 * tool is named `tool@account`, with the tool and the account exactly as find_tools returned them.
 */
export const TOOL_EXAMPLES = [
  `A live list from an Integration that the Person can filter, with a form that writes back:

root = Col([Title("Open issues", "lg"), search, list, add], 3)
$search = ""
$title = ""
issues = Query("list_issues@GitHub (Work)", {state: "open"}, {rows: []})
shown = @Filter(issues.rows, "title", "contains", $search)
search = Input($search, "Search", "text", "Filter by title")
list = Table(["Issue", "Opened by"], @Each(shown, "i", [i.title, i.author]))
created = Mutation("create_issue@GitHub (Work)", {title: $title})
add = Form([Input($title, "New issue", "text", "What is wrong?"), Button("Open it", Action([@Run(created), @Run(issues), @Reset($title)]))])
failed = created.status == "error" ? Text(created.error, "sm", "danger") : null`,
] as const

/**
 * How Vivid is taught to draw, the way OpenUI's documentation has an app do it ("System Prompts",
 * "Queries & Mutations"): OpenUI's own command writes the library's spec (`parts.json`, from the
 * web app's `src/parts/library.ts`; `pnpm --filter @vivid/web parts` after changing a part), and
 * `generateSystemPrompt` turns it into the model's instructions with every feature the surfaces
 * can run switched on:
 *
 * - `inlineMode`: a reply is ordinary text holding displays in `openui-lang` fences, drawn while
 *   the reply is still arriving. There is no tool between the model and a display.
 * - `bindings`: `$variables`, `@Set` and `@Reset`, so a display works on its own (pick a tile,
 *   filter a list) without another message.
 * - `toolCalls`: `Query` and `Mutation` on the Person's Integrations. The surfaces run them
 *   through the server (`UseDisplayTool`) for the Person who is looking, so a display stays live
 *   and acts in seconds, and every connected app is reachable with no per-app code. Which tools
 *   exist differs for every Person and is found with find_tools, so none is listed here.
 *
 * OpenUI writes the syntax, the part signatures and the built-in functions; the lines below are
 * Vivid's own, and they ask for a display over a wall of text whenever the answer has a shape.
 */
export const DISPLAYS = generateSystemPrompt({
  library: spec,
  promptOptions: {
    inlineMode: true,
    bindings: true,
    toolCalls: true,
    preamble:
      'Displays. Draw an answer instead of writing it whenever it has a shape: numbers, a list, a comparison, a choice, a plan or its progress, a schedule, a letter to send, something to fill in, or anything that lives in one of the Person’s Integrations. Put the display in your reply as a fenced openui-lang block, written in the language described below, with at most one short sentence before it. The display carries the content: never repeat in words what it shows, never answer with a long list, table or several paragraphs when a display could hold it, and never invent data to fill one. Plain words are only for a short answer, a single fact, or a question.',
    additionalRules: [
      'Each fenced block is one whole display with its own root statement. Never send only the changed statements: a later display stands alone.',
      'Lead with the thing itself: a Chart, a Table, tiles to choose from, the letter in a Card. Keep words inside a display few; it is a card, not an essay.',
      'Whenever your reply asks the Person to pick, confirm or answer something, the display holds the controls that do it: a Pressable tile for every option, then the Button that answers, as in the second and third examples. Never draw the options as static Cards or text and then ask in words ("pick one and I will send it").',
      'A choice is Pressable tiles bound to one $variable with @Set, and one Button whose label and @ToAssistant message say the choice, as in the second example.',
      'Use @ToAssistant on a Button that answers you; its message is what the Person would type, short and first person ("Send the reply to Ada"). End such a display with one Row of Buttons, the way out first as variant "ghost", then the answer. That display is the last thing in your reply: stop there and wait.',
      'Tools in Query and Mutation are the Person’s Integrations, named tool@account with the tool and the account exactly as find_tools returned them ("list_issues@GitHub (Work)"). Never invent one: call find_tools first. A Query only reads and runs when the display is drawn; anything that sends, changes or deletes is a Mutation run by a Button the Person presses. When the Person needs to see live data or act on it from the display, prefer Query and Mutation over copying a result you fetched into the program.',
      'Write numbers, money and dates the way they should read. Chart data is plain numbers.',
      'Image takes only an http(s) address a tool or the Person gave you. Never guess an address.',
    ],
    examples: [...EXAMPLES],
    toolExamples: [...TOOL_EXAMPLES],
  },
})
