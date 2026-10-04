import { expect, it } from '@effect/vitest'
import { Cause, Effect, Exit, Predicate, Schema, Tracer } from 'effect'
import { guardedTracer } from './guard.ts'

/** The instance type of the classes `declared` makes. */
interface Declared {
  readonly note: string
}

/**
 * A failure of a class declared with `Schema.TaggedError` under a tag that is given, not written:
 * what a dependency building error classes from text it was handed would do.
 */
const declared = (tag: string): Declared =>
  new (Schema.TaggedError<Declared>()(tag, { note: Schema.String }))({ note: 'probe' })

/**
 * The guard in front of Effect's own in-memory span (`Tracer.NativeSpan`), which keeps the exit
 * it is ended with, so a test can read what the guard handed the tracer behind it. The OTLP
 * tracer does not keep it: it renders the cause and exports only what the allowlist lets through.
 */
const guarded = () => {
  const inner: Array<Tracer.NativeSpan> = []
  const tracer = guardedTracer(
    Tracer.make({
      span: (options) => {
        const span = new Tracer.NativeSpan(options)
        inner.push(span)
        return span
      },
    }),
    new Set(),
  )
  return { inner, tracer }
}

/** The `name` of every failure the inner span was ended with, in the cause's order. */
const namesOf = ({ status }: Tracer.NativeSpan): ReadonlyArray<unknown> =>
  Predicate.isTagged(status, 'Ended') && Exit.isFailure(status.exit)
    ? status.exit.cause.reasons.flatMap((reason) =>
        Cause.isFailReason(reason) && Predicate.hasProperty(reason.error, 'name')
          ? [reason.error.name]
          : [],
      )
    : []

it.effect('names a failure _OTHER to the tracer when its type is not a code name', () =>
  Effect.gen(function* () {
    const { inner, tracer } = guarded()
    // A megabyte of identifier characters, text with characters no identifier has, and a name.
    const failures = ['x'.repeat(1024 * 1024), 'Not a name; DROP TABLE threads', 'ProbeFailed'].map(
      declared,
    )
    const raise = Effect.fn('Probe.named')(function* (failure: Declared) {
      return yield* Effect.fail(failure)
    })
    const exits = yield* Effect.forEach(failures, (failure) =>
      Effect.exit(raise(failure)).pipe(Effect.withTracer(tracer)),
    )

    // The caller is handed the failure it raised, alone: one reason, the same object.
    expect(
      exits.map((exit, index) => {
        const reasons = Exit.isFailure(exit) ? exit.cause.reasons : []
        const [reason] = reasons
        return [
          reasons.length,
          reason !== undefined &&
            Cause.isFailReason(reason) &&
            Object.is(reason.error, failures[index]),
        ]
      }),
    ).toEqual(failures.map(() => [1, true]))
    // Every span ended, and only the code name reached the tracer behind the guard.
    expect(inner.map((span) => span.status._tag)).toEqual(['Ended', 'Ended', 'Ended'])
    expect(inner.map(namesOf)).toEqual([['_OTHER'], ['_OTHER'], ['ProbeFailed']])
  }),
)
