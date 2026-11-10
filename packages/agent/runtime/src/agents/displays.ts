import { generateSystemPrompt } from '@openuidev/lang-core'
import spec from './parts.json' with { type: 'json' }

/**
 * Whole displays the model can copy the shape of, built only from OpenUI's own parts. The test
 * parses each with OpenUI's parser, because a wrong example teaches every reply the same mistake.
 */
const EXAMPLES = [
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
  `A drawn Feed card: the letter itself, drafted and ready, with what it carries and the Buttons that answer. A Feed card is already a card, so its letter sits on it bare, never in a Card of its own:

root = Col([Caption("To Dana Bello"), letter, files, acts], 2)
letter = Text("Dana, Friday at 10 works. I will bring the revised deck and the September numbers.", "md")
files = Row([Badge("deck-v3.pdf"), Badge("september.xlsx")], 2)
acts = Row([Button("Not now", @ToAssistant("Not now"), "ghost"), Button("Send it", @ToAssistant("Send the reply to Dana"))], 2, null, "end")`,
  `A drawn Feed card about a place: the map itself first, the one line it needs under it, then the Buttons:

root = Col([map, Text("Dinner moved to Nok by Alara, Friday at 8:00 PM. It is 12 minutes from the office.", "sm"), acts], 2)
map = Map([MapMarker("Office", 6.4281, 3.4219, "🏢"), MapMarker("Nok by Alara", 6.4355, 3.4306, "🍽️")], true)
acts = Row([Button("Not now", @ToAssistant("Not now"), "ghost"), Button("Add it to my calendar", @ToAssistant("Add dinner at Nok by Alara on Friday to my calendar"))], 2, null, "end")`,
  `A drawn Feed card about the week: the strip of days, the day that changed marked:

root = Col([Caption("Week of 19 Oct"), week, acts], 2)
week = Week([{day: "Mon", date: "19", items: [{time: "9:00", title: "Standup"}]}, {day: "Tue", date: "20", items: [{time: "10:30", title: "Design review"}, {time: "2:00 PM", title: "Call with Iyin"}], marked: true}, {day: "Wed", date: "21"}, {day: "Thu", date: "22", items: [{time: "11:00", title: "Board prep"}]}, {day: "Fri", date: "23"}])
acts = Row([Button("Keep it", @ToAssistant("Keep the call with Iyin on Tuesday"), "ghost"), Button("Move it", @ToAssistant("Move the call with Iyin to another day"))], 2, null, "end")`,
  `A drawn Feed card about work on your Computer: the page you found, and the screen where it waits for a last look:

root = Col([page, screen, acts], 2)
page = Page("https://www.airpeace.com/booking/LOS-ABV", "Lagos to Abuja, Thursday 22 Oct", "Air Peace", "https://www.airpeace.com/booking/LOS-ABV/cover.jpg", "Seat 4A is held until 6:00 PM. ₦112,750 with one bag.")
screen = Screen("The Air Peace booking, filled in, on its payment page")
acts = Row([Button("Not now", @ToAssistant("Do not book the Air Peace flight yet"), "ghost"), Button("Book it", @ToAssistant("Book the Air Peace flight on Thursday"))], 2, null, "end")`,
] as const

/**
 * Displays that reach the Person's Integrations themselves (OpenUI's `Query` and `Mutation`). The
 * tool is named `tool@account`, with the tool and the account exactly as find_tools returned them.
 */
const TOOL_EXAMPLES = [
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
  `A live answer worked out by a program on the Person's Computer, and a button that runs another:

root = Col([Title("Downloads folder", "lg"), Text(size.text, "sm"), acts], 3)
size = Query("run_code", {code: "const { execSync } = await import('node:child_process'); return { text: execSync('du -sh ~/Downloads').toString().trim() }", summary: "Measure the Downloads folder"}, {text: "Measuring…"})
acts = Row([Button("Not now", @ToAssistant("Leave the Downloads folder as it is"), "ghost"), Button("Clear it", @ToAssistant("Clear my Downloads folder"))], 2, null, "end")`,
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
      'When it is about a place, draw the Map; about days or times in a week, the Week; about a web page you read, the Page with its title, site, picture and summary as the page gave them; about work on your Computer the Person should look at, the Screen. The picture comes first and the words go under it (the last three examples).',
      'A MapMarker needs the place’s real latitude and longitude, from a tool or a place you know for certain. Never guess coordinates; without them, say the place in words.',
      'Whenever your reply asks the Person to choose, confirm or answer, the display holds the controls that do it; never draw the options as static Cards or text and then ask in words ("pick one and I will send it"). Choosing among options is a Pressable tile for each, then the Button that answers (second and third examples); confirming or answering is Buttons alone (first example).',
      'A choice is Pressable tiles bound to one $variable with @Set, and one Button whose label and @ToAssistant message say the choice, as in the second example.',
      'Use @ToAssistant on a Button that answers you; its message is what the Person would type, short and first person ("Send the reply to Ada"). End such a display with one Row of Buttons, the way out first as variant "ghost", then the answer. That display is the last thing in your reply: stop there and wait.',
      'Tools in Query and Mutation are the Person’s Integrations, named tool@account with the tool and the account exactly as find_tools returned them ("list_issues@GitHub (Work)"). Never invent one: call find_tools first. A Query only reads and runs when the display is drawn; anything that sends, changes or deletes is a Mutation run by a Button the Person presses. When the Person needs to see live data or act on it from the display, prefer Query and Mutation over copying a result you fetched into the program.',
      'An Integration you made with make_integration is one of the Person’s Integrations: when no Integration holds what a display needs to keep live or change (a tracker, a list), make one whose tools read and change it, then bind those tools with Query and Mutation.',
      'A display can run a program on the Person’s Computer the way run_code does: Query("run_code", {code, summary}, default) or Mutation("run_code", {code, summary}), with no @account. The program’s returned JSON is the result. A Query program runs whenever the display is drawn and may only read: its Integration calls must be reads and the browser is refused. Anything that changes something is a Mutation run by a Button, and goes through approval like run_code. Write code and summary as literal strings in the declaration itself, never built from variables or other values, or the display will refuse to run it. Never use run_code in both a Query and a Mutation in one display. Prefer an Integration’s own tool when one does the job.',
      'Write numbers, money and dates the way they should read. Chart data is plain numbers.',
      'Image, and a Page’s url and image, take only an http(s) address a tool or the Person gave you. Never guess an address.',
    ],
    examples: [...EXAMPLES],
    toolExamples: [...TOOL_EXAMPLES],
  },
})
