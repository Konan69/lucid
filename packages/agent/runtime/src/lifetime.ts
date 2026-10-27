import { Effect, Fiber, Layer } from 'effect'
import { Stores } from './storage/stores.ts'

/**
 * Build and serve everything that depends on the stores for as long as this process owns them.
 *
 * Losing the control connection (`Stores.lost`) wins the race at any moment: while startup is
 * still recovering stores as much as while requests are served. The loser is interrupted, so a
 * recovery blocked on the database stops at once, and the failure closes the enclosing scope:
 * the HTTP server stops taking requests, every Harness closes, and the stores go last. The
 * process then exits non-zero (`main.ts`) and the platform starts a fresh one; it does not
 * reconnect in place, because its Harnesses hold state a successor may already have moved past.
 * Build failures of the serving side end it the same way. It never succeeds.
 */
export const whileOwned = <A, E, R>(serving: Layer.Layer<A, E, R>) =>
  Effect.gen(function* () {
    const stores = yield* Stores
    // Built in a fiber of the enclosing scope, and joined: the race below interrupts only the
    // join when the loss wins, so the loss is reported at once even while the build sits in a
    // step that cannot be interrupted (an acquisition waiting on the database). Closing the
    // scope then interrupts the build and waits for it, as it waits for every Harness.
    const building = yield* Effect.forkScoped(
      Layer.build(serving).pipe(Effect.andThen(Effect.never)),
    )
    return yield* Effect.raceFirst(stores.lost, Fiber.join(building))
  })
