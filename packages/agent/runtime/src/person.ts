import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import {
  createRegistry,
  Harness,
  type AgentChange,
  type Storage,
  type HarnessOptions,
  type ReportInfo,
} from '@earendil-works/pi-durable'
import { CodeName, type PersonId } from '@vivid/contracts'
import { Context, Deferred, Effect, Option, Schema, type Scope } from 'effect'
import { definition, offered } from './agents/vivid.ts'
import { resolveMemoryCall, scopeResolver } from './authority.ts'
import { Product } from './client.ts'
import type { ContextSources } from './context.ts'
import { opening } from './deliveries.ts'
import { Memory } from './memory.ts'
import { learning } from './learning.ts'
import { dreaming } from './dreaming.ts'
import type { DecisionModel } from 'effect/ai'
import { Models } from './models.ts'
import { correctionHooks } from './correction.ts'
import { continuityHooks } from './continuity.ts'
import { joinHooks } from './response.ts'
import { followSettlements } from './settled.ts'
import { helpers, type Helpers } from './children.ts'
import { BuiltinSkills } from './skills.ts'
import { unansweredCause } from './failure.ts'
import { CellFailure, CellReports, cellHop, thrownTag } from './telemetry.ts'
import { PiRejected } from './threads.ts'
import { childTools } from './tools/children.ts'
import { tools } from './tools/index.ts'

/** One Person's conversations on the native storage supplied by its host. */
export interface PersonConversations {
  readonly personId: PersonId
  readonly harness: Harness
  /**
   * What every admitted delivery sets its conversation to: the selected model and the order the
   * tools are offered in. Pi keeps both per conversation (`pi.agent`), so stating them at each
   * admission is what lets a changed `VIVID_MODEL` or a new tool reach an old Thread.
   */
  readonly agent: AgentChange
  readonly sources: ContextSources
  /** The helpers Vivid starts from this Person's Threads, for the routes that read, stop and follow them up. */
  readonly helpers: Helpers
  /** Waits for queued settlement follow-ups, including learning admission. Pi owns background completion. */
  readonly quiet: Effect.Effect<void>
}

/** The router is bound to this Person. It cannot open another Person from a route parameter. */
export class Person extends Context.Service<Person, PersonConversations>()(
  'vivid/Runtime/Person',
) {}

/** celld's refusal of a commit made after the event that admitted it ended (`RETIRED_INPUT_GATE`). */
const RETIRED_EVENT = 'the cell event ended before it could acquire an input gate'
const RETIRED = CodeName.make('RetiredInputGate')
/** The operation of a report that names no task: Pi's Harness itself. */
const HARNESS = CodeName.make('Harness')
const decodeKind = Schema.decodeUnknownOption(CodeName)

/**
 * Pi reports what did not fail the caller (a throwing hook or section) and, once, what failed
 * the Session (`ReportInfo`). It is said as a `PiReported` cell failure: Pi's report type, the
 * task kind it names as the operation, and the thrown value's class, plus one fixed category for
 * the native refusal we know. Never the message itself: a provider error's message can quote a
 * request. Pi's task kinds are code-registered dotted names (`vivid.learning`), so one that is not
 * a code name is not reported as an operation.
 */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Pi's `onReport` hands over whatever was thrown.
const reported = (personId: PersonId, error: unknown, info: ReportInfo) =>
  CellFailure.cases.PiReported.make({
    personId,
    report: info.type,
    cause: [
      cellHop(
        'task' in info && info.task !== undefined
          ? Option.getOrElse(decodeKind(info.task.kind), () => HARNESS)
          : HARNESS,
        error instanceof Error && error.message === RETIRED_EVENT ? RETIRED : thrownTag(error),
      ),
    ],
  })

/** Keep Vivid's thinking level explicit. Pi otherwise defaults a conversation to `off`. */
const THINKING = 'medium'

/** Place every waiting delivery at the next response boundary, so the model sees corrections
 * alongside the message they correct. Pi otherwise places one delivery per turn. */
const QUEUES = { steeringMode: 'all', followUpMode: 'all' } as const

/**
 * Close joins the running task code and closes the store. A store that fails while closing has
 * already failed the Harness, which reports it once (`onReport`); there is nothing left to undo.
 */
const closeHarness = (harness: Harness) =>
  Effect.tryPromise(() => harness.close(BACKGROUND_CONTEXT)).pipe(Effect.ignore)

/**
 * Pi owns the native storage and its task scheduler. The cell owns this scope, and onWake
 * delegates sleep and active-work alarms to celld without a process registry or owner fence.
 * Callbacks capture the services once and wait for Harness.open before using the Harness.
 */
export const openPerson = Effect.fn('Person.open')(function* (
  personId: PersonId,
  storage: Storage,
  onWake: HarnessOptions['onWake'],
): Effect.fn.Return<
  PersonConversations,
  PiRejected,
  Product | Models | BuiltinSkills | Memory | DecisionModel.DecisionModel | Scope.Scope
> {
  const product = yield* Product
  const models = yield* Models
  const skills = yield* BuiltinSkills
  const reports = yield* CellReports

  const services = yield* Effect.context()
  const run = <A, E>(
    effect: Effect.Effect<A, E>,
    options: { readonly signal?: AbortSignal } = {},
  ) =>
    // oxlint-disable-next-line vivid/no-runpromise-in-library -- Pi owns the Promise callback boundary for this Person.
    Effect.runPromiseWith(services)(effect, options)
  const ready = yield* Deferred.make<Harness>()
  const opened = Deferred.await(ready)

  const memory = yield* Memory
  // Helper tools are mounted in the registry with the rest; the helpers they start take fixed
  // subsets of that registry, so they are made once it exists and these tools wait for them.
  const helpersReady = yield* Deferred.make<Helpers>()
  const registered = tools(
    scopeResolver(opened, product),
    (call) => resolveMemoryCall(opened, product, call),
    { memory, transcripts: { person: personId, harness: opened } },
    {
      skills: skills.tools === undefined ? [] : skills.tools,
      children: childTools({ harness: opened, product, helpers: Deferred.await(helpersReady) }),
    },
  )
  const all = registered.tools
  const registry = createRegistry()
  const dream = dreaming(
    (program, signal) => run(program, { signal }),
    { host: personId, product, opened, model: models.selected },
    all,
    registered.dreaming,
  )
  registry.install(dream.extension)
  registry.install(dream.dreamer)
  const learn = yield* learning(
    personId,
    (program, signal) => run(program, { signal }),
    memory,
    all,
  )
  registry.install(learn.extension)
  registry.install(learn.learner)
  // Helpers get fixed subsets of Vivid's own tools; only Vivid's own conversation can start one.
  const helping = helpers({
    harness: opened,
    product,
    run: (program, signal) => run(program, { signal }),
    tools: all,
  })
  for (const extension of helping.extensions) registry.install(extension)
  yield* Deferred.succeed(helpersReady, helping)
  registry.install(
    definition({
      tools: all,
      // The run's own record goes first: Pi stops calling `onYield` hooks after the first that continues.
      hooks: [joinHooks(run, opened), continuityHooks(run, opened), correctionHooks(run, opened)],
      frozen: (conversationId) =>
        run(Effect.flatMap(opened, (harness) => opening(harness, conversationId))),
    }),
  )
  registry.install(skills)

  const harness = yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: () =>
        Harness.open(
          storage,
          {
            models: models.collection,
            registry,
            settings: {
              ...models.settings,
              ...QUEUES,
              afterFailedRun: 'continue',
            },
            onWake,
            onReport: (error, info) => {
              void run(reports.record(reported(personId, error, info), Option.none()))
            },
          },
          BACKGROUND_CONTEXT,
        ),
      // Pi closes the store when opening its tasks fails, but not when it refuses earlier (a
      // registry without the built-in tasks), so it is closed here too; a second close is the
      // same close.
      catch: (cause) => new PiRejected({ cause }),
    }).pipe(Effect.onError(() => Effect.promise(() => storage.close(BACKGROUND_CONTEXT)))),
    closeHarness,
  )
  const { quiet } = yield* followSettlements(harness, learn.start, dream.settled)
  // An input Pi settles with no answer is said once, from the commit that settled it: the
  // settlement route is read again by every wait, and a stop (`aborted`) is the Person's own.
  const unfollow = harness.subscribeCommits((publication) => {
    for (const change of publication.changes) {
      if (change.type !== 'submission') continue
      const record = change.value
      if (record.type !== 'input' || record.status !== 'unanswered') continue
      if (record.reason === 'aborted') continue
      const failure = CellFailure.cases.ResponseFailed.make({
        personId,
        ...unansweredCause(record.reason, record.detail),
      })
      void run(reports.record(failure, Option.none()))
    }
  })
  yield* Effect.addFinalizer(() => Effect.sync(unfollow))
  yield* Deferred.succeed(ready, harness)
  return {
    personId,
    harness,
    agent: {
      model: models.selected,
      thinkingLevel: THINKING,
      tools: offered(all, skills),
    },
    sources: { product, memory, capabilities: registered.reading },
    helpers: helping,
    quiet,
  } satisfies PersonConversations
})
