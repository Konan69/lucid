import { describe, expect, layer } from '@effect/vitest'
import { ConnectionState, ServiceCatalog, ServiceAuthorization, RunState } from '@vivid/contracts'
import { Effect, Option, Schema, Stream } from 'effect'
import { chainFixture, chainLayer, completeRun, replyText, toolParts } from '../runtime/chains.ts'

const Offer = Schema.Struct({
  kind: Schema.Literal('connection-request'),
  service: Schema.String,
  serviceName: Schema.String,
  ready: Schema.Literal(false),
})

const decodeOffer = Schema.decodeUnknownEffect(Offer)

const decodeToolResult = Schema.decodeUnknownEffect(
  Schema.Struct({ ok: Schema.Literal(true), output: Schema.Json }),
)

/** A real mail request must end in the secure card, then continue only after the Person connects.
 * Missing Google operator setup fails before spending a model call: that is a blocked proof,
 * never a skipped or falsely passing mail path. OAuth consent itself remains Person-controlled.
 */
describe.skipIf(process.env['VIVID_LIVE_THREAD_CONNECTION'] !== '1')(
  'Thread not-connected live chain',
  () => {
    layer(chainLayer, { excludeTestServices: true, timeout: 240_000 })((it) => {
      it.effect(
        'offers mail promptly, settles cleanly and resumes after connection completes',
        () =>
          Effect.gen(function* () {
            const fixture = yield* chainFixture('Unconnected mail proof')
            const services = yield* fixture.rpc.FindServices({ query: 'Gmail' })
            if (!ServiceCatalog.guards.Ready(services))
              return yield* Effect.sync(() => expect.fail('Executor catalog must be available'))
            const mail = services.services.find((service) => /gmail/i.test(service.name))
            if (mail === undefined)
              return yield* Effect.sync(() =>
                expect.fail('Executor must expose the Gmail integration'),
              )
            expect(
              ServiceAuthorization.guards.SetupRequired(mail.authorization),
              'Configure Google sign-in in Executor before this live proof',
            ).toBe(false)
            expect((yield* fixture.rpc.ListConnections()).connections).toEqual([])
            const runId = yield* fixture.send(
              'Check my latest mail in Gmail. If I have not connected Gmail, offer its secure connect card and wait for me.',
            )
            const state = yield* completeRun(fixture, runId)
            const offered = toolParts(state).find(
              (part) => part.toolName === 'connect' && part.state === 'output-available',
            )
            if (offered === undefined || offered.state !== 'output-available')
              return yield* Effect.sync(() =>
                expect.fail('A mail request must return its connect offer'),
              )
            const offer = yield* decodeOffer(offered.output)
            expect(offer.serviceName).toMatch(/gmail/i)
            const detail = yield* fixture.rpc.GetThread({ id: fixture.threadId })
            expect(
              detail.runs.some((run) => run.id === runId && RunState.guards.Completed(run.state)),
            ).toBe(true)
            yield* Effect.addFinalizer(() =>
              Effect.gen(function* () {
                const current = yield* fixture.rpc.ListConnections()
                for (const connection of current.connections)
                  yield* fixture.rpc.RemoveConnection({ id: connection.id })
              }).pipe(
                Effect.catch(() =>
                  Effect.sync(() => expect.fail('Mail proof connection cleanup failed')),
                ),
              ),
            )
            yield* fixture.rpc.BeginConnection({
              from: 'Web',
              service: mail.id,
              name: null,
              shared: false,
            })
            // This proof cannot supply a Google authorization on behalf of the Person. The existing
            // card listens to WatchConnections; an operator-supplied authenticated test account is needed.
            const connected = yield* fixture.rpc.WatchConnections().pipe(
              Stream.filter((value) =>
                value.connections.some(
                  (item) => item.service === mail.id && ConnectionState.guards.Ready(item.state),
                ),
              ),
              Stream.runHead,
            )
            expect(
              Option.isSome(connected),
              'Google sign-in must complete before the card can carry on',
            ).toBe(true)
            const subject = process.env['VIVID_TEST_MAIL_SUBJECT']
            if (subject === undefined || subject.trim().length === 0)
              expect.fail('Supply a known recent message subject in the consented test mailbox')
            const resumedId = yield* fixture.send(
              `${mail.name} is connected. Check the latest messages with use_tool directly, including the message with subject ${JSON.stringify(subject)}. Do not use a program.`,
            )
            const resumed = yield* completeRun(fixture, resumedId)
            const reads = toolParts(resumed).filter(
              (part) => part.toolName === 'use_tool' && part.state === 'output-available',
            )
            const received = yield* Effect.forEach(reads, (part) =>
              part.state === 'output-available'
                ? decodeToolResult(part.output).pipe(Effect.option)
                : Effect.succeedNone,
            )
            expect(
              received
                .flatMap(Option.toArray)
                .some((read) => JSON.stringify(read.output).includes(subject)),
              'A completed provider read must contain the known mailbox subject',
            ).toBe(true)
            expect(replyText(resumed).trim().length).toBeGreaterThan(0)
            const finished = yield* fixture.rpc.GetThread({ id: fixture.threadId })
            expect(
              finished.runs.some(
                (run) => run.id === resumedId && RunState.guards.Completed(run.state),
              ),
            ).toBe(true)
          }).pipe(Effect.scoped),
        { timeout: 240_000 },
      )
    })
  },
)
