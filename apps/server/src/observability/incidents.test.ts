import { expect, it } from '@effect/vitest'
import { CodeName, Forbidden, Incident, PersonId, RunId, ThreadId } from '@vivid/contracts'
import { Effect, Layer, Schema } from 'effect'
import { observeFailures } from './failure.ts'
import { Incidents } from './incidents.ts'
import { Message } from './messages.ts'
import { decisionLogs } from './testlogger.ts'
import { ingest } from './tests/ingest.ts'

/** A send the cell refused for a field that did not decode, with ids of their generators' shapes. */
const refusedSend = Incident.cases.AdmissionFailed.make({
  personId: PersonId.make('a'.repeat(16) + 'B'.repeat(16)),
  threadId: ThreadId.make('5f0c7b1e-8d2a-4c3b-9e4f-0a1b2c3d4e5f'),
  runId: RunId.make(`run_${'c'.repeat(64)}`),
  delivery: 'Words',
  cause: [
    {
      service: 'server',
      operation: CodeName.make('Runtime.admit'),
      tag: CodeName.make('AdmissionRefused'),
      status: 400,
    },
    {
      service: 'cell',
      operation: CodeName.make('Cell.admit'),
      tag: CodeName.make('SchemaError'),
      status: 400,
      issues: [{ path: [CodeName.make('delivery')], kind: 'MissingKey' }],
    },
  ],
})

/** A typed failure no Person can correct: an Incident by impact, though the code declared it. */
class ProbeLost extends Schema.TaggedError<ProbeLost>()(
  'ProbeLost',
  { message: Schema.String },
  { title: 'Probe lost' },
) {}

it.live('says an Incident as one error issue with its fingerprint, closed tags and trace', () =>
  Effect.gen(function* () {
    const { context, events } = yield* ingest()
    const logs = decisionLogs()
    const decide = Effect.fn('Probe.decide')(function* () {
      const incidents = yield* Incidents
      yield* incidents.record(refusedSend)
      return yield* Effect.currentSpan
    })
    const logged = yield* Layer.build(logs.layer)
    const span = yield* decide().pipe(Effect.provide(context), Effect.provide(logged))

    const sent = yield* events
    expect(sent).toHaveLength(1)
    const [event] = sent
    if (event === undefined) return yield* Effect.die('No event was sent')
    expect(event.level).toBe('error')
    expect(event.message).toBe('AdmissionFailed')
    expect(event.fingerprint).toEqual([
      'AdmissionFailed',
      'server.AdmissionRefused',
      'cell.SchemaError',
    ])
    expect(event.tags).toEqual({
      'vivid.incident.kind': 'AdmissionFailed',
      'vivid.incident.personId': refusedSend.personId,
      'vivid.incident.threadId': refusedSend.threadId,
      'vivid.incident.runId': refusedSend.runId,
      'vivid.incident.delivery': 'Words',
      'vivid.incident.cause.0.service': 'server',
      'vivid.incident.cause.0.operation': 'Runtime.admit',
      'vivid.incident.cause.0.tag': 'AdmissionRefused',
      'vivid.incident.cause.0.status': '400',
      'vivid.incident.cause.1.service': 'cell',
      'vivid.incident.cause.1.operation': 'Cell.admit',
      'vivid.incident.cause.1.tag': 'SchemaError',
      'vivid.incident.cause.1.status': '400',
      'vivid.incident.cause.1.issues': 'delivery:MissingKey',
    })
    expect(event.contexts.trace).toEqual({ trace_id: span.traceId, span_id: span.spanId })
    const said = logs.recorded().filter((line) => line.includes(Message.incident))
    expect(said).toHaveLength(1)
    expect(said[0]).toContain('level=ERROR')
  }).pipe(Effect.scoped),
)

it.live('opens an issue for a typed failure by its impact, and none for a routine refusal', () =>
  Effect.gen(function* () {
    const { context, events } = yield* ingest()
    const logs = decisionLogs()
    const lost = Effect.fn('Probe.lost')(function* () {
      return yield* new ProbeLost({ message: 'PRIVATE_MARKER' })
    }, observeFailures('rpc'))
    const refused = Effect.fn('Probe.refused')(function* () {
      return yield* new Forbidden({ message: 'normal refusal' })
    }, observeFailures('rpc'))
    const logged = yield* Layer.build(logs.layer)
    yield* Effect.andThen(Effect.ignore(lost()), Effect.ignore(refused())).pipe(
      Effect.provide(context),
      Effect.provide(logged),
    )

    const sent = yield* events
    expect(
      sent.map((event) => [
        event.level,
        event.tags === undefined ? undefined : event.tags['vivid.operation'],
      ]),
    ).toEqual([['error', 'Probe.lost']])
    const lines = logs.recorded().filter((line) => line.includes(Message.failure))
    expect(lines.filter((line) => line.includes('ProbeLost'))).toEqual([
      expect.stringContaining('level=ERROR'),
    ])
    expect(lines.filter((line) => line.includes('Forbidden'))).toEqual([
      expect.stringContaining('level=INFO'),
    ])
  }).pipe(Effect.scoped),
)
