import { describe, expect, layer } from '@effect/vitest'
import {
  AddIntegrationOutcome,
  ConnectionStep,
  ToolOutcome,
  TestIntegrationOutcome,
  type ConnectionId,
  ToolCallId,
} from '@vivid/contracts'
import { Effect, Layer, Option, Redacted, Ref, Result } from 'effect'
import { testDatabaseConfigured } from '../database/testdb.ts'
import { ServerConfig } from '../config.ts'
import { ConnectionAddress, ConnectionSource } from './address.ts'
import { ConnectionStore, connectionStoreLayer } from './store.ts'
import { addIntegration, testIntegration } from './integrations.ts'
import { findTools, useTool } from './tools.ts'
import {
  activeReferences,
  connectionTestLayer,
  fixture,
  hostedExecutorFixture,
  hostedPrefix,
  hostedService,
} from './testing.ts'

/** The address Grain published for its MCP server; nothing is fetched from it here. */
const grain = 'https://api.grain.example.test/_/mcp'

/**
 * Production, 26 October 2026: a Person added Grain's MCP server by its address and signed in.
 * Every find_tools call then failed with InvalidRequest ("Authorize this integration before
 * continuing."), every use_tool call was refused with "input: Expected object {accountId, input}",
 * and test_integration said the Integration did not work.
 *
 * This drives the same path through the real Executor adapter against the hosted fixture, which
 * answers as Executor 2.0.0-beta.23 does: an app whose members link their own accounts lists each
 * tool's input inside its account router's `{ accountId, input }` envelope and refuses a call
 * without it, and an account whose link is gone answers NotReady. The store, records and
 * discovery run on the disposable database; only Executor's HTTP is simulated, and the address
 * inspection (DNS and the server's own answer) is the one seam replaced, because it is not what
 * this proves.
 */
describe.skipIf(!testDatabaseConfigured)('An Integration added by address with sign-in', () => {
  layer(connectionTestLayer)((it) => {
    it.effect(
      'lists the provider’s own input, calls it with the bound account, and survives another account losing its sign-in',
      () =>
        Effect.gen(function* () {
          const { personalActor } = yield* fixture()
          const person = { ...personalActor, by: 'person' as const, threadId: Option.none() }
          const config = yield* ServerConfig
          const remote = yield* hostedExecutorFixture()
          yield* Ref.set(
            remote.redirectUri,
            new URL('/api/connections/return', config.PUBLIC_URL).href,
          )
          yield* Ref.set(remote.accounts, {
            slot: { provider: 'provider', definition: { auth: { oauth: { type: 'oauth2' } } } },
          })
          const executor = yield* Layer.build(remote.configured)
          const store = yield* Layer.build(Layer.fresh(connectionStoreLayer)).pipe(
            Effect.provide(executor),
          )
          yield* Effect.gen(function* () {
            /** Finish a sign-in the way the provider's return does, for the Person who began it. */
            const signIn = Effect.fn('Connections.ImportedTest.signIn')(function* (
              id: ConnectionId,
              address: string,
            ) {
              const state = new URL(address).searchParams.get('state')
              const callback = new URL(
                `/api/connections/return?state=${state}&code=private-code`,
                config.PUBLIC_URL,
              )
              yield* (yield* ConnectionStore).callback(person, id, Redacted.make(callback.href))
            })

            // Another Integration the Person already had, signed in through the catalogue.
            const other = yield* (yield* ConnectionStore).begin(person, {
              from: 'Web',
              service: hostedService,
              name: 'Records',
              shared: false,
            })
            if (!ConnectionStep.guards.OpenSignIn(other)) expect.fail('Expected sign-in')
            yield* signIn(other.connection.id, other.address)

            // Grain, added by its address. Each sign-in carries its own state.
            yield* Ref.update(remote.replies, (replies) =>
              new Map(replies).set(`POST ${hostedPrefix}/connections/authorization/oauth/start`, {
                status: 200,
                body: {
                  status: 'redirect',
                  authorizationUrl:
                    'https://provider.example.test/sign-in?state=hosted-fixture-oauth-state-00000001',
                  redirectUri: new URL('/api/connections/return', config.PUBLIC_URL).href,
                  expiresAt: '2026-10-04T00:00:00Z',
                },
              }),
            )
            const added = yield* addIntegration(personalActor, {
              address: grain,
              name: 'Grain',
              shared: false,
            }).pipe(
              Effect.provideService(
                ConnectionAddress,
                ConnectionAddress.of({
                  inspect: (address) =>
                    Effect.succeed(
                      ConnectionSource.cases.Mcp.make({ address, authorization: 'auto' }),
                    ),
                }),
              ),
            )
            if (!AddIntegrationOutcome.guards.NeedsSignIn(added))
              expect.fail(`Expected a sign-in card, got ${added._tag}`)
            yield* signIn(added.step.connection.id, added.step.address)
            yield* Ref.set(remote.replies, new Map())

            // The other account's link disappears in Executor (removed or replaced there).
            const otherRow = yield* (yield* ConnectionStore).get(person, other.connection.id)
            yield* Ref.update(remote.selections, (selections) =>
              new Map(selections).set(activeReferences(otherRow.references).app, { slot: [] }),
            )

            // Before: InvalidRequest "Authorize this integration before continuing." for every query.
            const discovery = yield* findTools(personalActor, {
              query: 'read records',
              limit: 25,
            }).pipe(Effect.result)
            if (Result.isFailure(discovery))
              expect.fail(`find_tools failed: ${discovery.failure._tag}`)
            const found = discovery.success
            const read = found.tools.find(
              (tool) => tool.account === 'Grain' && tool.name === 'read',
            )
            if (read === undefined) expect.fail('Grain’s read tool was not listed')
            // The model sees the provider's input; the account is Vivid's to choose.
            expect(read.signature).not.toContain('accountId')
            expect(found.tools.every((tool) => tool.account === 'Grain')).toBe(true)
            // The account that lost its link is saved as needing sign-in, which every surface shows.
            expect((yield* (yield* ConnectionStore).get(person, other.connection.id)).status).toBe(
              'needs-authorization',
            )

            const before = (yield* Ref.get(remote.requests)).length
            const outcome = yield* useTool(personalActor, {
              toolCallId: ToolCallId.make(crypto.randomUUID()),
              connectionId: added.step.connection.id,
              tool: 'read',
              input: {},
              summary: 'List my recent meetings',
              rationale: 'Answer the question',
            })
            expect(outcome._tag).toBe('Completed')
            const calls = (yield* Ref.get(remote.requests))
              .slice(before)
              .filter((request) => request.path.endsWith('/tools/call'))
            expect(calls.map((request) => request.body)).toEqual([
              expect.objectContaining({ tool: 'read', input: { accountId: 'account', input: {} } }),
            ])

            const otherOutcome = yield* useTool(personalActor, {
              toolCallId: ToolCallId.make(crypto.randomUUID()),
              connectionId: other.connection.id,
              tool: 'read',
              input: {},
              summary: 'Read the records',
              rationale: 'Answer the question',
            })
            expect(ToolOutcome.guards.ConnectionNotReady(otherOutcome)).toBe(true)

            const tested = yield* testIntegration(personalActor, { account: 'Grain' })
            expect(TestIntegrationOutcome.guards.Tested(tested)).toBe(true)
          }).pipe(Effect.provide(store), Effect.provide(executor))
        }).pipe(Effect.scoped),
    )
  })
})
