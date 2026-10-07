import { describe, expect, layer } from '@effect/vitest'
import {
  AnotherAccountMessage,
  ConnectionState,
  ConnectionStep,
  ServiceCatalog,
} from '@vivid/contracts'
import { Effect, Option, Schema } from 'effect'
import { chainFixture, chainLayer, completeRun, replyText, toolParts } from '../runtime/chains.ts'

const decodeAnother = Schema.decodeUnknownOption(AnotherAccountMessage)

/**
 * Behavioural claim: when a Person tells Vivid to connect another account on a service they have
 * already connected, Vivid starts it at once with the connect card for one more account. It does
 * not answer that the service is connected already, send them to settings, or ask which account
 * first. Once the Person has connected it, Vivid says so by the new account's name.
 *
 * Real server, runtime, model and Executor. The service is one from Executor's catalogue that
 * needs no sign-in, so the second account is begun exactly as the card begins it. One model
 * attempt per ask, no judge, no retry.
 */
describe.skipIf(process.env['VIVID_LIVE_TOLD_ACCOUNT'] !== '1')(
  'told to connect another account live chain',
  () => {
    layer(chainLayer, { excludeTestServices: true, timeout: 180_000 })((it) => {
      it.effect(
        'offers the card for one more account when told to connect another',
        () =>
          Effect.gen(function* () {
            const fixture = yield* chainFixture('Told to connect another account proof')
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
            const first = yield* fixture.rpc.BeginConnection({
              service: wiki.id,
              name: 'Personal',
              shared: false,
            })
            if (!ConnectionStep.guards.Done(first))
              return yield* Effect.sync(() =>
                expect.fail('DeepWiki must connect without a sign-in'),
              )

            const told = yield* fixture.send(`Connect another ${wiki.name} account for me.`)
            const waiting = yield* completeRun(fixture, told)
            const [card] = toolParts(waiting).flatMap((part) =>
              part.toolName === 'connect' && part.state === 'output-available'
                ? Option.toArray(decodeAnother(part.output))
                : [],
            )
            if (card === undefined)
              return yield* Effect.sync(() =>
                expect.fail('Vivid must start one more account with the connect card when told to'),
              )
            expect(card.service).toBe(wiki.id)
            expect(card.ready).toBe(false)
            // The account that is already there does not settle the card.
            expect(first.connection.createdAt).toBeLessThanOrEqual(card.another.askedAt)

            // The Person presses the card: one more account, begun after Vivid asked.
            const second = yield* fixture.rpc.BeginConnection({
              service: wiki.id,
              name: 'Work',
              shared: false,
            })
            expect(ConnectionState.guards.Ready(second.connection.state)).toBe(true)
            expect(second.connection.createdAt).toBeGreaterThan(card.another.askedAt)

            // What the card sends once it is settled: it names the account that was added.
            const carried = yield* fixture.send(
              `Another ${wiki.name} account is connected: ${second.connection.account}. Carry on.`,
            )
            const done = yield* completeRun(fixture, carried)
            // Vivid says which account is new, and does not call the old one the new one.
            const reply = replyText(done)
            expect(reply).toContain('Work')
            expect(reply).not.toMatch(/new[^.]*\(Personal\)/iu)
            const listed = yield* fixture.rpc.ListConnections()
            expect(listed.connections.map((item) => item.account).toSorted()).toEqual([
              `${wiki.name} (Personal)`,
              `${wiki.name} (Work)`,
            ])
            return yield* Effect.void
          }).pipe(Effect.scoped),
        { timeout: 180_000 },
      )
    })
  },
)
