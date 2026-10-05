import { Option, Schema } from 'effect'

/**
 * What Vivid did while answering, said the way a colleague would say it.
 *
 * A reply's steps open into a list. Each line is one tool call in product language, with the one
 * detail that tells this call from any other: what was searched for, which account was used, what
 * the command was for. The runtime's tool names and payloads are an implementation detail and are
 * never shown; a tool this client has not heard of gets a plain, true line.
 *
 * Inputs and outputs arrive from the conversation's history as unknown JSON, so the few fields a
 * line can use are decoded here, once, and everything else is ignored.
 */

const text = Schema.OptionFromOptionalKey(Schema.String)
const list = Schema.OptionFromOptionalKey(Schema.Array(Schema.Unknown))

/** The fields of a tool's input a step can be described with. */
const Asked = Schema.Struct({
  query: text,
  address: text,
  command: text,
  path: text,
  pattern: text,
  summary: text,
  account: text,
  tool: text,
  service: text,
  name: text,
  content: text,
  title: text,
  question: text,
  /** `forget` says what to forget; `correct` says what is true now. */
  what: text,
  now: text,
})
type Asked = typeof Asked.Type

/** The fields of a tool's result a step can be described with. */
const Answered = Schema.Struct({
  /**
   * Whether the tool did what was asked. A tool that could not (the Computer refused, a memory
   * could not be saved) still answers, with `ok: false` and words for Vivid, so the call itself
   * does not fail. Absent on tools that have no such outcome.
   */
  ok: Schema.OptionFromOptionalKey(Schema.Boolean),
  created: Schema.OptionFromOptionalKey(Schema.Boolean),
  changed: Schema.OptionFromOptionalKey(Schema.Boolean),
  results: list,
  tools: list,
  memories: list,
  routines: list,
})
type Answered = typeof Answered.Type

/** Reads what a tool was asked, from the conversation's own JSON. Anything else reads as nothing. */
export const readAsked = Schema.decodeUnknownOption(Asked)
/** Reads what a tool answered, the same way. */
export const readAnswered = Schema.decodeUnknownOption(Answered)

/** Where one step stands: still going, finished, or finished badly. */
export type ToolState = 'running' | 'failed' | 'done'
interface ToolCallDescription {
  /** Where the step really stands, after reading what the tool answered. */
  readonly state: ToolState
  readonly label: string
  readonly detail?: string
}

/** How one kind of step reads in each state, and the detail that sets one call apart. */
interface Step {
  readonly said: Record<ToolState, string>
  /**
   * The same three lines with the call's own subject in them, when the call names one: "Using
   * Gmail (Work)" says more than "Using an integration". Absent on steps with no such subject.
   */
  readonly named?: (asked: Asked) => Option.Option<Record<ToolState, string>>
  readonly detail: (asked: Asked, answered: Answered) => ReadonlyArray<Option.Option<string>>
}

/** Words worth saying: present and not only space. */
const said = (value: Option.Option<string>) =>
  Option.filter(value, (words) => words.trim().length > 0)

const quoted = (value: Option.Option<string>) => Option.map(said(value), (words) => `“${words}”`)

/** "2 sources", "1 source": a count with its noun, when there is a list to count. */
const counted = (items: Option.Option<ReadonlyArray<unknown>>, one: string, many: string) =>
  Option.map(items, (all) => (all.length === 1 ? `1 ${one}` : `${all.length} ${many}`))

const nothing = (): ReadonlyArray<Option.Option<string>> => []

const STEPS = {
  search_library: {
    said: {
      running: 'Searching the Library',
      done: 'Searched the Library',
      failed: 'Library search failed',
    },
    detail: (asked, answered) => [
      quoted(asked.query),
      counted(answered.results, 'source', 'sources'),
    ],
  },
  find_tools: {
    said: {
      running: 'Looking for a way to do it',
      done: 'Looked for a way to do it',
      failed: 'Could not look through the integrations',
    },
    detail: (asked, answered) => [
      quoted(asked.query),
      counted(answered.tools, 'way found', 'ways found'),
    ],
  },
  use_tool: {
    said: {
      running: 'Using an integration',
      done: 'Used an integration',
      failed: 'The integration did not do it',
    },
    // The account is the subject of the line, so the detail is only what was done with it.
    named: (asked) =>
      Option.map(said(asked.account), (account) => ({
        running: `Using ${account}`,
        done: `Used ${account}`,
        failed: `${account} did not do it`,
      })),
    detail: (asked) => [said(asked.summary)],
  },
  connect: {
    said: {
      running: 'Asking for an integration',
      done: 'Asked for an integration',
      failed: 'Could not offer the integration',
    },
    detail: (asked) => [said(asked.service)],
  },
  recall: {
    said: {
      running: 'Checking what it remembers',
      done: 'Checked what it remembers',
      failed: 'Could not reach its memory',
    },
    detail: (asked, answered) => [
      quoted(asked.query),
      counted(answered.memories, 'thing remembered', 'things remembered'),
    ],
  },
  remember: {
    said: {
      running: 'Remembering',
      done: 'Remembered',
      failed: 'Could not remember that',
    },
    detail: (asked) => [said(asked.content)],
  },
  forget: {
    said: {
      running: 'Forgetting',
      done: 'Forgot something',
      failed: 'Could not forget that',
    },
    detail: (asked) => [said(asked.what)],
  },
  correct: {
    said: {
      running: 'Correcting what it knows',
      done: 'Corrected what it knows',
      failed: 'Could not correct that',
    },
    detail: (asked) => [said(asked.now)],
  },
  read_skill: {
    said: {
      running: 'Reading how it does this',
      done: 'Read how it does this',
      failed: 'Could not read the saved steps',
    },
    detail: (asked) => [said(asked.name)],
  },
  // A built-in way of working is, to a Person, the same thing as one Vivid saved: how it does
  // something. Its runtime name ("first-conversation") is an implementation word, so the step
  // has no detail. Without this entry the first step of a first Thread read "Did something".
  activate_skill: {
    said: {
      running: 'Reading how it does this',
      done: 'Read how it does this',
      failed: 'Could not read how it does this',
    },
    detail: nothing,
  },
  save_skill: {
    said: {
      running: 'Saving how to do this',
      done: 'Saved how to do this',
      failed: 'Could not save the steps',
    },
    detail: (asked) => [said(asked.name)],
  },
  create_routine: {
    said: {
      running: 'Setting up a routine',
      done: 'Set up a routine',
      failed: 'Could not set up the routine',
    },
    detail: (asked) => [said(asked.name)],
  },
  list_routines: {
    said: {
      running: 'Checking the routines',
      done: 'Checked the routines',
      failed: 'Could not read the routines',
    },
    detail: (_asked, answered) => [counted(answered.routines, 'routine', 'routines')],
  },
  bash: {
    said: {
      running: 'Working on its computer',
      done: 'Worked on its computer',
      failed: 'The computer did not do it',
    },
    detail: (asked) => [said(asked.command)],
  },
  read: {
    said: {
      running: 'Reading a file on its computer',
      done: 'Read a file on its computer',
      failed: 'Could not read the file',
    },
    detail: (asked) => [said(asked.path)],
  },
  write: {
    said: {
      running: 'Writing a file on its computer',
      done: 'Wrote a file on its computer',
      failed: 'Could not write the file',
    },
    detail: (asked) => [said(asked.path)],
  },
  edit: {
    said: {
      running: 'Changing a file on its computer',
      done: 'Changed a file on its computer',
      failed: 'Could not change the file',
    },
    detail: (asked) => [said(asked.path)],
  },
  grep: {
    said: {
      running: 'Searching its files',
      done: 'Searched its files',
      failed: 'Could not search the files',
    },
    detail: (asked) => [said(asked.pattern)],
  },
  glob: {
    said: {
      running: 'Looking for files',
      done: 'Looked for files',
      failed: 'Could not look for files',
    },
    detail: (asked) => [said(asked.pattern)],
  },
  run_command: {
    said: {
      running: 'Working on its computer',
      done: 'Worked on its computer',
      failed: 'The computer did not do it',
    },
    detail: (asked) => [said(asked.summary)],
  },
  browse: {
    said: {
      running: 'Using its browser',
      done: 'Used its browser',
      failed: 'The browser did not do it',
    },
    detail: (asked) => [said(asked.summary)],
  },
  use_desktop: {
    said: {
      running: 'Looking on its computer',
      done: 'Used its computer',
      failed: 'The computer did not do it',
    },
    detail: (asked) => [said(asked.summary)],
  },
  // The Person's own computer, not Vivid's: "your", so the line never reads as the machine
  // Vivid keeps for itself (`use_desktop` above).
  use_person_computer: {
    said: {
      running: 'Working on your computer',
      done: 'Worked on your computer',
      failed: 'Your computer did not do it',
    },
    detail: (asked) => [said(asked.summary)],
  },
  run_code: {
    said: {
      running: 'Writing a program',
      done: 'Wrote and ran a program',
      failed: 'The program did not finish',
    },
    detail: (asked) => [said(asked.summary)],
  },
  write_document: {
    said: {
      running: 'Writing a document',
      done: 'Wrote a document',
      failed: 'Could not write the document',
    },
    detail: (asked) => [said(asked.title)],
  },
  read_document: {
    said: {
      running: 'Reading a document',
      done: 'Read a document',
      failed: 'Could not read the document',
    },
    detail: (asked) => [said(asked.title)],
  },
  read_page: {
    said: {
      running: 'Opening the page',
      done: 'Read a page',
      failed: 'Could not read the page',
    },
    detail: (asked) => [said(asked.address)],
  },
  find_integrations: {
    said: {
      running: 'Looking through integrations',
      done: 'Looked through integrations',
      failed: 'Could not look through integrations',
    },
    detail: (asked) => [quoted(asked.query)],
  },
  add_integration: {
    said: {
      running: 'Adding an integration',
      done: 'Added an integration',
      failed: 'Could not add the integration',
    },
    detail: (asked) => [said(asked.name)],
  },
  test_integration: {
    said: {
      running: 'Trying an integration',
      done: 'Tried an integration',
      failed: 'The integration did not answer',
    },
    detail: (asked) => [said(asked.account)],
  },
  ask_person: {
    said: {
      running: 'Asking a question',
      done: 'Asked a question',
      failed: 'Could not ask',
    },
    detail: (asked) => [said(asked.question)],
  },
  create_project: {
    said: {
      running: 'Starting a project',
      done: 'Started a project',
      failed: 'Could not start the project',
    },
    detail: (asked) => [said(asked.name)],
  },
  find_events: {
    said: {
      running: 'Looking at what can start a routine',
      done: 'Looked at what can start a routine',
      failed: 'Could not look at what can start a routine',
    },
    detail: (asked) => [said(asked.account)],
  },
  notify_person: {
    said: {
      running: 'Sending you a notification',
      done: 'Sent you a notification',
      failed: 'Could not send the notification',
    },
    detail: (asked) => [said(asked.title)],
  },
  open_thread: {
    said: {
      running: 'Opening a thread for this',
      done: 'Opened a thread for this',
      failed: 'Could not open the thread',
    },
    detail: (asked) => [said(asked.title)],
  },
  show: {
    said: {
      running: 'Putting it on screen',
      done: 'Put it on screen',
      failed: 'Could not show it',
    },
    detail: nothing,
  },
} satisfies Record<string, Step>

/** A tool this client has not heard of: still a true line, with nothing made up about it. */
const UNKNOWN: Step = {
  said: { running: 'Working', done: 'Did something', failed: 'Something did not work' },
  detail: nothing,
}

/**
 * The line for a tool this client has no words for. When Vivid said what the step is for, that is
 * the line while it runs and once it is done; "Did something" above a sentence saying what was
 * done would be noise.
 */
const unheardOf = (purpose: Option.Option<string>): Step =>
  Option.match(purpose, {
    onNone: () => UNKNOWN,
    onSome: (words) => ({ ...UNKNOWN, said: { ...UNKNOWN.said, running: words, done: words } }),
  })

const STEP_OF = new Map<string, Step>(Object.entries(STEPS))

const NOTHING_ASKED: Asked = {
  query: Option.none(),
  address: Option.none(),
  command: Option.none(),
  path: Option.none(),
  pattern: Option.none(),
  summary: Option.none(),
  account: Option.none(),
  tool: Option.none(),
  service: Option.none(),
  name: Option.none(),
  content: Option.none(),
  title: Option.none(),
  question: Option.none(),
  what: Option.none(),
  now: Option.none(),
}

const NOTHING_ANSWERED: Answered = {
  results: Option.none(),
  tools: Option.none(),
  memories: Option.none(),
  routines: Option.none(),
  ok: Option.none(),
  created: Option.none(),
  changed: Option.none(),
}

/**
 * Where a step stands once its answer is read. A call that returned is not thereby a step that
 * worked: a tool that answered `ok: false` finished badly, and saying "Remembered" or "Used its
 * browser" above Vivid's own "that did not work" told the Person two different things.
 */
const settled = (state: ToolState, answered: Option.Option<Answered>): ToolState =>
  state === 'done' &&
  Option.exists(
    Option.flatMap(answered, (result) => result.ok),
    (ok) => !ok,
  )
    ? 'failed'
    : state

/** Actual receipts distinguish unchanged documents and revisions. */
const labelOf = (
  toolName: string,
  step: Step,
  answered: Option.Option<Answered>,
  state: ToolState,
) => {
  if (state !== 'done') return step.said[state]
  return doneLabelOf(toolName, step, answered)
}

/** What a finished step is called; a document's receipt says whether anything changed. */
const doneLabelOf = (toolName: string, step: Step, answered: Option.Option<Answered>) => {
  if (
    toolName === 'write_document' &&
    Option.contains(
      Option.flatMap(answered, (result) => result.changed),
      false,
    )
  )
    return 'Document unchanged'
  if (
    toolName === 'write_document' &&
    Option.exists(
      Option.flatMap(answered, (result) => result.created),
      (created) => !created,
    )
  )
    return 'Revised a document'
  return step.said.done
}

/**
 * One step, in words. `asked` and `answered` are the tool call's own input and output as read by
 * `readAsked` and `readAnswered`; whatever was not there, or is not there yet, is simply not said.
 */
export function describeToolCall(
  toolName: string,
  asked: Option.Option<Asked>,
  answered: Option.Option<Answered>,
  called: ToolState,
): ToolCallDescription {
  const read = Option.getOrElse(asked, () => NOTHING_ASKED)
  // Vivid says what each step is for when it calls the tool (`summary`, required on every tool's
  // input in the runtime). Those are the words that tell this call from any other, so they lead
  // the detail of every step; before, only the Computer's steps showed them.
  const purpose = said(read.summary)
  const known = Option.getOrElse(Option.fromUndefinedOr(STEP_OF.get(toolName)), () =>
    unheardOf(purpose),
  )
  // A call that names its subject is said with it; the detail function is the step's own.
  const step: Step =
    known.named === undefined
      ? known
      : { ...known, said: Option.getOrElse(known.named(read), () => known.said) }
  const state = settled(called, answered)
  const label = labelOf(toolName, step, answered, state)
  // A reading that is not there (a call with no input, one still running, JSON this client does
  // not recognise) contributes nothing to the line; the other reading still does.
  const own = step
    .detail(
      read,
      Option.getOrElse(answered, () => NOTHING_ANSWERED),
    )
    .flatMap((part) => Option.toArray(part))
  // A step that already says its purpose (the Computer's, an Integration's), or one whose line is
  // the purpose itself, does not say it twice.
  const details = Option.match(purpose, {
    onNone: () => own,
    onSome: (words) => (own.includes(words) || label === words ? own : [words, ...own]),
  })
  return details.length === 0 ? { state, label } : { state, label, detail: details.join(' · ') }
}

/**
 * The one line a reply's steps collapse to, on every surface. While Vivid is working it is what
 * it is doing right now ("Searching the Library…"), not the word "Working". Afterwards it is what
 * was done: the step itself when there was one, the first and a count when there were more.
 *
 * `current` is the id of the step Vivid is on, when it is on one; a surface finds it, because only
 * the surface knows whether the reply is still being written.
 */
export function summarizeSteps(
  steps: ReadonlyArray<{ readonly id: string; readonly label: string }>,
  current: Option.Option<string>,
): string {
  const doing = Option.flatMap(current, (id) =>
    Option.fromUndefinedOr(steps.find((step) => step.id === id)),
  )
  if (Option.isSome(doing)) return `${doing.value.label}…`
  const [first, ...rest] = steps
  if (first === undefined) return ''
  if (rest.length === 0) return first.label
  return rest.length === 1
    ? `${first.label} and 1 more step`
    : `${first.label} and ${rest.length} more steps`
}
