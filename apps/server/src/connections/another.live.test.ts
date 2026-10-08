import { describe, expect, layer } from '@effect/vitest'
import {
  AnotherAccountMessage,
  ConnectionState,
  ConnectionStep,
  ServiceCatalog,
} from '@vivid/contracts'
import { Effect, Option, Schema } from 'effect'
import { chainFixture, chainLayer, completeRun, toolParts } from '../runtime/chains.ts'

const decodeAnother = Schema.decodeUnknownOption(AnotherAccountMessage)
const UsedAccount = Schema.Struct({ account: Schema.String })
const decodeUsed = Schema.decodeUnknownOption(UsedAccount)

/**
 * Behavioural claim: when a Person asks for an account that is not among theirs on a service
 * they have already connected, Vivid does not use the account that is there in its place. It
 * asks for one more account with the connect card, waits, and once that account is connected it
 * acts through it.
 *
 * Real server, runtime, model and Executor. The service is one from Executor's catalogue that
 * needs no sign-in, so both accounts are begun exactly as the card and Settings begin them. One
 * model attempt per ask, no judge, no retry.
 */
describe.skipIf(process.env['VIVID_LIVE_ANOTHER_ACCOUNT'] !== '1')(
  'another account live chain',
  () => {
    layer(chainLayer, { excludeTestServices: true, timeout: 180_000 })((it) => {
      it.effect(
        'asks for one more account instead of using the wrong one, then uses the new one',
        () =>
          Effect.gen(function* () {
            const fixture = yield* chainFixture('Another account proof')
            const found = yield* fixture.rpc.FindServices({ query: 'DeepWiki' })
            if (!ServiceCatalog.guards.Ready(found))
              return yield* Effect.sync(() => expect.fail('Executor catalog must be available'))
            const wiki = found.services.find((service) => /deepwiki/i.test(service.name))
            if (wiki === undefined)
              return yield* Effect.sync(() => expect.fail('The catalogue must list DeepWiki'))
            yield* Effect.addFinalizer(() =>
              Effect.gen(function* () {
                const current = yield* fixture.rpc.ListConnections()
                for (const connection of current.connections)
                  yield* fixture.rpc.RemoveConnection({ id: connection.id })
              }).pipe(
                Effect.catch(() =>
                  Effect.sync(() => expect.fail('Proof Integration cleanup failed')),
                ),
              ),
            )
            const work = yield* fixture.rpc.BeginConnection({
              from: 'Web',
              service: wiki.id,
              name: 'Work',
              shared: false,
            })
            if (!ConnectionStep.guards.Done(work))
              return yield* Effect.sync(() =>
                expect.fail('DeepWiki must connect without a sign-in'),
              )
            const workAccount = work.connection.account

            const asked = yield* fixture.send(
              `Read the wiki structure of the GitHub repository facebook/react with ${wiki.name}, through my personal ${wiki.name} account, not my work one. If my personal account is not connected, ask me to connect it and wait.`,
            )
            const waiting = yield* completeRun(fixture, asked)
            const [another] = toolParts(waiting).flatMap((part) =>
              part.toolName === 'connect' && part.state === 'output-available'
                ? Option.toArray(decodeAnother(part.output))
                : [],
            )
            if (another === undefined)
              return yield* Effect.sync(() =>
                expect.fail('Vivid must ask for one more account with the connect card'),
              )
            expect(another.service).toBe(wiki.id)
            expect(another.ready).toBe(false)
            // It did not act through the work account in place of the one that was asked for.
            const through = (state: typeof waiting) =>
              toolParts(state).flatMap((part) =>
                part.toolName === 'use_tool'
                  ? Option.toArray(decodeUsed(part.input)).map((used) => used.account)
                  : [],
              )
            expect(through(waiting)).not.toContain(workAccount)

            // The Person presses the card: one more account, begun after Vivid asked.
            const personal = yield* fixture.rpc.BeginConnection({
              from: 'Web',
              service: wiki.id,
              name: 'Personal',
              shared: false,
            })
            expect(ConnectionState.guards.Ready(personal.connection.state)).toBe(true)
            expect(personal.connection.createdAt).toBeGreaterThan(another.another.askedAt)
            // The account that was already there is not the one the card was waiting for.
            expect(work.connection.createdAt).toBeLessThanOrEqual(another.another.askedAt)

            // What the card sends once it is settled: it names the account that was added.
            const carried = yield* fixture.send(
              `Another ${wiki.name} account is connected: ${personal.connection.account}. Carry on.`,
            )
            const done = yield* completeRun(fixture, carried)
            expect(through(done)).toContain(personal.connection.account)
            expect(through(done)).not.toContain(workAccount)
            return yield* Effect.void
          }).pipe(Effect.scoped),
        { timeout: 180_000 },
      )
    })
  },
)
