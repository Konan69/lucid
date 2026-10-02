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
  summary: text,
  account: text,
  tool: text,
  service: text,
  name: text,
  content: text,
  title: text,
  /** `update_task` and `schedule_follow_up` name the Task by its title. */
  task: text,
  question: text,
  /** `forget` says what to forget; `correct` says what is true now. */
  what: text,
  now: text,
})
type Asked = typeof Asked.Type

/** The fields of a tool's result a step can be described with. */
const Answered = Schema.Struct({
  task: Schema.OptionFromOptionalKey(Schema.Struct({ title: text, status: text })),
  followUp: Schema.OptionFromOptionalKey(Schema.Struct({ at: text })),
  results: list,
  tasks: list,
  tools: list,
  memories: list,
  routines: list,
})
type Answered = typeof Answered.Type

/** Reads what a tool was asked, from the conversation's own JSON. Anything else reads as nothing. */
export const readAsked = Schema.decodeUnknownOption(Asked)
/** Reads what a tool answered, the same way. */
export const readAnswered = Schema.decodeUnknownOption(Answered)

type ToolState = 'running' | 'failed' | 'done'
interface ToolCallDescription {
  readonly label: string
  readonly detail?: string
}

/** How one kind of step reads in each state, and the detail that sets one call apart. */
interface Step {
  readonly said: Record<ToolState, string>
  readonly detail: (asked: Asked, answered: Answered) => ReadonlyArray<Option.Option<string>>
}

/** Words worth saying: present and not only space. */
const said = (value: Option.Option<string>) =>
  Option.filter(value, (words) => words.trim().length > 0)

const quoted = (value: Option.Option<string>) => Option.map(said(value), (words) => `“${words}”`)

/** "2 sources", "1 source": a count with its noun, when there is a list to count. */
const counted = (items: Option.Option<ReadonlyArray<unknown>>, one: string, many: string) =>
  Option.map(items, (all) => (all.length === 1 ? `1 ${one}` : `${all.length} ${many}`))

const followUpTime = new Intl.DateTimeFormat(undefined, {
  weekday: 'short',
  hour: 'numeric',
  minute: '2-digit',
})

/** When a follow-up was set for, as a person would say it. */
const followUpAt = (answered: Answered) =>
  Option.map(
    Option.flatMap(answered.followUp, (followUp) => said(followUp.at)),
    (at) => followUpTime.format(Date.parse(at)),
  )

/** The Task a step was about: the one the server returned, or the one Vivid named. */
const taskOf = (asked: Asked, answered: Answered) =>
  Option.orElse(
    Option.flatMap(answered.task, (task) => said(task.title)),
    () => Option.orElse(said(asked.title), () => said(asked.task)),
  )

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
  create_task: {
    said: {
      running: 'Starting to track a task',
      done: 'Started tracking a task',
      failed: 'Could not start tracking',
    },
    detail: (asked, answered) => [
      taskOf(asked, answered),
      Option.map(followUpAt(answered), (at) => `follow-up ${at}`),
    ],
  },
  update_task: {
    said: {
      running: 'Updating a task',
      done: 'Updated a task',
      failed: 'Could not update the task',
    },
    detail: (asked, answered) => [taskOf(asked, answered)],
  },
  list_tasks: {
    said: {
      running: 'Checking the task list',
      done: 'Checked the task list',
      failed: 'Could not read the task list',
    },
    detail: (_asked, answered) => [Option.map(answered.tasks, (tasks) => `${tasks.length} open`)],
  },
  schedule_follow_up: {
    said: {
      running: 'Scheduling a follow-up',
      done: 'Scheduled a follow-up',
      failed: 'Could not schedule the follow-up',
    },
    detail: (asked, answered) => [taskOf(asked, answered), followUpAt(answered)],
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
    detail: (asked) => [said(asked.account), said(asked.summary)],
  },
  connect: {
    said: {
      running: 'Asking to connect a service',
      done: 'Asked to connect a service',
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
      running: 'Using its computer',
      done: 'Used its computer',
      failed: 'The computer did not do it',
    },
    detail: (asked) => [said(asked.summary)],
  },
  run_code: {
    said: {
      running: 'Running a program',
      done: 'Ran a program',
      failed: 'The program did not finish',
    },
    detail: (asked) => [said(asked.summary)],
  },
  read_page: {
    said: {
      running: 'Reading a page',
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
} satisfies Record<string, Step>

/** A tool this client has not heard of: still a true line, with nothing made up about it. */
const UNKNOWN: Step = {
  said: { running: 'Working', done: 'Did something', failed: 'Something did not work' },
  detail: nothing,
}

const STEP_OF = new Map<string, Step>(Object.entries(STEPS))

const NOTHING_ASKED: Asked = {
  query: Option.none(),
  address: Option.none(),
  summary: Option.none(),
  account: Option.none(),
  tool: Option.none(),
  service: Option.none(),
  name: Option.none(),
  content: Option.none(),
  title: Option.none(),
  task: Option.none(),
  question: Option.none(),
  what: Option.none(),
  now: Option.none(),
}

const NOTHING_ANSWERED: Answered = {
  task: Option.none(),
  followUp: Option.none(),
  results: Option.none(),
  tasks: Option.none(),
  tools: Option.none(),
  memories: Option.none(),
  routines: Option.none(),
}

/** A Task marked done reads as that, not as any other update. */
const labelOf = (
  toolName: string,
  step: Step,
  answered: Option.Option<Answered>,
  state: ToolState,
) =>
  toolName === 'update_task' &&
  state === 'done' &&
  Option.exists(
    Option.flatMap(answered, (result) => result.task),
    (task) => Option.contains(task.status, 'done'),
  )
    ? 'Marked a task done'
    : step.said[state]

/**
 * One step, in words. `asked` and `answered` are the tool call's own input and output as read by
 * `readAsked` and `readAnswered`; whatever was not there, or is not there yet, is simply not said.
 */
export function describeToolCall(
  toolName: string,
  asked: Option.Option<Asked>,
  answered: Option.Option<Answered>,
  state: ToolState,
): ToolCallDescription {
  const step = Option.getOrElse(Option.fromUndefinedOr(STEP_OF.get(toolName)), () => UNKNOWN)
  const label = labelOf(toolName, step, answered, state)
  // A reading that is not there (a call with no input, one still running, JSON this client does
  // not recognise) contributes nothing to the line; the other reading still does.
  const details = step
    .detail(
      Option.getOrElse(asked, () => NOTHING_ASKED),
      Option.getOrElse(answered, () => NOTHING_ANSWERED),
    )
    .flatMap((part) => Option.toArray(part))
  return details.length === 0 ? { label } : { label, detail: details.join(' · ') }
}
