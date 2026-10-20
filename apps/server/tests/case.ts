import { Clock, Effect, Layer } from 'effect'
import * as TestClock from 'effect/testing/TestClock'

/**
 * Shared `layer(...)` fixtures own suite services and clocks in @effect/vitest 4.0.2.
 * Acquire mutable ports and workers in the case scope, after installing the case's clock,
 * so service acquisition, assertions and finalizers all see the same time. A suite's `layer(...)`
 * should hold only immutable shared authority, such as PostgreSQL. Use the inherited clock for
 * real SSH, production auth that needs real time, or nested acquisitions on the enclosing
 * case's timeline. Standalone `it.effect` already owns a clock.
 */
export function scopedCase<Services, LayerError, Dependencies, A, E, R>(
  caseLayer: Layer.Layer<Services, LayerError, Dependencies>,
  program: Effect.Effect<A, E, R>,
  clock: 'fresh' | 'inherited',
) {
  const acquired = Layer.build(caseLayer).pipe(
    Effect.flatMap((context) => program.pipe(Effect.provide(context))),
    Effect.scoped,
  )
  if (clock === 'inherited') return acquired
  return acquired.pipe(Effect.provideServiceEffect(Clock.Clock, TestClock.make()))
}
