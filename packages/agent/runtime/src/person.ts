import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import {
  createRegistry,
  Harness,
  type AgentChange,
  type Storage,
  type HarnessOptions,
} from '@earendil-works/pi-durable'
import type { PersonId } from '@vivid/contracts'
import { Context, Deferred, Effect, type Scope } from 'effect'
import { definition, offered } from './agents/vivid.ts'
import { resolveMemoryCall, scopeResolver } from './authority.ts'
import { Product } from './client.ts'
import type { ContextSources } from './context.ts'
import { opening } from './deliveries.ts'
import { Memory } from './memory.ts'
import { Models } from './models.ts'
import { joinHooks } from './response.ts'
import { followSettlements } from './settled.ts'
import { BuiltinSkills } from './skills.ts'
import { PiRejected } from './threads.ts'
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
  /** Waits until nothing a settlement set off is still being written (`settled.ts`). */
  readonly quiet: Effect.Effect<void>
}

/** The router is bound to this Person. It cannot open another Person from a route parameter. */
export class Person extends Context.Service<Person, PersonConversations>()(
  'vivid/Runtime/Person',
) {}

/**
 * Pi reports what did not fail the caller (a throwing hook or section) and, once, what failed
 * the Session. Only the error's class is logged: a provider error's message can quote a request.
 */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Pi's `onReport` hands over whatever was thrown.
const reported = (error: unknown) =>
  Effect.logWarning('Conversation library reported a failure', {
    error: error instanceof Error ? error.name : 'not an Error',
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
  Product | Models | BuiltinSkills | Memory | Scope.Scope
> {
  const product = yield* Product
  const models = yield* Models
  const skills = yield* BuiltinSkills

  const services = yield* Effect.context()
  // oxlint-disable-next-line vivid/no-runpromise-in-library -- The one bridge from Pi's Promise callbacks (sections, hooks) into Effect for this Person's Harness.
  const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromiseWith(services)(effect)
  const ready = yield* Deferred.make<Harness>()
  const opened = Deferred.await(ready)

  const memory = yield* Memory
  const all = tools(
    scopeResolver(opened, product),
    (call) => resolveMemoryCall(opened, product, call),
    memory,
  )
  const registry = createRegistry()
  registry.install(
    definition({
      tools: all,
      hooks: [joinHooks(run, opened)],
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
            onReport: (error) => {
              void run(reported(error))
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
  const { quiet } = yield* followSettlements(harness)
  yield* Deferred.succeed(ready, harness)
  return {
    personId,
    harness,
    agent: { model: models.selected, thinkingLevel: THINKING, tools: offered(all, skills) },
    sources: { product, memory },
    quiet,
  } satisfies PersonConversations
})
