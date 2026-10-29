import { BACKGROUND_CONTEXT, withAbortSignal } from '@earendil-works/chord/context'
import type { Harness, ToolExecutionApi } from '@earendil-works/pi-durable'
import {
  ChildRunState,
  DEFAULT_CHILD_BUDGET,
  RuntimeChildAnswer,
  Tool,
  WorkerKind,
  type ChildRun,
} from '@vivid/contracts'
import { Clock, Effect, Option } from 'effect'
import * as v from 'valibot'
import { resolveCall } from '../authority.ts'
import type { Helpers, Named } from '../children.ts'
import { asActing, NobodyToActFor, type ProductService } from '../client.ts'
import { answeringKey } from '../deliveries.ts'
import { pi } from '../threads.ts'
import { defineTool } from './tool.ts'

/** The longest helper answer a wait returns; the server's result delivery keeps the same bound. */
const ANSWER_LIMIT = 12_000

interface Wiring {
  readonly harness: Effect.Effect<Harness>
  readonly product: ProductService
  readonly helpers: Helpers
}

const nobody = (message: string) => new NobodyToActFor({ message })

/**
 * Who the calling Run acts for, as `authority.ts` resolves every tool call. A helper's own
 * conversation never reaches these tools (its kinds do not include them); refusing one here too
 * keeps a helper from starting, waiting on or stopping helpers if that ever changes.
 */
const parent = Effect.fn('Helpers.parent')(function* (wiring: Wiring, api: ToolExecutionApi) {
  const authority = yield* resolveCall(wiring.harness, wiring.product, api)
  if (Option.isSome(authority.helper)) return yield* nobody('A helper cannot manage helpers.')
  return authority
})

/** The helpers the model named, by number. A number the Thread has no helper for is refused. */
const named = Effect.fn('Helpers.namedAll')(function* (
  wiring: Wiring,
  api: ToolExecutionApi,
  numbers: ReadonlyArray<number>,
) {
  return yield* Effect.forEach(numbers, (number) =>
    wiring.helpers.named(api.conversationId, number).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(nobody(`There is no helper ${number} in this conversation.`)),
          onSome: (found) => Effect.succeed({ number, found }),
        }),
      ),
    ),
  )
})

/** One finished helper as the model reads it: its number, how it ended, and its answer. */
const view = (number: number, answer: RuntimeChildAnswer) =>
  RuntimeChildAnswer.match(answer, {
    Absent: () => ({ helper: number, outcome: 'stopped' }),
    Running: () => ({ helper: number, outcome: 'working' }),
    Completed: ({ text }) => ({
      helper: number,
      outcome: 'completed',
      answer: text.length > ANSWER_LIMIT ? `${text.slice(0, ANSWER_LIMIT)}\n[cut]` : text,
    }),
    Failed: ({ failure }) => ({ helper: number, outcome: 'failed', reason: failure._tag }),
    Aborted: () => ({ helper: number, outcome: 'stopped' }),
  })

/** A helper's state as one word for the model. */
const stateWord = (run: ChildRun) =>
  ChildRunState.match(run.state, {
    Reserved: () => 'starting',
    Working: () => 'working',
    Stopping: () => 'stopping',
    Completed: () => 'completed',
    Failed: () => 'failed',
    Stopped: () => 'stopped',
  })

const helperNumber = v.pipe(
  v.number(),
  v.integer(),
  v.minValue(1),
  v.description('The helper number spawn_run gave.'),
)

/**
 * Splitting work into helpers that work at the same time (`children.ts`). Only the Run answering
 * a Person has these; helpers do not. The parent Run, Person and Thread come from the call's
 * committed delivery, never from arguments.
 */
export function childTools(wiring: Wiring) {
  const spawn = defineTool({
    name: Tool.spawn_run,
    description:
      'Start a helper that works on one self-contained part of a larger task at the same time as you and others. Give it everything it needs in the brief: it cannot see this conversation or ask anyone anything. Its result comes back to you on its own as a new message; carry on meanwhile and do not check on it.',
    // Reserving on the server and starting the task in Pi are both keyed by this call, so a
    // rerun after a restart finds the same helper instead of starting a second.
    replay: 'safe',
    input: v.object({
      kind: v.pipe(
        v.picklist(WorkerKind.literals),
        v.description(
          'ReadOnly: read files on your computer, pages, the Library, documents and memory. Researcher: read the page addresses you give and the Library, no computer. Executor: also run commands, write files and use connected Integrations. ComputerUse: drive your computer’s browser and desktop (one at a time).',
        ),
      ),
      brief: v.pipe(
        v.string(),
        v.minLength(1),
        v.maxLength(8000),
        v.description(
          'The whole task: what to find or do, every address, name and detail it needs, and what its answer must contain.',
        ),
      ),
      seconds: v.optional(
        v.pipe(
          v.number(),
          v.integer(),
          v.minValue(30),
          v.maxValue(1800),
          v.description('Time limit in seconds; 300 if omitted.'),
        ),
      ),
      tool_calls: v.optional(
        v.pipe(
          v.number(),
          v.integer(),
          v.minValue(1),
          v.maxValue(100),
          v.description('Most tool calls it may make; 30 if omitted.'),
        ),
      ),
    }),
    run: ({ data, toolCallId, api }) =>
      Effect.gen(function* () {
        const authority = yield* parent(wiring, api)
        const harness = yield* wiring.harness
        const key = yield* answeringKey(harness, api.conversationId)
        if (Option.isNone(key)) return yield* nobody('There is no message being answered here.')
        const run = yield* asActing(wiring.product, Option.some(authority.acting), (client) =>
          client.SpawnChildRun({
            delivery: key.value,
            toolCallId,
            kind: data.kind,
            brief: data.brief,
            budget: {
              seconds: data.seconds === undefined ? DEFAULT_CHILD_BUDGET.seconds : data.seconds,
              toolCalls:
                data.tool_calls === undefined ? DEFAULT_CHILD_BUDGET.toolCalls : data.tool_calls,
            },
          }),
        )
        const at = yield* Clock.currentTimeMillis
        yield* pi(() =>
          api.commit(
            (tx) =>
              wiring.helpers.start(tx, api.conversationId, run, {
                acting: authority.acting,
                timezone: authority.timezone,
                at,
              }),
            BACKGROUND_CONTEXT,
          ),
        )
        return {
          output: {
            helper: run.number,
            status: stateWord(run),
            message: `Helper ${run.number} is working on it. Its result comes back to you on its own.`,
          },
        }
      }),
  })

  const wait = defineTool({
    name: Tool.wait_runs,
    description:
      'Wait for helpers you started and get their answers here, when your next step cannot go on without them. Otherwise do not wait: their results come back to you on their own.',
    // A wait only reads; after a restart it waits again.
    replay: 'safe',
    input: v.object({
      helpers: v.pipe(v.array(helperNumber), v.minLength(1), v.maxLength(8)),
    }),
    run: ({ data, signal, api }) =>
      Effect.gen(function* () {
        yield* parent(wiring, api)
        const found = yield* named(wiring, api, data.helpers)
        const runIds = found.map(({ found: helper }) => helper.runId)
        // Claimed before waiting, so a result that ends meanwhile comes back here and not twice.
        yield* pi(() =>
          api.commit(
            (tx) => wiring.helpers.claimWait(tx, api.conversationId, runIds),
            BACKGROUND_CONTEXT,
          ),
        )
        // Stopping this wait stops only the wait; the helpers work on.
        const context = withAbortSignal(signal, BACKGROUND_CONTEXT)
        const results = yield* Effect.forEach(
          found,
          ({ number, found: helper }: { readonly number: number; readonly found: Named }) =>
            pi(() => api.waitForTask(helper.anchor, context)).pipe(
              Effect.andThen(wiring.helpers.answer(helper)),
              Effect.map((answer) => view(number, answer)),
            ),
          { concurrency: 'unbounded' },
        )
        return { output: { results } }
      }),
  })

  const cancel = defineTool({
    name: Tool.cancel_run,
    description:
      'Stop a helper you started that is no longer needed. What it already did stays done.',
    replay: 'safe',
    input: v.object({ helper: helperNumber }),
    run: ({ data, api }) =>
      Effect.gen(function* () {
        const authority = yield* parent(wiring, api)
        const [target] = yield* named(wiring, api, [data.helper])
        if (target === undefined) return yield* nobody(`There is no helper ${data.helper}.`)
        const run = yield* asActing(wiring.product, Option.some(authority.acting), (client) =>
          client.CancelChildRun({ id: target.found.runId }),
        )
        return { output: { helper: run.number, status: stateWord(run) } }
      }),
  })

  return [spawn, wait, cancel] as const
}
