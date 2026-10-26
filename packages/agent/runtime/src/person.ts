import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { createRegistry, Harness, type AgentChange } from '@earendil-works/pi-durable'
import type { PersonId } from '@vivid/contracts'
import { Deferred, Effect, Option, type Scope } from 'effect'
import { definition, offered } from './agents/vivid.ts'
import { resolveCall, scopeResolver } from './authority.ts'
import { Product } from './client.ts'
import type { ContextSources } from './context.ts'
import { opening } from './deliveries.ts'
import { Notes } from './notes.ts'
import { Models } from './models.ts'
import { joinHooks } from './response.ts'
import { RuntimeSettings } from './settings.ts'
import type { StoreUnavailable } from './storage/errors.ts'
import { Stores } from './storage/stores.ts'
import { followSettlements } from './settled.ts'
import { HarnessWake } from './wake.ts'
import { BuiltinSkills } from './skills.ts'
import { PiRejected } from './threads.ts'
import { tools } from './tools/index.ts'

/** One Person's conversations, open: Pi's Harness on that Person's own store (`storage/store.ts`). */
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

/**
 * Pi reports what did not fail the caller (a throwing hook or section) and, once, what failed
 * the Session. Only the error's class is logged: a provider error's message can quote a request.
 */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Pi's `onReport` hands over whatever was thrown.
const reported = (error: unknown) =>
  Effect.logWarning('Conversation library reported a failure', {
    error: error instanceof Error ? error.name : 'not an Error',
  })

/**
 * How much the model is asked to think. Main ran on Flue's default, `medium` (its Session built
 * the agent with `thinkingLevel ?? 'medium'`); Pi's default for a conversation that states none
 * is `off`, so it is stated.
 */
const THINKING = 'medium'

/**
 * Deliveries that arrive during a response are all placed at its next boundary, as on main
 * (Flue built its agent with `steeringMode: 'all'` and `followUpMode: 'all'`). Pi's default
 * places one per turn, which could let the model act on one message before reading the
 * correction sent right after it.
 */
const QUEUES = { steeringMode: 'all', followUpMode: 'all' } as const

/**
 * Close joins the running task code and closes the store. A store that fails while closing has
 * already failed the Harness, which reports it once (`onReport`); there is nothing left to undo.
 */
const closeHarness = (harness: Harness) =>
  Effect.tryPromise(() => harness.close(BACKGROUND_CONTEXT)).pipe(Effect.ignore)

/**
 * Open one Person's conversations for the life of the enclosing scope.
 *
 * Acquired in this order and released in the reverse: the Person's store, found or made in the
 * shared tables (`storage/stores.ts`), and Pi's Harness over it (closing the Harness closes the
 * store, Pi `src/session/session.ts` `close`), then the fiber that follows settlements. So the
 * fiber stops first, and the Harness joins its running tasks and closes the store. Closing a
 * store releases nothing shared: the connections belong to the process.
 *
 * Pi runs a prompt section, a hook and a tool as Promise callbacks. They are given `run`, which
 * runs an Effect with the services this open captured; it is the one bridge from Pi's callbacks
 * back into Effect for this Person. Those callbacks need the Harness, which does not exist until
 * the registry holding them has been given to `Harness.open`; `ready` hands it over. Pi calls
 * none of them before `resume()` or a submission, both of which come after.
 */
export const openPerson: (
  personId: PersonId,
) => Effect.Effect<
  PersonConversations,
  StoreUnavailable | PiRejected,
  RuntimeSettings | Product | Models | BuiltinSkills | Stores | Notes | Scope.Scope
> = Effect.fn('Person.open')(function* (personId: PersonId) {
  const product = yield* Product
  const models = yield* Models
  const skills = yield* BuiltinSkills
  const wake = yield* HarnessWake
  const storage = yield* (yield* Stores).open(personId)

  const services = yield* Effect.context()
  // oxlint-disable-next-line vivid/no-runpromise-in-library -- The one bridge from Pi's Promise callbacks (sections, hooks) into Effect for this Person's Harness.
  const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromiseWith(services)(effect)
  const ready = yield* Deferred.make<Harness>()
  const opened = Deferred.await(ready)

  const notes = yield* Notes
  const all = tools(
    scopeResolver(opened, product),
    (call) =>
      Effect.map(resolveCall(opened, product, call), (authority) => authority.acting.personId),
    notes,
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
            },
            onReport: (error) => {
              void run(reported(error))
            },
            // Absent for the Node process, which keeps Pi's own timers (`wake.ts`).
            onWake: Option.getOrUndefined(wake),
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
  yield* Deferred.succeed(ready, harness)
  const { quiet } = yield* followSettlements(harness)
  return {
    personId,
    harness,
    agent: { model: models.selected, thinkingLevel: THINKING, tools: offered(all, skills) },
    sources: { product, notes },
    quiet,
  } satisfies PersonConversations
})
