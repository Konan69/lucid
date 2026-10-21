import { expect, it } from '@effect/vitest'
import { Cause, Effect, Exit } from 'effect'
import * as fc from 'fast-check'
import { checkSequences } from '../../tests/property.ts'

/** A failing real assertion must return a shrunk witness, rather than wait until Vitest interrupts. */
it.effect('reports a shrunk failure through the owning Effect test fiber', () =>
  Effect.gen(function* () {
    const seen: ReadonlyArray<number>[] = []
    const outcome = yield* Effect.exit(
      checkSequences(
        fc.array(fc.nat(), { minLength: 1, maxLength: 4 }),
        (values) =>
          Effect.sync(() => {
            seen.push(values)
            expect(values).toHaveLength(0)
          }),
        { seed: 31913, numRuns: 1 },
      ),
    )
    expect(Exit.isFailure(outcome)).toBe(true)
    if (Exit.isFailure(outcome))
      expect(Cause.pretty(outcome.cause)).toContain('Counterexample: [[0]]')
    expect(seen.length).toBeGreaterThan(1)
  }),
)
