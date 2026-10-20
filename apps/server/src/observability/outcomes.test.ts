import { expect, it } from '@effect/vitest'
import { Cause, Context, Effect, Exit, Layer, Option, Redacted, Ref } from 'effect'
import * as HttpClient from 'effect/http/HttpClient'
import * as HttpClientResponse from 'effect/http/HttpClientResponse'
import * as OtlpExporter from 'effect/observability/OtlpExporter'
import { ObservabilityConfiguration } from '../config.ts'
import { observabilityLayer } from './export.ts'

/**
 * A finalizer can add an exporter defect to an existing multi-reason failure. Compare identities
 * without inspecting the hostile Error, then flush a healthy neighbour to prove export ran.
 * Only the HTTP destination is replaced. The production tracer, guard and serializer all run.
 */
it.effect('preserves every reason and interruption when a failed span cannot be inspected', () =>
  Effect.gen(function* () {
    let reads = 0
    const hostile = new Error('inert private fixture')
    const defect = new Error('another inert fixture')
    const cause = Cause.combine(
      Cause.combine(Cause.fail(hostile), Cause.die(defect)),
      Cause.interrupt(77),
    )
    // Cause.combine hashes reasons while constructing them. Install the hostile accessor after
    // construction so the test isolates the exporter rather than Effect's cause deduplication.
    Object.defineProperty(hostile, 'name', {
      get: () => {
        reads += 1
        throw new Error('Failure objects must not be inspected for export')
      },
    })
    const requests = yield* Ref.make<ReadonlyArray<string>>([])
    const http = HttpClient.make((request) =>
      Ref.update(requests, (seen) => [...seen, request.url]).pipe(
        Effect.as(HttpClientResponse.fromWeb(request, new Response('{}'))),
      ),
    )
    yield* Effect.scoped(
      Effect.gen(function* () {
        const installed = yield* Layer.build(
          observabilityLayer(
            ObservabilityConfiguration.Enabled({
              url: new URL('https://telemetry.example.invalid'),
              headers: Redacted.make({}),
              environment: Option.none(),
              commit: Option.none(),
            }),
          ).pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, http))),
        )
        const exit = yield* Effect.exit(
          Effect.failCause(cause).pipe(Effect.withSpan('Probe.combined')),
        ).pipe(Effect.provide(installed))
        const reasons = Exit.isFailure(exit) ? exit.cause.reasons : []
        expect(reasons.map((reason) => reason._tag)).toEqual(['Fail', 'Die', 'Interrupt'])
        expect(
          reasons.some((reason) => Cause.isFailReason(reason) && Object.is(reason.error, hostile)),
        ).toBe(true)
        expect(
          reasons.some((reason) => Cause.isDieReason(reason) && Object.is(reason.defect, defect)),
        ).toBe(true)
        expect(
          reasons.some((reason) => Cause.isInterruptReason(reason) && reason.fiberId === 77),
        ).toBe(true)
        expect(reads).toBe(0)
        yield* Effect.succeed('next request').pipe(
          Effect.withSpan('Probe.healthy'),
          Effect.provide(installed),
        )
        yield* Context.get(installed, OtlpExporter.Flusher).flush
        expect(yield* Ref.get(requests)).toContain('https://telemetry.example.invalid/v1/traces')
      }),
    )
  }),
)
