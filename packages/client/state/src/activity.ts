import { ToolName } from '@vivid/contracts'
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
  site: text,
  /** What is owed, or what to do, on the steps that keep the Person's waiting-on and to-do lists. */
  what: text,
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
  watches: list,
  message: text,
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
  /**
   * The Integration account the step works through, when it names one: what a surface shows
   * beside the step's words while Vivid is on it (the account's logo in the working bubble).
   */
  readonly account: Option.Option<string>
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

/** Tools without authored step wording share the historical unknown-step behavior. A purpose
 * becomes the running/done label, while failure keeps the existing plain failure line. */
const UNKNOWN: Step = {
  said: { running: 'Working', done: 'Did something', failed: 'Something did not work' },
  named: (asked) =>
    Option.map(said(asked.summary), (words) => ({
      ...UNKNOWN.said,
      running: words,
      done: words,
    })),
  detail: nothing,
}

const STEPS = {
  // These tools already render as unknown steps. Total coverage must preserve those words.
  read_memory: UNKNOWN,
  list_memory: UNKNOWN,
  search_memory: UNKNOWN,
  write_memory: UNKNOWN,
  delete_memory: UNKNOWN,
  make_integration: UNKNOWN,
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
  copy_signin: {
    said: {
      running: 'Copying your sign-in',
      done: 'Copied your sign-in',
      failed: 'Sign-in not copied',
    },
    detail: (asked, answered) => [said(asked.site), said(answered.message)],
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
  // The replies themselves are drawn as taps under the reply (`offeredReplies`); the step is only
  // the line at the foot of the Thread for the moment the call runs.
  suggest_replies: {
    said: {
      running: 'Suggesting replies',
      done: 'Suggested replies',
      failed: 'Could not suggest replies',
    },
    detail: nothing,
  },
  create_project: {
    said: {
      running: 'Starting a project',
      done: 'Started a project',
      failed: 'Could not start the project',
    },
    detail: (asked) => [said(asked.name)],
  },
  notify_person: {
    said: {
      running: 'Sending you a notification',
      done: 'Sent you a notification',
      failed: 'Could not send the notification',
    },
    detail: (asked) => [said(asked.title)],
  },
  find_events: {
    said: {
      running: 'Looking at what can be watched',
      done: 'Looked at what can be watched',
      failed: 'Could not look at what can be watched',
    },
    detail: (asked) => [said(asked.account)],
  },
  watch: {
    said: {
      running: 'Starting a watch',
      done: 'Started a watch',
      failed: 'Could not start the watch',
    },
    detail: (asked) => [said(asked.name)],
  },
  list_watches: {
    said: {
      running: 'Checking what is watched',
      done: 'Checked what is watched',
      failed: 'Could not read what is watched',
    },
    detail: (_asked, answered) => [counted(answered.watches, 'watch', 'watches')],
  },
  stop_watching: {
    said: {
      running: 'Stopping a watch',
      done: 'Stopped a watch',
      failed: 'Could not stop the watch',
    },
    detail: (asked) => [said(asked.name)],
  },
  post: {
    said: {
      running: 'Putting it on your Feed',
      done: 'Put it on your Feed',
      failed: 'Could not put it on your Feed',
    },
    detail: (asked) => [said(asked.title)],
  },
  track_owed: {
    said: {
      running: 'Keeping track of it',
      done: 'Keeping track of it',
      failed: 'Could not keep track of it',
    },
    detail: (asked) => [said(asked.what)],
  },
  update_owed: {
    said: {
      running: 'Updating what you are waiting on',
      done: 'Updated what you are waiting on',
      failed: 'Could not update what you are waiting on',
    },
    detail: (asked) => [said(asked.what)],
  },
  resolve_owed: {
    said: {
      running: 'Marking it received',
      done: 'Marked it received',
      failed: 'Could not mark it received',
    },
    detail: (asked) => [said(asked.what)],
  },
  drop_owed: {
    said: {
      running: 'Letting it go',
      done: 'Stopped waiting on it',
      failed: 'Could not stop waiting on it',
    },
    detail: (asked) => [said(asked.what)],
  },
  list_todos: {
    said: {
      running: 'Checking your list',
      done: 'Checked your list',
      failed: 'Could not read your list',
    },
    detail: nothing,
  },
  add_todo: {
    said: {
      running: 'Adding it to your list',
      done: 'Added it to your list',
      failed: 'Could not add it to your list',
    },
    detail: (asked) => [said(asked.what)],
  },
  complete_todo: {
    said: {
      running: 'Ticking it off',
      done: 'Ticked it off',
      failed: 'Could not tick it off',
    },
    detail: (asked) => [said(asked.what)],
  },
  drop_todo: {
    said: {
      running: 'Taking it off your list',
      done: 'Took it off your list',
      failed: 'Could not take it off your list',
    },
    detail: (asked) => [said(asked.what)],
  },
} satisfies Record<ToolName, Step>

/** Old histories and newer runtimes can name tools this client no longer describes. */
const readToolName = Schema.decodeUnknownOption(ToolName)

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
  site: Option.none(),
  what: Option.none(),
}

const NOTHING_ANSWERED: Answered = {
  results: Option.none(),
  tools: Option.none(),
  watches: Option.none(),
  ok: Option.none(),
  created: Option.none(),
  changed: Option.none(),
  message: Option.none(),
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
  const known: Step = Option.getOrElse(
    Option.map(readToolName(toolName), (name) => STEPS[name]),
    () => UNKNOWN,
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
  // Only a step that is about an account names it; a search that merely mentions one does not.
  const account = known.named === undefined ? Option.none<string>() : said(read.account)
  return details.length === 0
    ? { state, label, account }
    : { state, label, detail: details.join(' · '), account }
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
