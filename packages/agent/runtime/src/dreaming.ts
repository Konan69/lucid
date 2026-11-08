import { BACKGROUND_CONTEXT, type Context as PiContext } from '@earendil-works/chord/context'
import {
  configure,
  defineDoc,
  defineDocFamily,
  defineExtension,
  defineTask,
  ROOT_CONVERSATION_ID,
  type ConversationId,
  type EntryRecord,
  type Extension,
  type Harness,
  type ModelRef,
  type RunningTask,
  type SubmissionRecord,
  type Task,
  type TaskRuntime,
  type ToolRegistration,
} from '@earendil-works/pi-durable'
import {
  DreamKey,
  DreamRequest,
  DreamResponse,
  type DreamPass,
  MemoryAuthority,
  MemoryCitation,
  MemorySource,
  MemoryTaskId,
  PersonId,
  ThreadId,
} from '@vivid/contracts'
import type { VividRpcClient } from '@vivid/client-runtime'
import { DateTime, Effect, Option, Schema } from 'effect'
import { DreamReport, INSTRUCTIONS, dreamerDefinition } from './agents/dreamer.ts'
import { asActing, type Acting, type NobodyToActFor, type ProductService } from './client.ts'
import { isPersonEntry } from './delivery.ts'
import { Kept, keptUnder } from './deliveries.ts'
import { history, prose, Turn } from './learning.ts'
import type { MemoryWriter } from './memory.ts'
import { pi, threadOf, type PiRejected } from './threads.ts'

/**
 * The Dreamer: Dots' background researcher and Muse's nightly upkeep, run in the Person's cell
 * between conversations (docs/28, section 5; `agents/dreamer.ts` has the ported instructions).
 *
 * - `vivid.nights` is one task per cell that never ends. It sleeps until the next 03:00 in the
 *   Person's time zone, starts that night's Dreamer run, and sleeps again. Pi stores the sleep, so
 *   it survives restarts, and the cell's alarm wakes it (`apps/cells/src/main.ts` `#arm`).
 * - `vivid.dreaming` is one Dreamer run. A quiet pass first waits until a long conversation has
 *   been quiet for `QUIET_AFTER`. The run opens its own Background Thread on the server, reads in
 *   a task-owned child conversation with read-only tools, and reports at most one finding there,
 *   which wakes Vivid like a Watch event (`apps/server/src/dreams/handlers.ts`).
 */

/** The local hour of the nightly pass, decided 27 October 2026: "03:00 local". */
const NIGHT_HOUR = 3
/** How long a long conversation must stay quiet before its pass runs. Muse: "after a substantial conversation goes quiet". */
const QUIET_AFTER = 20 * 60_000
/** Person messages that make a conversation long enough for a quiet pass. */
const LONG = 6
/** Quiet passes a local day at most. Muse: "a few times a day at most". */
const QUIET_PER_DAY = 3
/** When no time zone is known yet, look again this much later. */
const UNKNOWN_ZONE_RETRY = 6 * 60 * 60_000
/** What one run reads of the day: conversations, turns of each, and characters of a turn. */
const DAY_CONVERSATIONS = 8
const DAY_TURNS = 40
const TURN_CHARACTERS = 2_000

/** A run failed in a way only a log can describe; its content never reaches the log. */
class DreamingFailed extends Schema.TaggedError<DreamingFailed>()(
  'DreamingFailed',
  {},
  { title: 'Dreaming failed' },
) {}

/**
 * Where the nightly Dreamer acts from: the Thread the Person last spoke in, their time zone as
 * that response saw it (`context.ts` `loadTimezone`), and the conversations they spoke in since
 * the last night, which that night re-reads. `nights` is the scheduler's task, created once.
 */
export const DreamHome = defineDoc<{
  threadId: string | null
  timezone: string
  today: Array<ConversationId>
  nights: number | null
}>({
  kind: 'vivid.dream.home',
  version: 1,
  scope: 'session',
  checkpointWhen: () => true,
  initial: () => ({ threadId: null, timezone: '', today: [], nights: null }),
})

/** Quiet passes started on one local date, and in which conversations: at most one each. */
const QuietDay = defineDocFamily<{ conversations: Array<ConversationId> }, null>({
  kind: 'vivid.dream.quiet',
  version: 1,
  scope: 'session',
  family: true,
  checkpointWhen: () => true,
  initial: () => ({ conversations: [] }),
})

/** Host-only authority of one Dreamer child: whom it acts for, from which Thread, in which zone. */
type Authority = {
  personId: string
  taskId: number
  threadId: string
  timezone: string
}
const DreamerAuthority = defineDocFamily<Authority, Authority>({
  kind: 'vivid.dreamer',
  version: 1,
  scope: 'conversation',
  family: true,
  checkpointWhen: () => false,
  history: 'latest',
  fork: 'initial',
  initial: (seed) => seed,
})
const AUTHORITY_KEY = 'authority'

/** One Dreamer run. `from` is the Thread it acts from until its own is open. */
interface Input {
  readonly pass: DreamPass
  readonly key: string
  readonly from: string
  readonly timezone: string
  /** For a quiet pass, the Person's newest message when it was started; it runs once nothing newer came. */
  readonly seen: number
  readonly conversations: ReadonlyArray<ConversationId>
}
type Step =
  | { readonly phase: 'settle'; readonly seen: number }
  | { readonly phase: 'check'; readonly seen: number }
  | { readonly phase: 'open' }
  | { readonly phase: 'dream'; readonly thread: string; readonly child: ConversationId }
  | { readonly phase: 'report'; readonly thread: string; readonly child: ConversationId }
type NightStep = { readonly phase: 'wait' } | { readonly phase: 'start'; readonly key: string }
type Runtime = TaskRuntime<Input, Step, null, object>
type At<P extends Step['phase']> = RunningTask<Input, Extract<Step, { phase: P }>, null>
type Settled = SubmissionRecord & { readonly type: 'input' }

/** The Dreamer run's definition name in Pi's registry; a forget stops live runs by it (`forget.ts`). */
export const DREAMING_TASK = 'vivid.dreaming'

/** The next 03:00 after `now` in `timezone`, and that night's local date. None for an unknown zone. */
export function nextNight(now: number, timezone: string) {
  return Option.map(DateTime.makeZoned(now, { timeZone: timezone }), (zoned) => {
    const tonight = DateTime.setParts(zoned, {
      hour: NIGHT_HOUR,
      minute: 0,
      second: 0,
      millisecond: 0,
    })
    const night =
      DateTime.toEpochMillis(tonight) > now ? tonight : DateTime.add(tonight, { days: 1 })
    return { at: DateTime.toEpochMillis(night), date: localDate(night) }
  })
}

/** A zoned time's local date, `YYYY-MM-DD`. */
const localDate = (zoned: DateTime.Zoned) => DateTime.formatIsoDate(zoned)

/** The Person's local date now, or the UTC date while no zone is known. */
const today = (now: number, timezone: string) =>
  Option.match(DateTime.makeZoned(now, { timeZone: timezone }), {
    onNone: () => new Date(now).toISOString().slice(0, 10),
    onSome: localDate,
  })

/** The Person's own messages in a conversation, oldest first. Signals from others are not theirs. */
const spoken = (entries: ReadonlyArray<EntryRecord>) =>
  entries.filter((entry) => isPersonEntry(entry.kind))

/** The newest of the Person's messages, 0 when there is none. */
const newest = (entries: ReadonlyArray<EntryRecord>) => {
  const said = spoken(entries)
  const last = said.at(-1)
  return last === undefined ? 0 : last.id
}

/** A conversation's last turns as words, each bounded: what the Dreamer re-reads of it. */
function turnsOf(entries: ReadonlyArray<EntryRecord>) {
  const turns: Array<typeof Turn.Type> = []
  for (const entry of entries) {
    const said = isPersonEntry(entry.kind) ? prose(entry, 'user') : ''
    if (said.length > 0)
      turns.push(Turn.make({ from: 'person', text: said.slice(0, TURN_CHARACTERS) }))
    const reply = prose(entry, 'assistant')
    if (reply.length > 0)
      turns.push(Turn.make({ from: 'vivid', text: reply.slice(0, TURN_CHARACTERS) }))
  }
  return turns.slice(-DAY_TURNS)
}

const decodeKept = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.toCodecJson(Kept)))

/** The time zone the response to this input was given, `''` when its settings named none. */
const zoneOf = Effect.fn('Dreaming.zoneOf')(function* (harness: Harness, input: Settled) {
  if (input.requestId === undefined) return ''
  const kept = yield* keptUnder(harness, input.conversationId, input.requestId)
  return Option.match(Option.flatMap(kept, decodeKept), {
    onNone: () => '',
    onSome: ({ context }) => context.timezone,
  })
})

/** Whether any of these settled inputs was the Person's own words, and the zone they were answered in. */
const personSpoke = Effect.fn('Dreaming.personSpoke')(function* (
  harness: Harness,
  inputs: ReadonlyArray<Settled>,
) {
  for (const input of inputs) {
    const id = input.entry
    if (id === undefined) continue
    const entry = yield* pi(() => harness.commit((tx) => tx.entry(id), BACKGROUND_CONTEXT))
    if (entry !== undefined && isPersonEntry(entry.kind))
      return Option.some(yield* zoneOf(harness, input))
  }
  return Option.none<string>()
})

interface Dreaming {
  readonly extension: Extension
  readonly dreamer: Extension
  /** Follow one conversation's settlement: record home, schedule the nights, maybe a quiet pass. */
  readonly settled: (
    harness: Harness,
    inputs: ReadonlyArray<Settled>,
  ) => Effect.Effect<void, PiRejected | DreamingFailed>
}

/** Everything a Dreamer run needs from its Person, captured once when the cell opens. */
interface Owner {
  readonly host: PersonId
  readonly product: ProductService
  readonly opened: Effect.Effect<Harness>
  readonly model: ModelRef
}

export type RunDreaming = <A, E>(program: Effect.Effect<A, E>, signal: AbortSignal) => Promise<A>

/** Ask the server as the Person, from a Thread; any refusal or outage is one failure here. */
const asked = <A, E>(
  owner: Owner,
  acting: Acting,
  call: (client: VividRpcClient['Service']) => Effect.Effect<A, E>,
): Effect.Effect<A, DreamingFailed> => {
  const program: Effect.Effect<A, E | NobodyToActFor> = asActing(
    owner.product,
    Option.some(acting),
    call,
  )
  return Effect.mapError(program, () => new DreamingFailed())
}

const decodeThread = Schema.decodeUnknownEffect(ThreadId)
const decodeKey = Schema.decodeUnknownEffect(DreamKey)

/** A quiet pass waits for quiet: it runs once the conversation has no newer message after the wait. */
const check = Effect.fn('Dreaming.check')(function* (
  record: At<'check'>,
  runtime: Runtime,
  context: PiContext,
  owner: Owner,
) {
  const [conversation] = record.input.conversations
  if (conversation === undefined) return yield* new DreamingFailed()
  const latest = newest(yield* history(yield* owner.opened, conversation))
  if (latest !== record.state.checkpoint.seen)
    return yield* pi(() =>
      runtime.sleepUntil(runtime.now() + QUIET_AFTER, { phase: 'check', seen: latest }, context),
    )
  yield* pi(() =>
    runtime.commit(() => ({ status: 'running', checkpoint: { phase: 'open' } }), context),
  )
})

/**
 * Open the dream's Thread on the server, then the child that reads in it, with its authority, in
 * one commit. Opening is idempotent by key, so a restart between the two opens the same Thread.
 */
const open = Effect.fn('Dreaming.open')(function* (
  record: At<'open'>,
  runtime: Runtime,
  context: PiContext,
  owner: Owner & { readonly dreamer: Extension },
) {
  const { input } = record
  const from = yield* decodeThread(input.from).pipe(Effect.mapError(() => new DreamingFailed()))
  const key = yield* decodeKey(input.key).pipe(Effect.mapError(() => new DreamingFailed()))
  const answer = yield* asked(owner, { threadId: from, personId: owner.host }, (client) =>
    client.Dream(DreamRequest.cases.Open.make({ key, pass: input.pass })),
  )
  if (!DreamResponse.guards.Opened(answer)) return yield* new DreamingFailed()
  const opened = answer
  yield* pi(() =>
    // @effect-diagnostics-next-line asyncFunction:off -- Pi owns the atomic child-creation callback.
    runtime.commit(async (tx) => {
      const child = await tx.createConversation({ ownership: { kind: 'task', taskId: record.id } })
      await configure(tx, child.id, {
        model: owner.model,
        thinkingLevel: 'medium',
        extensions: [owner.dreamer],
        tools: owner.dreamer.tools,
        instructions: INSTRUCTIONS,
      })
      await tx.doc(DreamerAuthority, child.id, AUTHORITY_KEY, {
        personId: owner.host,
        taskId: record.id,
        threadId: opened.threadId,
        timezone: input.timezone,
      })
      return {
        status: 'running',
        checkpoint: { phase: 'dream', thread: opened.threadId, child: child.id },
      }
    }, context),
  )
})

/** What the child is given: which pass, when, where, and the words of the conversations it re-reads. */
const brief = Effect.fn('Dreaming.brief')(function* (input: Input, owner: Owner, now: number) {
  const harness = yield* owner.opened
  const conversations = []
  for (const id of input.conversations.slice(-DAY_CONVERSATIONS)) {
    // A conversation removed since the Person spoke in it has nothing left to re-read.
    const turns = turnsOf(yield* history(harness, id).pipe(Effect.orElseSucceed(() => [])))
    if (turns.length > 0) conversations.push({ turns })
  }
  return JSON.stringify({
    pass: input.pass,
    at: new Date(now).toISOString(),
    localDate: today(now, input.timezone),
    timezone: input.timezone.length > 0 ? input.timezone : 'unknown',
    conversations,
  })
})

/** Reopening resubmits under the same request id, then waits on the original native submission. */
const dream = Effect.fn('Dreaming.dream')(function* (
  record: At<'dream'>,
  runtime: Runtime,
  context: PiContext,
  owner: Owner,
) {
  const { thread, child } = record.state.checkpoint
  const conversation = yield* pi(() => runtime.conversation(child, context))
  if (conversation === undefined) return yield* new DreamingFailed()
  const content = yield* brief(record.input, owner, runtime.now())
  const submission = yield* pi(() =>
    conversation.submit({ type: 'input', content, requestId: `dreaming:${record.id}` }, context),
  )
  const settled = yield* pi(() => submission.wait(context))
  if (settled.status !== 'done') yield* Effect.logWarning('DreamingFailed')
  yield* pi(() =>
    runtime.commit(
      () => ({ status: 'running', checkpoint: { phase: 'report', thread, child } }),
      context,
    ),
  )
})

/** Deliver the finding, if the child reported one, from the dream's own Thread. Then end. */
const report = Effect.fn('Dreaming.report')(function* (
  record: At<'report'>,
  runtime: Runtime,
  context: PiContext,
  owner: Owner,
) {
  const { thread, child } = record.state.checkpoint
  const harness = yield* owner.opened
  const found = yield* pi(() => harness.snapshot(DreamReport, child, BACKGROUND_CONTEXT))
  if (found !== undefined && found.finding !== null) {
    const threadId = yield* decodeThread(thread).pipe(Effect.mapError(() => new DreamingFailed()))
    const finding = found.finding
    yield* asked(owner, { threadId, personId: owner.host }, (client) =>
      client.Dream(DreamRequest.cases.Report.make({ pass: record.input.pass, finding })),
    )
  }
  yield* pi(() =>
    runtime.commit(
      () => ({ status: 'terminal', outcome: { status: 'completed', result: null } }),
      context,
    ),
  )
})

/** Fail only this run. A stopped invocation cannot commit, so Pi resumes its old phase. */
const failed =
  (runtime: Runtime, context: PiContext) =>
  <A, E>(program: Effect.Effect<A, E>) =>
    program.pipe(
      Effect.catch(() =>
        Effect.logWarning('DreamingFailed').pipe(
          Effect.andThen(
            pi(() =>
              runtime.commit(
                () => ({
                  status: 'terminal',
                  outcome: { status: 'failed', error: { message: 'DreamingFailed' } },
                }),
                context,
              ),
            ),
          ),
        ),
      ),
    )

/** One Dreamer run as a Pi task. Every phase runs through the Person's Effect bridge. */
function dreamingTask(run: RunDreaming, owner: Owner & { readonly dreamer: Extension }) {
  return defineTask<Input, Step, null>({
    name: DREAMING_TASK,
    version: 1,
    initial: (input) =>
      input.pass === 'Quiet' ? { phase: 'settle', seen: input.seen } : { phase: 'open' },
    phases: {
      settle: (record, runtime, context) =>
        runtime.sleepUntil(
          runtime.now() + QUIET_AFTER,
          { phase: 'check', seen: record.state.checkpoint.seen },
          context,
        ),
      check: (record, runtime, context) =>
        run(check(record, runtime, context, owner).pipe(failed(runtime, context)), runtime.signal),
      open: (record, runtime, context) =>
        run(open(record, runtime, context, owner).pipe(failed(runtime, context)), runtime.signal),
      dream: (record, runtime, context) =>
        run(dream(record, runtime, context, owner).pipe(failed(runtime, context)), runtime.signal),
      report: (record, runtime, context) =>
        run(report(record, runtime, context, owner).pipe(failed(runtime, context)), runtime.signal),
    },
    abort: (_record, runtime, context) =>
      runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), context),
  })
}

/**
 * The nightly scheduler. `wait` sleeps until the next 03:00 in the zone the Person was last
 * answered in, read when it is computed, so a changed zone takes effect from the next night.
 * `start` creates that night's run with the conversations of the day and clears them, in one
 * commit, so a restart cannot start a night twice.
 */
function nightsTask(night: Task<Input, Step, null, object>) {
  return defineTask<null, NightStep, null>({
    name: 'vivid.nights',
    version: 1,
    initial: () => ({ phase: 'wait' }),
    phases: {
      wait: (_record, runtime, context) =>
        // @effect-diagnostics-next-line asyncFunction:off -- Pi owns the commit callback.
        runtime.commit(async (tx) => {
          const home = await tx.doc(DreamHome)
          const now = runtime.now()
          return Option.match(nextNight(now, home.timezone), {
            onNone: () => ({
              status: 'sleeping' as const,
              until: now + UNKNOWN_ZONE_RETRY,
              checkpoint: { phase: 'wait' as const },
            }),
            onSome: ({ at, date }) => ({
              status: 'sleeping' as const,
              until: at,
              checkpoint: { phase: 'start' as const, key: `night-${date}` },
            }),
          })
        }, context),
      start: (record, runtime, context) =>
        // @effect-diagnostics-next-line asyncFunction:off -- Pi owns the commit callback.
        runtime.commit(async (tx) => {
          const home = await tx.doc(DreamHome)
          if (home.threadId !== null) {
            await tx.createTask(
              night,
              {
                pass: 'Night',
                key: record.state.checkpoint.key,
                from: home.threadId,
                timezone: home.timezone,
                seen: 0,
                conversations: home.today,
              },
              { ownership: { kind: 'conversation' }, background: true },
            )
            home.today = []
          }
          return { status: 'running', checkpoint: { phase: 'wait' } }
        }, context),
    },
    abort: (_record, runtime, context) =>
      runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), context),
  })
}

/**
 * After the Person spoke in a conversation: it becomes home, the day's list gains it, the nightly
 * scheduler exists, and a long conversation gets its quiet pass, at most one each and a few a day.
 * One commit, so a repeated settlement converges on the same state.
 */
const follow = (tasks: {
  readonly nights: Task<null, NightStep, null, object>
  readonly runs: Task<Input, Step, null, object>
}) =>
  Effect.fn('Dreaming.settled')(function* (harness: Harness, inputs: ReadonlyArray<Settled>) {
    const [first] = inputs
    if (first === undefined) return
    const conversationId = first.conversationId
    const thread = yield* threadOf(harness, conversationId)
    if (Option.isNone(thread)) return
    const zone = yield* personSpoke(harness, inputs)
    if (Option.isNone(zone)) return
    const entries = yield* history(harness, conversationId).pipe(
      Effect.mapError(() => new DreamingFailed()),
    )
    const said = spoken(entries)
    const long = said.length >= LONG
    const seen = newest(entries)
    const now = Date.now()
    // The nightly scheduler lives on the cell's root conversation, which Pi creates on first use.
    const home = yield* pi(() => harness.snapshot(DreamHome, BACKGROUND_CONTEXT))
    if (home === undefined || home.nights === null)
      yield* pi(() => harness.root(BACKGROUND_CONTEXT))
    yield* pi(() =>
      // @effect-diagnostics-next-line asyncFunction:off -- Pi owns the atomic commit callback.
      harness.commit(async (tx) => {
        const home = await tx.doc(DreamHome)
        home.threadId = thread.value.threadId
        if (zone.value.length > 0) home.timezone = zone.value
        if (!home.today.includes(conversationId))
          home.today = [...home.today, conversationId].slice(-DAY_CONVERSATIONS)
        if (home.nights === null)
          home.nights = await tx.createTask(tasks.nights, null, {
            ownership: { kind: 'conversation' },
            background: true,
            conversationId: ROOT_CONVERSATION_ID,
          })
        if (!long) return
        const date = today(now, home.timezone)
        const day = await tx.doc(QuietDay, date, null)
        if (day.conversations.includes(conversationId)) return
        if (day.conversations.length >= QUIET_PER_DAY) return
        day.conversations = [...day.conversations, conversationId]
        await tx.createTask(
          tasks.runs,
          {
            pass: 'Quiet',
            key: `quiet-${date}-${conversationId}`,
            from: thread.value.threadId,
            timezone: home.timezone,
            seen,
            conversations: [conversationId],
          },
          { ownership: { kind: 'conversation' }, background: true, conversationId },
        )
      }, BACKGROUND_CONTEXT),
    )
  })

/** Pi owns durability; the Person owns the Effect bridge, the product client and the model. */
export function dreaming(
  run: RunDreaming,
  owner: Owner,
  tools: ReadonlyArray<ToolRegistration>,
  writes: ReadonlyArray<ToolRegistration>,
): Dreaming {
  const dreamer = dreamerDefinition(tools, writes)
  const task = dreamingTask(run, { ...owner, dreamer })
  const nights = nightsTask(task)
  return {
    extension: defineExtension({ name: 'vivid-dreaming', tasks: [task, nights] }),
    dreamer,
    settled: follow({ nights, runs: task }),
  }
}

const decodePerson = Schema.decodeEffect(PersonId)
const decodeTask = Schema.decodeEffect(MemoryTaskId)

/**
 * The authority of a Dreamer child, read from Pi's committed document and never from tool
 * arguments: who it acts for, the dream's Thread its tools act in, the zone its dates are in, and
 * the `CellRun` its memory writes cite. None for any other conversation.
 */
export const dreamerAuthority: (
  harness: Harness,
  conversationId: ConversationId,
) => Effect.Effect<
  Option.Option<{
    readonly acting: Acting
    readonly timezone: string
    readonly writer: MemoryWriter
  }>,
  PiRejected | DreamingFailed
> = Effect.fn('Dreaming.authority')(function* (harness: Harness, conversationId: ConversationId) {
  const scope = yield* pi(() =>
    harness.snapshot(DreamerAuthority, conversationId, AUTHORITY_KEY, BACKGROUND_CONTEXT),
  )
  if (scope === undefined) return Option.none()
  const personId = yield* decodePerson(scope.personId).pipe(
    Effect.mapError(() => new DreamingFailed()),
  )
  const threadId = yield* decodeThread(scope.threadId).pipe(
    Effect.mapError(() => new DreamingFailed()),
  )
  const taskId = yield* decodeTask(scope.taskId).pipe(Effect.mapError(() => new DreamingFailed()))
  const source = MemorySource.cases.CellRun.make({ personId, taskId })
  return Option.some({
    acting: { threadId, personId },
    timezone: scope.timezone,
    writer: {
      authority: MemoryAuthority.make({ actor: personId, source }),
      citations: [MemoryCitation.cases.Run.make({ source })],
    },
  })
})
