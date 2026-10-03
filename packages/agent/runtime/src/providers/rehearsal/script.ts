import type { AssistantMessage, Context, ToolCall, ToolResultMessage } from '@earendil-works/pi-ai'
import {
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
  type FauxContentBlock,
} from '@earendil-works/pi-ai/providers/faux'
import { CodeFailure, DesktopAction, Shown } from '@vivid/contracts'
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
    version: Schema.optionalKey(Schema.Number),
    body: Schema.optionalKey(Schema.String),
    shown: Schema.optionalKey(Schema.String),
    result: Schema.optionalKey(
      Schema.Union([Schema.Number, Schema.Struct({ title: Schema.String })]),
    ),
    catalog: Schema.optionalKey(Schema.String),
    nextRunAt: Schema.optionalKey(Schema.NullOr(Schema.String)),
    remembered: Schema.optionalKey(Schema.String),
    added: Schema.optionalKey(Schema.Boolean),
    account: Schema.optionalKey(Schema.String),
    integrations: Schema.optionalKey(Schema.Array(Schema.Struct({ name: Schema.String }))),
    view: Schema.optionalKey(Schema.Struct({ width: Schema.Number, height: Schema.Number })),
    task: Schema.optionalKey(Schema.Struct({ title: Schema.String })),
    failure: Schema.optionalKey(CodeFailure),
  }),
)
const decodeReceipt = Schema.decodeUnknownOption(Receipt)
type Step = (context: Context) => FauxContentBlock[]
interface Scene {
  readonly phrase: string
  readonly steps: readonly Step[]
}

/** A call's identity and message time are derived from history, so replay is byte-for-byte stable. */
function call(context: Context, name: string, input: ToolCall['arguments'], index = 0) {
  return fauxToolCall(name, input, { id: `rehearsal:${context.messages.length}:${index}` })
}

/** Display examples are explicitly rehearsal data, constructed through the shared wire contract. */
function display(phrase: string, shown: Shown): Scene {
  return {
    phrase,
    steps: [
      (context) => [
        fauxText('Here’s a rehearsal example.'),
        call(context, 'show', { show: shown }),
      ],
      completion,
    ],
  }
}

/** Every scene closes using the actual receipt, including unavailable dependencies, rather than promising success. */
function completion(context: Context): FauxContentBlock[] {
  const latest = Option.getOrElse(
    Array.findLastIndex(context.messages, (message) => message.role === 'user'),
    () => -1,
  )
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
  show: (value: typeof Receipt.Type) =>
    value.shown === undefined ? 'The display result is missing.' : `The ${value.shown} is above.`,
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
  create_task: (value: typeof Receipt.Type) =>
    value.task === undefined
      ? 'The saved task is missing from the result.'
      : `I added “${modelText(value.task.title)}”.`,
  create_routine: (value: typeof Receipt.Type) =>
    value.nextRunAt === undefined || value.nextRunAt === null
      ? 'The routine returned no next run time.'
      : `The reminder is scheduled for ${modelText(value.nextRunAt)}; this date-based routine repeats yearly until removed.`,
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

/** Tomorrow is calculated from the Person message's timestamp in the timezone stated by Vivid's context. */
function reminder(context: Context): FauxContentBlock[] {
  const person = Array.findLast(context.messages, (message) => message.role === 'user')
  if (Option.isNone(person))
    return [fauxText('Send “remind me” to schedule the rehearsal reminder.')]
  const match = /Today is .+ in the (.+) time zone\./u.exec(context.systemPrompt ?? '')
  const timezone = match === null || match[1] === undefined ? 'UTC' : match[1]
  const local = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(person.value.timestamp)
  const tomorrow = new Date(`${local}T12:00:00Z`)
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1)
  return [
    call(context, 'create_routine', {
      name: 'Rehearsal reminder',
      prompt: 'Tell me it is time to review the rehearsal results.',
      trigger: {
        kind: 'Schedule',
        cron: `0 9 ${tomorrow.getUTCDate()} ${tomorrow.getUTCMonth() + 1} *`,
        timezone,
      },
    }),
  ]
}

/** Real tool names and valid example inputs are kept with the scene, with no product authority in the script. */
function toolScene(phrase: string, name: string, input: ToolCall['arguments']): Scene {
  return { phrase, steps: [(context) => [call(context, name, input)], completion] }
}

const examples = [
  display(
    'show a table',
    Shown.cases.Table.make({
      title: 'Rehearsal workload',
      columns: ['Project', 'Hours', 'Owner'],
      rows: [
        ['Research', '4', 'Rae'],
        ['Writing', '3', 'Rae'],
        ['Review', '2', 'Sam'],
      ],
      note: 'Example values for this rehearsal.',
    }),
  ),
  ...(['bar', 'line', 'share'] as const).map((kind) =>
    display(
      kind === 'bar' ? 'show a chart' : `show a ${kind} chart`,
      Shown.cases.Chart.make({
        title: 'Rehearsal hours',
        kind,
        labels: ['Research', 'Writing', 'Review'],
        series: [{ name: 'Hours', values: [4, 3, 2] }],
        unit: ' hrs',
      }),
    ),
  ),
  display(
    'show steps',
    Shown.cases.Steps.make({
      title: 'Rehearsal plan',
      steps: [
        { label: 'Prepare', state: 'done' },
        { label: 'Review', state: 'doing' },
        { label: 'Finish', state: 'to do' },
        { label: 'Extra review', state: 'skipped' },
      ],
    }),
  ),
  display(
    'show options',
    Shown.cases.Options.make({
      question: 'Which rehearsal topic?',
      options: [
        { label: 'Research', detail: 'Review the sources.' },
        { label: 'Writing', detail: 'Review the draft.' },
      ],
      many: false,
    }),
  ),
  display(
    'show many options',
    Shown.cases.Options.make({
      question: 'Which rehearsal topics?',
      options: [{ label: 'Research' }, { label: 'Writing' }, { label: 'Review' }],
      many: true,
    }),
  ),
  display(
    'show a comparison',
    Shown.cases.Comparison.make({
      title: 'Rehearsal choices',
      items: [
        {
          name: 'Morning',
          summary: 'Start with a clear head.',
          good: ['Quiet time'],
          bad: ['Early start'],
          facts: [{ label: 'Time', value: '09:00' }],
        },
        {
          name: 'Afternoon',
          summary: 'Finish after lunch.',
          good: ['More preparation'],
          bad: ['Busy calendar'],
          facts: [{ label: 'Time', value: '14:00' }],
        },
      ],
      pick: { name: 'Morning', why: 'More quiet time for this example.' },
    }),
  ),
  display(
    'show links',
    Shown.cases.Links.make({
      title: 'Rehearsal sources',
      links: [
        { title: 'Example Domain', address: 'https://example.com', note: 'A public example page.' },
        {
          title: 'Wikipedia',
          address: 'https://www.wikipedia.org',
          note: 'A reference starting point.',
        },
      ],
    }),
  ),
  display(
    'show facts',
    Shown.cases.Facts.make({
      title: 'Rehearsal facts',
      facts: [
        { label: 'Hours saved', value: '9', change: '+2 this week', tone: 'good' },
        { label: 'Open tasks', value: '3', change: '+1 this week', tone: 'bad' },
        { label: 'Reviews', value: '2' },
      ],
    }),
  ),
  display(
    'show a draft',
    Shown.cases.Draft.make({
      kind: 'email',
      to: ['sam@example.com'],
      subject: 'Rehearsal review',
      body: 'Hi Sam,\n\nPlease review these example results when you have a moment.\n\nRae',
    }),
  ),
  display(
    'show a schedule',
    Shown.cases.Schedule.make({
      title: 'Rehearsal day',
      day: 'Example day',
      items: [
        { at: '09:00', until: '09:30', title: 'Review results', where: 'Desk' },
        { at: '11:00', title: 'Discuss next steps', note: 'Bring the example draft.' },
      ],
    }),
  ),
  display(
    'show a form',
    Shown.cases.Form.make({
      title: 'Rehearsal details',
      fields: [
        { label: 'Name', kind: 'text', choices: [], example: 'Rae' },
        { label: 'Notes', kind: 'long text', choices: [] },
        { label: 'People', kind: 'number', choices: [] },
        { label: 'Date', kind: 'date', choices: [] },
        { label: 'Topic', kind: 'choice', choices: ['Research', 'Writing'] },
      ],
      submit: 'Send details',
    }),
  ),
  display(
    'show pictures',
    Shown.cases.Pictures.make({
      title: 'Rehearsal pictures',
      pictures: [
        {
          address: 'https://upload.wikimedia.org/wikipedia/commons/3/3f/Fronalpstock_big.jpg',
          caption: 'Mountains and a lake.',
        },
        {
          address: 'https://upload.wikimedia.org/wikipedia/commons/a/a9/Example.jpg',
          caption: 'A public example picture.',
        },
      ],
    }),
  ),
  toolScene('write a document', 'write_document', {
    title: 'Rehearsal plan',
    body: '# Rehearsal plan\n\n1. Review the results.\n2. Choose the next step.',
  }),
  toolScene('revise the document', 'write_document', {
    title: 'Rehearsal plan',
    body: '# Rehearsal plan\n\n1. Review the results.\n2. Ask for a review.\n3. Choose the next step.',
    note: 'Added a review before choosing the next step.',
  }),
  toolScene('read the document', 'read_document', { title: 'Rehearsal plan' }),
  toolScene('read example', 'read_page', { address: 'https://example.com' }),
  toolScene('run a program', 'run_code', {
    code: 'const numbers = [2, 3, 4]; return numbers.reduce((sum, number) => sum + number, 0);',
    summary: 'Add three example numbers.',
  }),
  toolScene('find google', 'find_integrations', { query: 'google' }),
  toolScene('add exa', 'add_integration', { address: 'https://mcp.exa.ai/mcp', name: 'Exa' }),
  { phrase: 'remind me', steps: [reminder, completion] },
  toolScene('add a task', 'create_task', {
    title: 'Review rehearsal results',
    detail: 'Check every captured result.',
    assignee: 'me',
    priority: 'normal',
  }),
  toolScene('remember that', 'remember', {
    kind: 'preference',
    content: 'Rae prefers reviewing work in the morning.',
    forCompany: false,
  }),
  toolScene('ask me', 'ask_person', {
    question: 'Which rehearsal topic should we review?',
    options: [
      { label: 'Research', detail: 'Review the sources.' },
      { label: 'Writing', detail: 'Review the draft.' },
    ],
    allowsOwnAnswer: true,
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
        call(context, 'read_page', { address: 'https://example.com' }),
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
  const index = Option.getOrElse(
    Array.findLastIndex(context.messages, (message) => message.role === 'user'),
    () => -1,
  )
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
