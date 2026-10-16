import type { AssistantMessage, Context, ToolCall, ToolResultMessage } from '@earendil-works/pi-ai'
import {
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
  type FauxContentBlock,
} from '@earendil-works/pi-ai/providers/faux'
import { CodeFailure, DesktopAction } from '@vivid/contracts'
import { Array, Option, Predicate, Schema } from 'effect'
import { modelText } from '../../tools/views.ts'

/** Tool output is JSON text at pi's ingress; only human fields may reach rehearsal prose. */
const Receipt = Schema.fromJsonString(
  Schema.Struct({
    ok: Schema.optionalKey(Schema.Boolean),
    message: Schema.optionalKey(Schema.String),
    reason: Schema.optionalKey(Schema.String),
    title: Schema.optionalKey(Schema.String),
    created: Schema.optionalKey(Schema.Boolean),
    changed: Schema.optionalKey(Schema.Boolean),
    version: Schema.optionalKey(Schema.Finite),
    body: Schema.optionalKey(Schema.String),
    result: Schema.optionalKey(
      Schema.Union([Schema.Finite, Schema.Struct({ title: Schema.String })]),
    ),
    catalog: Schema.optionalKey(Schema.String),
    remembered: Schema.optionalKey(Schema.String),
    added: Schema.optionalKey(Schema.Boolean),
    account: Schema.optionalKey(Schema.String),
    integrations: Schema.optionalKey(Schema.Array(Schema.Struct({ name: Schema.String }))),
    view: Schema.optionalKey(Schema.Struct({ width: Schema.Finite, height: Schema.Finite })),
    failure: Schema.optionalKey(CodeFailure),
  }),
)
const decodeReceipt = Schema.decodeUnknownOption(Receipt)
type Step = (context: Context) => FauxContentBlock[]
interface Scene {
  readonly phrase: string
  readonly steps: readonly Step[]
}

/** pi exposes Flue's instruction-change marker as a user message, but it is not a new Person delivery. */
function isDelivery(message: Context['messages'][number]) {
  if (message.role !== 'user') return false
  const text = Predicate.isString(message.content)
    ? message.content
    : message.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('\n')
  return text !== '<signal type="instructions">\nSystem instructions updated.\n</signal>'
}

/** A call's identity and message time are derived from history, so replay is byte-for-byte stable. */
function call(context: Context, name: string, input: ToolCall['arguments'], index = 0) {
  return fauxToolCall(name, input, { id: `rehearsal:${context.messages.length}:${index}` })
}

/**
 * Display examples are explicitly rehearsal data. A display is part of the reply itself: words,
 * then the program in an `openui-lang` fence, as OpenUI's inline mode has the model write it.
 */
export const fenced = (program: string) => `\`\`\`openui-lang\n${program}\n\`\`\``

function display(phrase: string, shown: string): Scene {
  return {
    phrase,
    steps: [() => [fauxText(`Here’s a rehearsal example.\n\n${fenced(shown)}`)]],
  }
}

/** Every scene closes using the actual receipt, including unavailable dependencies, rather than promising success. */
function completion(context: Context): FauxContentBlock[] {
  const latest = Option.getOrElse(Array.findLastIndex(context.messages, isDelivery), () => -1)
  const results = context.messages
    .slice(latest + 1)
    .filter((message) => message.role === 'toolResult')
  if (results.length === 0) return [fauxText('I haven’t received a result yet.')]
  return [fauxText(results.map(resultWords).join(' '))]
}

/** Failure messages are already sanitized by the real tool boundary; identifiers are filtered once more for prose. */
function resultWords(result: ToolResultMessage): string {
  const content = result.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
  const receipt = decodeReceipt(content)
  if (Option.isNone(receipt)) return 'I couldn’t read the result.'
  const value = receipt.value
  if (result.isError || value.ok === false || value.added === false) {
    const detail = value.message ?? value.reason
    if (detail !== undefined)
      return `${result.toolName === 'remember' ? 'I couldn’t save that memory' : 'That didn’t finish'}: ${modelText(detail)}`
    if (value.failure !== undefined) return `That didn’t finish: ${failureWords(value.failure)}.`
    return 'That didn’t finish; the tool reported a failure.'
  }
  if (value.catalog === 'unavailable') return 'The integration catalogue is unavailable right now.'
  return successWords(result.toolName, value)
}

/** Code failure tags guide the reply but stay out of product prose. */
function failureWords(failure: CodeFailure): string {
  return CodeFailure.match(failure, {
    Threw: ({ message }) => modelText(message),
    TimedOut: () => 'The program timed out',
    OverLimit: () => 'The program exceeded its limits',
    Unavailable: () => 'The program is unavailable',
  })
}

/** Rehearsal confirms only the version changes the actual write receipt reports. */
function documentWords(value: typeof Receipt.Type) {
  if (
    value.title === undefined ||
    value.version === undefined ||
    value.created === undefined ||
    value.changed === undefined
  )
    return 'The document was not confirmed.'
  if (!value.changed)
    return `The document “${modelText(value.title)}” is unchanged at version ${value.version}.`
  return `${value.created ? 'I wrote' : 'I revised'} “${modelText(value.title)}” at version ${value.version}.`
}

/** Each receipt reader owns one tool's affirmative evidence, keeping failure handling shared. */
const success = {
  write_document: (value: typeof Receipt.Type) => documentWords(value),
  read_document: (value: typeof Receipt.Type) =>
    value.title === undefined || value.body === undefined || value.version === undefined
      ? 'The document was not returned.'
      : `I read “${modelText(value.title)}” at version ${value.version}.`,
  read_page: (value: typeof Receipt.Type) =>
    value.title === undefined
      ? 'The page returned no title.'
      : `The page is titled “${modelText(value.title)}”.`,
  run_code: (value: typeof Receipt.Type) =>
    Predicate.isNumber(value.result)
      ? `The sum is ${value.result}.`
      : 'The program returned no numeric sum.',
  remember: (value: typeof Receipt.Type) =>
    value.remembered === undefined
      ? 'The memory was not confirmed.'
      : `I remembered: ${modelText(value.remembered)}`,
  find_integrations: (value: typeof Receipt.Type) =>
    value.integrations === undefined
      ? 'The search returned no integration list.'
      : `The search returned ${value.integrations.length} matches${value.integrations.length === 0 ? '.' : `: ${value.integrations.map((entry) => modelText(entry.name)).join(', ')}.`}`,
  add_integration: (value: typeof Receipt.Type) =>
    value.added === true && value.account !== undefined
      ? `I added the ${modelText(value.account)} integration.`
      : 'The integration is not confirmed connected.',
  browse: (value: typeof Receipt.Type) =>
    !Predicate.isObject(value.result)
      ? 'The browser returned no page result.'
      : `The browser opened “${modelText(value.result.title)}”; open the computer to see it.`,
  use_desktop: (value: typeof Receipt.Type) =>
    value.view === undefined
      ? 'The computer returned no screenshot receipt.'
      : `The computer returned a ${value.view.width} by ${value.view.height} screenshot.`,
} satisfies Record<string, (value: typeof Receipt.Type) => string>

/** Tool names come from pi history; unknown names are never treated as known successes. */
function successWords(name: string, value: typeof Receipt.Type): string {
  const reader = Object.entries(success).find(([tool]) => tool === name)
  return reader === undefined ? 'The result is above.' : reader[1](value)
}

/** Real tool names and valid example inputs are kept with the scene, with no product authority in the script. */
function toolScene(phrase: string, name: string, input: ToolCall['arguments']): Scene {
  return { phrase, steps: [(context) => [call(context, name, input)], completion] }
}

const examples = [
  display(
    'show a table',
    'root = Col([Title("Rehearsal workload", "lg"), Table(["Project", "Hours", "Owner"], [["Research", "4", "Rae"], ["Writing", "3", "Rae"], ["Review", "2", "Sam"]]), Caption("Example values for this rehearsal.")], 3)',
  ),
  ...(
    [
      ['bar', 'show a chart'],
      ['line', 'show a line chart'],
      ['donut', 'show a share chart'],
    ] as const
  ).map(([kind, phrase]) =>
    display(
      phrase,
      `root = Col([Title("Rehearsal hours", "lg"), Chart("${kind}", rows, "task", ["hours"])], 3)\nrows = [{task: "Research", hours: 4}, {task: "Writing", hours: 3}, {task: "Review", hours: 2}]`,
    ),
  ),
  display(
    'show steps',
    'root = Col([Title("Rehearsal plan", "lg"), List([ListItem("Research", "Done yesterday.", "✓"), ListItem("Writing", "Under way."), ListItem("Review")], "number", true)], 3)',
  ),
  display(
    'show options',
    'root = Col([Title("Which day suits the rehearsal?", "lg"), Grid([a, b], 2, null, 2), Row([Button("Not now", @ToAssistant("Not now"), "soft"), Button("Pick " + $day, @ToAssistant("Pick " + $day))], 2, null, "end")], 3)\n$day = "Monday"\na = Pressable([Text("Monday", "md", null, "semibold"), Caption("More time to prepare.")], @Set($day, "Monday"), $day == "Monday", 3, "canvas")\nb = Pressable([Text("Tuesday", "md", null, "semibold"), Caption("The whole team is in.")], @Set($day, "Tuesday"), $day == "Tuesday", 3, "canvas")',
  ),
  display(
    'show many options',
    'root = Col([Title("Which topics should the rehearsal cover?", "lg"), Form([Checkbox($research, "Research"), Checkbox($writing, "Writing"), Checkbox($review, "Review"), Button("Use these", @ToAssistant("Use these topics"))])], 3)\n$research = true\n$writing = false\n$review = false',
  ),
  display(
    'show a comparison',
    'root = Col([Title("Rehearsal plans", "lg"), Grid([a, b], 2, null, 2)], 3)\na = Card([Row([Text("Basic", "sm", null, "semibold"), Badge("Suggested", "info")], 2, "center", null, true), Text([Icon("check", "sm", "success"), " Cheap"], "xs"), Text([Icon("minus", "sm", "danger"), " Limited"], "xs"), Divider(), Row([Caption("Cost"), Spacer(), Text("10 NGN", "xs", null, "semibold")])], "soft", 3, 1.5)\nb = Card([Text("Pro", "sm", null, "semibold"), Text([Icon("check", "sm", "success"), " Everything"], "xs"), Text([Icon("minus", "sm", "danger"), " Costs more"], "xs"), Divider(), Row([Caption("Cost"), Spacer(), Text("30 NGN", "xs", null, "semibold")])], "soft", 3, 1.5)',
  ),
  display(
    'show links',
    'root = Col([Title("Rehearsal sources", "lg"), List([ListItem("Example", "A page kept for examples.", null, [Link("example.com", "https://example.com")]), ListItem("Example organisation", "Its sister page.", null, [Link("example.org", "https://example.org")])])], 3)',
  ),
  display(
    'show facts',
    'root = Col([Title("Rehearsal week", "lg"), Grid([Col([Caption("Hours"), Title("9", "xl"), Text("+2 on last week", "xs", "success", "semibold")], 0.5), Col([Caption("Open tasks"), Title("3", "xl"), Text("+1 on last week", "xs", "danger", "semibold")], 0.5)], 2, null, 3)], 3)',
  ),
  display(
    'show a draft',
    'root = Col([Card([Caption("To Rae"), Text("Rehearsal notes", "md", null, "semibold"), Text("Rae, the rehearsal notes are attached. Tell me what to change.", "sm")], "soft", 4, 1.5), Row([Button("Edit", @ToAssistant("Let me edit the note to Rae"), "soft"), Button("Send", @ToAssistant("Send the note to Rae"))], 2, null, "end")], 3)',
  ),
  display(
    'show a schedule',
    'root = Col([Title("Rehearsal day", "lg"), List([ListItem("Research", "Library, until 10:30", "09:00"), ListItem("Writing", "Desk", "11:00"), ListItem("Review", "Call with Sam", "15:00")], "none", true)], 3)',
  ),
  display(
    'show a form',
    'root = Col([Title("Rehearsal details", "lg"), Form([Input($name, "Name", "text", "Rae"), TextArea($notes, "Notes"), Input($people, "People", "number"), Select($topic, ["Research", "Writing"], "Topic"), Button("Send details", @ToAssistant("Send details"))])], 3)\n$name = ""\n$notes = ""\n$people = 1\n$topic = "Research"',
  ),
  display(
    'show pictures',
    'root = Col([Carousel([Image("https://example.com/one.jpg", "First rehearsal picture"), Image("https://example.com/two.jpg", "Second rehearsal picture")]), Caption("Example pictures for this rehearsal.")], 3)',
  ),
  toolScene('write a document', 'write_document', {
    summary: 'Rehearsal plan',
    title: 'Rehearsal plan',
    body: '# Rehearsal plan\n\n1. Review the results.\n2. Choose the next step.',
  }),
  toolScene('revise the document', 'write_document', {
    summary: 'Rehearsal plan revision',
    title: 'Rehearsal plan',
    body: '# Rehearsal plan\n\n1. Review the results.\n2. Ask for a review.\n3. Choose the next step.',
    note: 'Added a review before choosing the next step.',
  }),
  toolScene('read the document', 'read_document', {
    summary: 'Rehearsal plan review',
    title: 'Rehearsal plan',
  }),
  toolScene('read example', 'read_page', {
    summary: 'Public example page',
    address: 'https://example.com',
  }),
  toolScene('run a program', 'run_code', {
    code: 'const numbers = [2, 3, 4]; return numbers.reduce((sum, number) => sum + number, 0);',
    summary: 'Add three example numbers.',
  }),
  toolScene('find google', 'find_integrations', { summary: 'Google accounts', query: 'google' }),
  toolScene('add exa', 'add_integration', {
    summary: 'Exa connection',
    address: 'https://mcp.exa.ai/mcp',
    name: 'Exa',
  }),
  toolScene('remember that', 'remember', {
    summary: 'Morning review preference',
    kind: 'preference',
    content: 'Rae prefers reviewing work in the morning.',
    forCompany: false,
  }),
  toolScene('ask me', 'ask_person', {
    questions: [
      {
        question: 'Which rehearsal topic should we review?',
        options: [
          { label: 'Research', detail: 'Review the sources.' },
          { label: 'Writing', detail: 'Review the draft.' },
        ],
        several: true,
        allowsOwnAnswer: true,
      },
      {
        question: 'How much detail would you like?',
        options: [
          { label: 'Brief', detail: 'The main points.' },
          { label: 'Thorough', detail: 'The full review.' },
        ],
        several: false,
        allowsOwnAnswer: false,
      },
      {
        question: 'What should the review focus on?',
        options: [],
        several: false,
        allowsOwnAnswer: true,
      },
    ],
  }),
  toolScene('browse example', 'browse', {
    action: { kind: 'open', address: 'https://example.com' },
    summary: 'Open the public example page on the computer.',
  }),
  toolScene('use the desktop', 'use_desktop', {
    action: DesktopAction.cases.Look.make({}),
    summary: 'Capture the computer screen.',
  }),
  {
    phrase: 'two things',
    steps: [
      (context: Context) => [
        call(context, 'read_page', {
          summary: 'Public example page',
          address: 'https://example.com',
        }),
        call(
          context,
          'run_code',
          { code: 'return 2 + 3;', summary: 'Add two example numbers.' },
          1,
        ),
      ],
      completion,
    ],
  },
] satisfies Scene[]

/** The help reply and tests derive their vocabulary from the same authoritative scenes. */
export const phrases = Object.freeze(examples.map((scene) => scene.phrase))

/** Reconstruct the scene and step solely from pi history; no counters, clock, randomness or network belong here. */
export function script(context: Context): AssistantMessage {
  const index = Option.getOrElse(Array.findLastIndex(context.messages, isDelivery), () => -1)
  const person = context.messages[index]
  const timestamp = person === undefined ? 0 : person.timestamp
  const text =
    person === undefined || person.role !== 'user'
      ? ''
      : Predicate.isString(person.content)
        ? person.content
        : person.content
            .filter((block) => block.type === 'text')
            .map((block) => block.text)
            .join('\n')
  const scene = examples.find((candidate) => text.toLowerCase().includes(candidate.phrase))
  const count = context.messages
    .slice(index + 1)
    .filter((message) => message.role === 'assistant').length
  const step = scene === undefined ? undefined : scene.steps[count]
  const blocks =
    step === undefined
      ? [fauxText(`Try one of these phrases: ${phrases.join(', ')}.`)]
      : step(context)
  const stopReason = blocks.some((block) => block.type === 'toolCall') ? 'toolUse' : 'stop'
  return fauxAssistantMessage(structuredClone(blocks), { timestamp, stopReason })
}
