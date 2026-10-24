import type { FlueConversationMessage } from '@flue/react'
import { describeToolCall, readAnswered, readAsked, summarizeSteps } from '@vivid/state'
import { Option } from 'effect'
import {
  BookOpen,
  Brain,
  ChevronRight,
  Circle,
  Code2,
  FileText,
  Globe,
  ListChecks,
  MessageCircleQuestion,
  Monitor,
  Plug,
  Search,
  Terminal,
  type LucideIcon,
} from 'lucide-react'
import { useState } from 'react'
import { ThinkingOrb } from 'thinking-orbs'
import { cn } from '../../ui/cn'
import { Peek } from '../computer/Peek'

/**
 * What Vivid is doing and what it did, from the tool calls the Thread's stream already carries.
 *
 * Nothing here is invented: each line is one tool call, said in the words `describeToolCall`
 * keeps for it (the one place a tool's name becomes a sentence, shared with the phone). While a
 * reply is being made the steps are listed as they happen, with the one in progress marked;
 * afterwards they fold to one quiet line under the answer that opens into the same list.
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

/** The steps that happen on Vivid's computer, where there is something to watch. */
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

/**
 * The small picture beside each kind of step, so a list of them can be told apart at a glance.
 * A tool this client has not heard of gets a plain dot, the same way it gets a plain line.
 */
const ICON = new Map<string, LucideIcon>([
  ['search_library', BookOpen],
  ['find_tools', Search],
  ['find_integrations', Search],
  ['use_tool', Plug],
  ['connect', Plug],
  ['add_integration', Plug],
  ['test_integration', Plug],
  ['recall', Brain],
  ['remember', Brain],
  ['forget', Brain],
  ['correct', Brain],
  ['activate_skill', ListChecks],
  ['read_skill', ListChecks],
  ['save_skill', ListChecks],
  ['bash', Terminal],
  ['read', FileText],
  ['write', FileText],
  ['edit', FileText],
  ['grep', Search],
  ['glob', Search],
  ['run_code', Code2],
  ['browse', Globe],
  ['read_page', Globe],
  ['use_desktop', Monitor],
  ['write_document', FileText],
  ['read_document', FileText],
  ['ask_person', MessageCircleQuestion],
])

interface Step {
  readonly id: string
  readonly Icon: LucideIcon
  readonly label: string
  readonly detail: Option.Option<string>
  readonly state: StepState
}

/** One tool call as a step: its picture, its sentence, and where it stands once its answer is read. */
const stepOf = (tool: ToolPart): Step => {
  const described = describeToolCall(
    tool.toolName,
    readAsked(tool.input),
    // A call still running has no output; it reads as an answer with nothing in it yet.
    readAnswered(tool.state === 'output-available' ? tool.output : {}),
    stateOf(tool),
  )
  const icon = ICON.get(tool.toolName)
  return {
    id: tool.toolCallId,
    Icon: icon === undefined ? Circle : icon,
    label: described.label,
    detail: Option.fromUndefinedOr(described.detail),
    // A tool that answered that it could not do it failed, even though the call returned.
    state: described.state,
  }
}

/** The newest step still in progress, which is the one Vivid is on. */
const currentOf = (tools: ReadonlyArray<ToolPart>) =>
  tools.reduce<Option.Option<ToolPart>>(
    (latest, tool) => (stateOf(tool) === 'running' ? Option.some(tool) : latest),
    Option.none(),
  )

/**
 * What Vivid is doing right now in a reply, as one line for the Thread's header and the waiting
 * row: the step in progress ("Using Gmail (Work)"), or nothing when no tool is running and the
 * only true thing to say is that it is thinking.
 */
export const doingIn = (message: FlueConversationMessage): Option.Option<string> =>
  Option.map(
    currentOf(message.parts.filter((part) => part.type === 'dynamic-tool')),
    (tool) => stepOf(tool).label,
  )

/** How many finished steps stay in view while Vivid works; older ones fold into a count. */
const KEPT = 3

/**
 * The steps of a reply that is still being made: the last few finished ones, quiet, and the one
 * in progress with the orb beside it. When that step is on Vivid's computer, the computer's live
 * picture sits under the list, one press from the panel beside the Thread.
 */
export function Doing({
  tools,
  wordless,
}: {
  tools: ReadonlyArray<ToolPart>
  /** Whether the reply has no words yet, so between steps the list is the only sign of life. */
  wordless: boolean
}) {
  if (tools.length === 0) return null
  const steps = tools.map(stepOf)
  // Every step so far has finished and the answer has not begun: Vivid is working out what it
  // found. The stream says exactly that much, so the list says it, with the orb, instead of
  // standing still.
  const between = wordless && Option.isNone(currentOf(tools))
  const earlier = Math.max(steps.length - KEPT, 0)
  const onComputer = tools.some((tool) => ON_COMPUTER.has(tool.toolName))
  return (
    <div className="mb-2">
      <ol className="flex flex-col gap-1.5 text-label" aria-live="polite">
        {earlier > 0 && (
          <li className="pl-7 text-meta font-meta text-ink-3">
            {earlier === 1 ? '1 earlier step' : `${earlier} earlier steps`}
          </li>
        )}
        {steps.slice(earlier).map((step) => (
          <Line key={step.id} step={step} live />
        ))}
        {between && (
          <li className="flex animate-fade-in items-center gap-2 text-ink-3">
            <span className="inline-flex size-5 shrink-0 items-center justify-center">
              <ThinkingOrb state="breathing" size={20} aria-hidden />
            </span>
            Putting it together…
          </li>
        )}
      </ol>
      {onComputer && <Peek />}
    </div>
  )
}

/**
 * The steps of a finished reply, under the answer: one line saying what was done, which opens
 * into each step. It is quiet on purpose; the answer is the thing, and this is how it was got.
 */
export function Trail({ tools }: { tools: ReadonlyArray<ToolPart> }) {
  const [open, setOpen] = useState(false)
  if (tools.length === 0) return null
  const steps = tools.map(stepOf)
  return (
    <div className="mt-1.5">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="-ml-1 inline-flex max-w-full cursor-pointer items-center gap-1 rounded-row px-1 py-0.5 text-meta font-meta text-ink-3 transition-colors duration-(--dur-fast) hover:bg-wash-hover hover:text-ink focus-visible:bg-wash-hover focus-visible:text-ink"
      >
        <ChevronRight
          className={cn(
            'size-3.5 shrink-0 transition-transform duration-(--dur-fast)',
            open && 'rotate-90',
          )}
        />
        <span className="truncate">{summarizeSteps(steps, Option.none())}</span>
      </button>
      {open && (
        <ol className="mt-1.5 flex animate-fade-in flex-col gap-1.5 text-label">
          {steps.map((step) => (
            <Line key={step.id} step={step} live={false} />
          ))}
        </ol>
      )}
    </div>
  )
}

/** One step: its picture (the orb while it is the one in progress), its sentence, its detail. */
function Line({ step, live }: { step: Step; live: boolean }) {
  const running = live && step.state === 'running'
  return (
    <li
      className={cn(
        'flex min-w-0 items-start gap-2',
        live && 'animate-fade-in',
        step.state === 'failed' ? 'text-danger' : running ? 'text-ink' : 'text-ink-2',
      )}
    >
      {/* A fixed box for either picture, so the sentence does not move when a step finishes. */}
      <span className="mt-px inline-flex size-5 shrink-0 items-center justify-center">
        {running ? (
          <ThinkingOrb state="working" size={20} aria-hidden />
        ) : (
          <step.Icon className="size-3.5 text-ink-3" strokeWidth={1.75} />
        )}
      </span>
      <span className="min-w-0 text-pretty">
        {step.label}
        {running && '…'}
        {Option.isSome(step.detail) && <span className="text-ink-3"> · {step.detail.value}</span>}
      </span>
    </li>
  )
}
