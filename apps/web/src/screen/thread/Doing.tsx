import type { FlueConversationMessage } from '@flue/react'
import type { Connection } from '@vivid/contracts'
import { describeToolCall, readAnswered, readAsked } from '@vivid/state'
import { Option } from 'effect'
import { ThinkingOrb } from 'thinking-orbs'
import { live, useLiveValue } from '../../data/live'
import { Peek } from '../computer/Peek'
import { Mark } from '../integration/Mark'

/**
 * What Vivid is on right now, said in one place: the line at the foot of the Thread while it
 * works. The steps themselves are never drawn in the Thread (the owner, 26 October 2026: no list,
 * no "Worked 41s", no counter); this line says the one Vivid is on in the newest reply, in the
 * words `describeToolCall` keeps for it (shared with the phone's working bubble,
 * `apps/mobile/src/ui/Thinking.tsx`), and "Thinking" while it is on none.
 */

export type ToolPart = Extract<FlueConversationMessage['parts'][number], { type: 'dynamic-tool' }>

type StepState = 'running' | 'done' | 'failed'

const TOOL_STATE = new Map<string, StepState>([
  ['input-streaming', 'running'],
  ['input-available', 'running'],
  ['output-available', 'done'],
  ['output-error', 'failed'],
])

/** A tool call's standing. A state this client does not know yet is still in progress. */
const stateOf = (tool: ToolPart): StepState => {
  const known = TOOL_STATE.get(tool.state)
  return known === undefined ? 'running' : known
}

/** The steps that happen on Vivid's Computer, where there is something to watch. */
const ON_COMPUTER = new Set([
  'bash',
  'read',
  'write',
  'edit',
  'grep',
  'glob',
  'browse',
  'use_desktop',
])

/** What the line says while Vivid is on no step. The phone says the same (`ui/Thinking.tsx`). */
const THINKING = 'Thinking'

/** The tool calls of a reply, in the order Vivid made them. */
export const toolsOf = (message: FlueConversationMessage): ReadonlyArray<ToolPart> =>
  message.parts.flatMap((part) => (part.type === 'dynamic-tool' ? [part] : []))

/** The step Vivid is on: its sentence, and the Integration account it works through, if any. */
interface Step {
  readonly label: string
  readonly account: Option.Option<string>
}

/**
 * The step Vivid is on in a reply: the newest tool call still in progress, in its own words
 * ("Using Grain"), or none when no tool is running and the one true thing to say is that it is
 * thinking.
 */
export const stepIn = (message: FlueConversationMessage): Option.Option<Step> =>
  Option.map(
    toolsOf(message).reduce<Option.Option<ToolPart>>(
      (newest, tool) => (stateOf(tool) === 'running' ? Option.some(tool) : newest),
      Option.none(),
    ),
    (tool) => {
      const described = describeToolCall(
        tool.toolName,
        readAsked(tool.input),
        // A call still running has no output; it reads as an answer with nothing in it yet.
        readAnswered({}),
        'running',
      )
      return { label: described.label, account: described.account }
    },
  )

/**
 * Whether the newest step of a reply is on the Computer, running or just finished. It is the
 * newest step and not only the running one, so the picture of the Computer stays put between two
 * steps there instead of leaving and coming back while Vivid thinks in between.
 */
const onComputer = (message: FlueConversationMessage) =>
  Option.exists(Option.fromUndefinedOr(toolsOf(message).at(-1)), (tool) =>
    ON_COMPUTER.has(tool.toolName),
  )

/** The Person's live account Vivid's step names, by the name it is known by (`account`). */
const accountNamed = (connections: ReadonlyArray<Connection>, account: string) =>
  Option.fromUndefinedOr(connections.find((each) => each.account === account))

/**
 * The line at the foot of the Thread while Vivid works: the logo of the Integration the step
 * works through (found among the Person's live accounts by the name the step gives it), or
 * Vivid's orb; then the step's words with a band of light passing over them (`sheen`,
 * `styles/motion.css`). While the step is on the Computer, its live picture sits under the line,
 * one press from the panel beside the Thread (`Peek`).
 *
 * It arrives late on purpose: an answer that starts within a second never shows it. Its first
 * slot is as wide as a reply's face, so the words stand in the column the replies are read in.
 */
export function Doing({ reply }: { reply: Option.Option<FlueConversationMessage> }) {
  const connections = Option.match(useLiveValue(live.connections), {
    onNone: () => [],
    onSome: (listed) => listed.connections,
  })
  const step = Option.flatMap(reply, stepIn)
  const connection = Option.flatMap(
    Option.flatMap(step, (now) => now.account),
    (account) => accountNamed(connections, account),
  )
  return (
    <li className="transition-opacity delay-700 duration-(--dur-slow) starting:opacity-0">
      <div className="flex items-center gap-3">
        <span className="inline-flex size-7 shrink-0 items-center justify-center">
          {Option.isSome(connection) ? (
            <Mark
              service={{ name: connection.value.serviceName, mark: connection.value.mark }}
              size={20}
              className="rounded-sm"
            />
          ) : (
            <ThinkingOrb state="breathing" size={20} aria-hidden />
          )}
        </span>
        {/* Said when it appears and when the step changes: it is how a Thread says what Vivid
            is on. The band of light is drawn over the words, so it is not read. */}
        <span role="status" className="sheen min-w-0 truncate text-label text-ink">
          {Option.match(step, { onNone: () => THINKING, onSome: (now) => now.label })}
        </span>
      </div>
      {Option.exists(reply, onComputer) && (
        <div className="ps-10">
          <Peek />
        </div>
      )}
    </li>
  )
}
