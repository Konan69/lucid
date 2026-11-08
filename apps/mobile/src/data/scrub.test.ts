import { expect, it } from '@effect/vitest'
import type { Envelope, EventEnvelope, SessionEnvelope } from '@sentry/core'
import { Effect } from 'effect'
import { guarded } from './scrub'

it.effect('keeps causal performance and session health without exporting private payloads', () =>
  Effect.gen(function* () {
    const received: Array<Envelope> = []
    const transport = guarded({
      send: (envelope) => {
        received.push(envelope)
        return Promise.resolve({})
      },
      flush: () => Promise.resolve(true),
    })
    const trace = { trace_id: '123456789012345678901234567890ab', span_id: '1234567890123456' }
    const event: EventEnvelope = [
      { event_id: '123456789012345678901234567890ab', sent_at: '2026-11-08T00:00:00Z' },
      [
        [
          { type: 'transaction' },
          {
            type: 'transaction',
            event_id: '123456789012345678901234567890ab',
            transaction: 'Threads.send',
            start_timestamp: 1,
            timestamp: 2,
            contexts: { trace, private: { text: 'PRIVATE_MARKER' } },
            spans: [
              { ...trace, start_timestamp: 1, timestamp: 2, data: { prompt: 'PRIVATE_MARKER' } },
            ],
            measurements: { app_start_cold: { value: 123, unit: 'millisecond' } },
            extra: { prompt: 'PRIVATE_MARKER' },
          },
        ],
      ],
    ]
    const health: SessionEnvelope = [
      { sent_at: '2026-11-08T00:00:00Z' },
      [
        [
          { type: 'session' },
          {
            sid: '123456789012345678901234567890ab',
            init: true,
            started: '2026-11-08T00:00:00Z',
            timestamp: '2026-11-08T00:00:01Z',
            status: 'ok',
            errors: 0,
            did: 'PRIVATE_MARKER',
            attrs: { release: '0.4.18', ip_address: 'PRIVATE_MARKER' },
          },
        ],
      ],
    ]
    yield* Effect.promise(() => transport.send(event))
    yield* Effect.promise(() => transport.send(health))
    expect(received).toHaveLength(2)
    const wire = JSON.stringify(received)
    expect(wire).toContain('Threads.send')
    expect(wire).toContain('app_start_cold')
    expect(wire).toContain(trace.trace_id)
    expect(wire).toContain('"type":"session"')
    expect(wire).not.toContain('PRIVATE_MARKER')
  }),
)
