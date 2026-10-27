import { Duration } from 'effect'
import { Notes, NotesSettings, layer as notesLayer } from './notes.ts'
import { BACKGROUND_CONTEXT, withAbortSignal } from '@earendil-works/chord/context'
import type { PersonId } from '@vivid/contracts'
import {
  Context,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Scope,
  Semaphore,
  type Stream,
  SubscriptionRef,
} from 'effect'
import { Product } from './client.ts'
import { Models } from './models.ts'
import { openPerson, type PersonConversations } from './person.ts'
import { RuntimeSettings } from './settings.ts'
import { BuiltinSkills } from './skills.ts'
import type { StoreUnavailable } from './storage/errors.ts'
import { Stores } from './storage/stores.ts'
import { placeAllWaiting, withdrawWaitingWrites } from './deliveries.ts'
import { PiRejected, pi } from './threads.ts'

/** One open Person: the conversations, the scope that owns them, and how busy they are. */
interface Open {
  readonly person: PersonConversations
  readonly scope: Scope.Closeable
  /** Requests using the Harness right now. */
  uses: number
  /** True while nothing is live and the idle bound is running down. */
  resting: boolean
  /** The fiber counting the idle bound down since the last request ended, when one is. */
  rest: Option.Option<Fiber.Fiber<void>>
}

/** One open Person as the process reports it. */
export interface OpenPerson {
  readonly personId: PersonId
  /** No live work, and the idle bound is running; the conversations close when it has passed. */
  readonly resting: boolean
}

export interface PersonsService {
  /**
   * Run `use` with a Person's conversations, opening them when they are not open. They stay
   * open at least until `use` ends.
   */
  readonly use: <A, E, R>(
    personId: PersonId,
    use: (person: PersonConversations) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | PiRejected | StoreUnavailable, R>
  /** The Persons whose conversations are open, now and after every open, rest and close. */
  readonly watch: Stream.Stream<ReadonlyArray<OpenPerson>>
}

/**
 * Every Person's conversations, each opened when a request for that Person arrives and closed
 * when it has had no live work and no request for the idle bound.
 *
 * One Person is one logical store (`storage/stores.ts`) and one Harness, so the code that later
 * runs on a Person's own Computer is this code for one Person, and moving them there is moving
 * that store's rows. Every store shares the process's connection pool; none holds a connection.
 *
 * Failure handling is Pi 1.2.0's rule and nothing more: a storage error fails and closes the
 * Harness, every later call rejects, and the host reopens. The Harness says when that has
 * happened (`harness.closed` with `failed`), and that alone drops a Person; a single rejected
 * call does not, because Pi also rejects a call for reasons that leave the store sound (an
 * invalid request, a commit callback that threw). The next request for a dropped Person opens a
 * fresh Harness from what was committed. There is no retry here; the server's retry with the same
 * idempotency key finds a delivery that was already admitted.
 */
export class Persons extends Context.Service<Persons, PersonsService>()('vivid/Runtime/Persons') {}

/** What the open Persons share: the map, the gate that orders its changes, and where they are told. */
interface Registry {
  readonly open: Map<PersonId, Open>
  /**
   * Opening and closing a Person are the only transitions of `open`, and they take turns: a
   * request that arrives while a Person is closing waits, then opens a fresh Harness on the
   * store the close has just let go of, so one store never has two Harnesses (Pi allows one
   * owner). Opening is a few reads, so one gate for every Person costs less than a gate per
   * Person would in bookkeeping.
   */
  readonly gate: Semaphore.Semaphore
  readonly publish: Effect.Effect<void>
  readonly idleMillis: number
  /** The scope of the whole service: where the fibers that outlive a request are forked. */
  readonly background: Scope.Scope
}

/** Close one entry if it is still the open one. Runs under the gate. */
const drop = (registry: Registry, personId: PersonId, entry: Open) =>
  Effect.suspend(() => {
    if (registry.open.get(personId) !== entry) return Effect.void
    registry.open.delete(personId)
    // Whatever a settlement already set off is written before the store is closed under it.
    return entry.person.quiet.pipe(
      Effect.andThen(Scope.close(entry.scope, Exit.void)),
      Effect.andThen(registry.publish),
    )
  })

/** Once a settlement's follow-up writes are done: no task is live and no delivery is waiting. */
const idle = Effect.fn('Persons.idle')(function* (entry: Open) {
  yield* entry.person.quiet
  const work = yield* pi(() => entry.person.harness.inspect(BACKGROUND_CONTEXT))
  // A queued write is the runtime's own and waits for nothing (`withdrawWaitingWrites`).
  return work.tasks.length === 0 && work.submissions.every((record) => record.type === 'write')
})

/** After the bound: close if nobody came and nothing is left to do. True when this countdown is over. */
const settle = Effect.fn('Persons.settle')(function* (
  registry: Registry,
  personId: PersonId,
  entry: Open,
) {
  if (registry.open.get(personId) !== entry || entry.uses > 0) return true
  if (!(yield* idle(entry))) return false
  yield* withdrawWaitingWrites(entry.person.harness)
  yield* drop(registry, personId, entry)
  return true
})

/**
 * Close a Person after the idle bound. It starts when the last request for the Person ends and
 * is interrupted by the next one, so the bound always measures time with no request. It first
 * waits for Pi to have no live task (`waitForIdle`, which a reply still being written holds
 * open) and for the settlement writes, then for the bound, then closes if no request holds the
 * Person and the store still has no work. The sleep is Effect's clock, which a test moves.
 */
const rest = (registry: Registry, personId: PersonId, entry: Open): Effect.Effect<void> =>
  Effect.gen(function* () {
    for (;;) {
      yield* Effect.tryPromise({
        try: (signal) =>
          entry.person.harness.waitForIdle(withAbortSignal(signal, BACKGROUND_CONTEXT)),
        catch: (cause) => new PiRejected({ cause }),
      })
      yield* entry.person.quiet
      entry.resting = true
      yield* registry.publish
      yield* Effect.sleep(registry.idleMillis)
      if (yield* registry.gate.withPermit(settle(registry, personId, entry))) return
      entry.resting = false
      yield* registry.publish
    }
  }).pipe(Effect.catchTag('PiRejected', () => Effect.void))

/** Start the countdown for an entry nobody is using. */
const startRest = Effect.fn('Persons.startRest')(function* (
  registry: Registry,
  personId: PersonId,
  entry: Open,
) {
  if (entry.uses > 0 || registry.open.get(personId) !== entry) return
  const counting = yield* Effect.forkIn(rest(registry, personId, entry), registry.background)
  entry.rest = Option.some(counting)
})

/** A request holds the entry: any countdown ends here, even one waiting at the gate to close it. */
const hold = Effect.fn('Persons.hold')(function* (registry: Registry, entry: Open) {
  entry.uses += 1
  if (Option.isSome(entry.rest)) yield* Fiber.interrupt(entry.rest.value)
  entry.rest = Option.none()
  if (!entry.resting) return
  entry.resting = false
  yield* registry.publish
})

/** A Harness that fails closes itself (`harness.closed`); its entry goes with it. */
const failed = (registry: Registry, personId: PersonId, entry: Open) =>
  Effect.promise(() => entry.person.harness.closed).pipe(
    Effect.flatMap((end) =>
      end.reason === 'failed'
        ? registry.gate.withPermit(drop(registry, personId, entry))
        : Effect.void,
    ),
  )

/** Notes resources belong to the process, surviving shorter tool and Person Harness scopes. */
export const runtimeNotesLayer = Layer.unwrap(
  Effect.gen(function* () {
    const settings = yield* RuntimeSettings
    return notesLayer(
      NotesSettings.make({
        directory: settings.notesDirectory,
        capacity: 64,
        idle: Duration.minutes(1),
      }),
    )
  }),
)

/** Own every open Person and recover unfinished work while the process holds storage authority. */
export const personsLayer = Layer.effect(
  Persons,
  Effect.gen(function* () {
    const settings = yield* RuntimeSettings
    const notes = yield* Notes
    const services = Context.mergeAll(
      Context.make(RuntimeSettings, settings),
      Context.make(Notes, notes),
      Context.make(Product, yield* Product),
      Context.make(Models, yield* Models),
      Context.make(BuiltinSkills, yield* BuiltinSkills),
      Context.make(Stores, yield* Stores),
    )
    const open = new Map<PersonId, Open>()
    const listed = yield* SubscriptionRef.make<ReadonlyArray<OpenPerson>>([])
    const registry: Registry = {
      open,
      gate: yield* Semaphore.make(1),
      publish: Effect.suspend(() =>
        SubscriptionRef.set(
          listed,
          Array.from(open, ([personId, entry]) => ({ personId, resting: entry.resting })),
        ),
      ),
      idleMillis: settings.idleMillis,
      background: yield* Effect.scope,
    }

    /** Open a Person in a scope of its own and watch for its failure. Under the gate. */
    const admit = Effect.fn('Persons.admit')(function* (personId: PersonId) {
      const scope = yield* Scope.make()
      const person = yield* openPerson(personId).pipe(
        Scope.provide(scope),
        Effect.provide(services),
        Effect.onExit((exit) =>
          Exit.isFailure(exit) ? Scope.close(scope, Exit.void) : Effect.void,
        ),
      )
      const entry: Open = { person, scope, uses: 0, resting: false, rest: Option.none() }
      open.set(personId, entry)
      yield* registry.publish
      yield* Effect.forkIn(failed(registry, personId, entry), registry.background)
      return entry
    })

    const use: PersonsService['use'] = (personId, body) =>
      Effect.acquireUseRelease(
        registry.gate.withPermit(
          Effect.gen(function* () {
            const existing = open.get(personId)
            const entry = existing === undefined ? yield* admit(personId) : existing
            yield* hold(registry, entry)
            return entry
          }),
        ),
        (entry) => body(entry.person),
        (entry) =>
          Effect.suspend(() => {
            entry.uses -= 1
            return startRest(registry, personId, entry)
          }),
      )

    /** Resume interrupted work without an attached client. Open only stores with pending tasks
     * or submissions, close idle ones, and let one Person's failed store leave others running. */
    const resume = Effect.fn('Persons.resume')(function* (personId: PersonId) {
      const entry = yield* admit(personId)
      if (yield* idle(entry)) {
        yield* withdrawWaitingWrites(entry.person.harness)
        return yield* drop(registry, personId, entry)
      }
      entry.person.harness.resume()
      yield* placeAllWaiting(entry.person.harness)
      return yield* startRest(registry, personId, entry)
    })
    /** Close every open Person: the shutdown of the service, and of a recovery cut short. */
    const closeAll = registry.gate.withPermit(
      Effect.suspend(() =>
        Effect.forEach(Array.from(open), ([personId, entry]) => drop(registry, personId, entry), {
          discard: true,
        }),
      ),
    )
    yield* Effect.forEach(
      yield* (yield* Stores).working,
      (personId) =>
        registry.gate
          .withPermit(resume(personId))
          .pipe(
            Effect.catch((error) =>
              Effect.logError('A Person\u2019s conversations could not be resumed', error._tag),
            ),
          ),
      { discard: true },
    ).pipe(
      // A recovery interrupted (the control connection lost, `lifetime.ts`) or failed closes
      // what it had opened: the service's finalizer below is not registered yet.
      Effect.onError(() => closeAll),
    )

    // Registered last, so it runs before the scope interrupts the fibers above: every Harness is
    // closed, joining its running tasks and its store, before the process lets go of anything else.
    yield* Effect.addFinalizer(() => closeAll)

    return Persons.of({ use, watch: SubscriptionRef.changes(listed) })
  }),
).pipe(Layer.provideMerge(runtimeNotesLayer))
