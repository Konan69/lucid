import { describe, expect, layer } from '@effect/vitest'
import { AuthContext, AuthState } from '@vivid/contracts/auth'
import {
  AddIntegrationOutcome,
  ConnectionMatch,
  ConnectionStep,
  Forbidden,
  SessionId,
} from '@vivid/contracts'
import { Effect, Redacted, Ref } from 'effect'
import { eq } from 'drizzle-orm'
import * as TestClock from 'effect/testing/TestClock'
import { connectionHandlers } from './handlers.ts'
import { ConnectionStore, connectionStoreLayer } from './store.ts'
import { ConnectionAddress, ConnectionSource, ConnectionAddressUnreachable } from './address.ts'
import { Executor, ExecutorPublicAddressRequired, ExecutorTool } from './executor.ts'
import { ConnectionProbe, connectionTestLayer, fixture, serviceId } from './testing.ts'
import { testDatabaseConfigured } from '../database/testdb.ts'
import { auditLayer } from '../audit/record.ts'
import { auditEntries } from '../audit/tables.ts'
import { Database } from '../database/client.ts'

/** Handler calls retain transport authentication, real store scope and real disposable SQL. */
describe.skipIf(!testDatabaseConfigured)('integration public handlers', () => {
  layer(connectionTestLayer)((it) => {
    it.effect(
      "reuses the Person's ready service or imported address before probing or importing",
      () =>
        Effect.gen(function* () {
          const { ownerActor, personalActor, memberActor, threadId } = yield* fixture()
          const store = yield* ConnectionStore
          const probe = yield* ConnectionProbe
          const auth = AuthState.Vivid({
            person: personalActor.person,
            workspace: personalActor.workspace,
            threadId,
          })
          yield* store.begin(memberActor, {
            service: serviceId,
            label: 'Someone else',
            shared: false,
          })
          yield* store.begin(ownerActor, { service: serviceId, label: 'My account', shared: false })
          const before = yield* Ref.get(probe.begins)
          const byService = yield* connectionHandlers
            .AddIntegration({
              address: 'https://records.example/mcp',
              name: ' records ',
              shared: false,
            })
            .pipe(Effect.provideService(AuthContext, auth))
          expect(byService).toEqual(
            AddIntegrationOutcome.cases.AlreadyConnected.make({ account: 'My account' }),
          )
          expect(yield* Ref.get(probe.begins)).toBe(before)
          yield* store.add(
            ownerActor,
            { address: 'https://imported.example/mcp', name: 'Imported', shared: false },
            ConnectionSource.cases.Mcp.make({
              address: 'https://imported.example/mcp',
              authorization: 'auto',
            }),
          )
          const importedCount = yield* Ref.get(probe.begins)
          const byAddress = yield* connectionHandlers
            .AddIntegration({
              address: 'https://IMPORTED.example/mcp',
              name: 'Different label',
              shared: false,
            })
            .pipe(Effect.provideService(AuthContext, auth))
          expect(byAddress).toEqual(
            AddIntegrationOutcome.cases.AlreadyConnected.make({ account: 'Imported' }),
          )
          expect(yield* Ref.get(probe.begins)).toBe(importedCount)
          expect(yield* store.records(ownerActor)).toHaveLength(2)
        }).pipe(
          Effect.provideService(
            ConnectionAddress,
            ConnectionAddress.of({
              inspect: Effect.fn('Test.noProbe')(() =>
                Effect.fail(new ConnectionAddressUnreachable({})),
              ),
            }),
          ),
        ),
    )

    it.effect('does not reuse an account still waiting for authorization', () =>
      Effect.gen(function* () {
        const { ownerActor, personalActor, threadId } = yield* fixture()
        const probe = yield* ConnectionProbe
        const previousStep = yield* Ref.get(probe.step)
        yield* Effect.addFinalizer(() => Ref.set(probe.step, previousStep))
        yield* Ref.set(probe.step, 'OpenSignIn')
        yield* (yield* ConnectionStore).begin(ownerActor, {
          service: serviceId,
          label: 'Pending',
          shared: false,
        })
        const result = yield* connectionHandlers
          .AddIntegration({
            address: 'https://records.example/mcp',
            name: 'Records',
            shared: false,
          })
          .pipe(
            Effect.provideService(
              AuthContext,
              AuthState.Vivid({
                person: personalActor.person,
                workspace: personalActor.workspace,
                threadId,
              }),
            ),
            Effect.provideService(
              ConnectionAddress,
              ConnectionAddress.of({
                inspect: Effect.fn('Test.unreachable')(() =>
                  Effect.fail(new ConnectionAddressUnreachable({})),
                ),
              }),
            ),
          )
        expect(result).toEqual(
          AddIntegrationOutcome.cases.Unreachable.make({ reason: 'could not be reached' }),
        )
      }),
    )

    it.effect('explains unavailable server-by-address support in plain words before import', () =>
      Effect.gen(function* () {
        const { personalActor, threadId } = yield* fixture()
        const executor = yield* Executor
        const refused = Executor.of({
          ...executor,
          add: Effect.fn('Test.refusedImport')(() =>
            Effect.fail(new ExecutorPublicAddressRequired({})),
          ),
        })
        const addresses = ConnectionAddress.of({
          inspect: Effect.fn('Test.serverAddress')(() =>
            Effect.succeed(
              ConnectionSource.cases.Mcp.make({
                address: 'https://server.example/mcp',
                authorization: 'auto',
              }),
            ),
          ),
        })
        const result = yield* connectionHandlers
          .AddIntegration({ address: 'https://server.example/mcp', name: 'Server', shared: false })
          .pipe(
            Effect.provideService(ConnectionAddress, addresses),
            Effect.provide(connectionStoreLayer, { local: true }),
            Effect.provideService(Executor, refused),
            Effect.provideService(
              AuthContext,
              AuthState.Vivid({
                person: personalActor.person,
                workspace: personalActor.workspace,
                threadId,
              }),
            ),
          )
        expect(result).toEqual(
          AddIntegrationOutcome.cases.Unreachable.make({
            reason: 'this Vivid is not set up to add a server by address yet',
          }),
        )
      }),
    )
    it.effect(
      'finds owned and shared accounts before catalogue matches, excludes another Person and enforces sharing roles before import',
      () =>
        Effect.gen(function* () {
          const { ownerActor, memberActor, threadId } = yield* fixture()
          const store = yield* ConnectionStore
          yield* store.begin(ownerActor, {
            service: serviceId,
            label: 'Shared Records',
            shared: true,
          })
          yield* store.begin(ownerActor, {
            service: serviceId,
            label: 'Private Records',
            shared: false,
          })
          const auth = AuthState.Vivid({
            person: memberActor.person,
            workspace: memberActor.workspace,
            threadId,
          })
          const response = yield* connectionHandlers
            .FindIntegrations({ query: 'Records' })
            .pipe(Effect.provideService(AuthContext, auth))
          expect(response.integrations).toMatchObject([
            { name: 'Records', account: 'Shared Records', connected: true, shared: true },
            { name: 'Records', connected: true },
          ])
          expect(JSON.stringify(response)).not.toContain('Private Records')
          const unrelated = yield* connectionHandlers
            .FindIntegrations({ query: 'fetch web pages or search the web' })
            .pipe(Effect.provideService(AuthContext, auth))
          expect(unrelated.integrations.filter(ConnectionMatch.guards.Account)).toHaveLength(1)
          expect(unrelated.integrations[0]).toMatchObject({
            name: 'Records',
            account: 'Shared Records',
            connected: true,
            shared: true,
          })
          const probe = yield* ConnectionProbe
          const before = yield* Ref.get(probe.begins)
          const denied = yield* connectionHandlers
            .AddIntegration({ address: 'http://127.0.0.1/', name: 'Forbidden', shared: true })
            .pipe(Effect.provideService(AuthContext, auth), Effect.flip)
          expect(denied).toBeInstanceOf(Forbidden)
          expect(yield* Ref.get(probe.begins)).toBe(before)
        }),
    )
    it.effect('bounds accessible accounts at 24 before query-matched catalogue entries', () =>
      Effect.gen(function* () {
        const { ownerActor, personalActor, threadId } = yield* fixture()
        const store = yield* ConnectionStore
        for (let index = 0; index < 25; index++) {
          yield* store.begin(ownerActor, {
            service: serviceId,
            label: `Account ${index}`,
            shared: false,
          })
          yield* TestClock.adjust(1)
        }
        const response = yield* connectionHandlers.FindIntegrations({ query: 'Records' }).pipe(
          Effect.provideService(
            AuthContext,
            AuthState.Vivid({
              person: personalActor.person,
              workspace: personalActor.workspace,
              threadId,
            }),
          ),
        )
        const accounts = response.integrations.filter(ConnectionMatch.guards.Account)
        expect(accounts.map((entry) => entry.account)).toEqual(
          Array.from({ length: 24 }, (_, index) => `Account ${index}`),
        )
        expect(response.integrations).toHaveLength(25)
        expect(response.integrations.slice(0, 24).every(ConnectionMatch.guards.Account)).toBe(true)
        expect(response.integrations[24]).toMatchObject({ name: 'Records', connected: true })
        expect(ConnectionMatch.guards.Catalog(response.integrations[24])).toBe(true)
      }),
    )

    it.effect(
      'tests only reads with safe input and carries Gate approval/refusal without dispatching',
      () =>
        Effect.gen(function* () {
          const { ownerActor, personalActor, threadId } = yield* fixture()
          const store = yield* ConnectionStore
          const probe = yield* ConnectionProbe
          const auth = AuthState.Vivid({
            person: personalActor.person,
            workspace: personalActor.workspace,
            threadId,
          })
          yield* store.begin(ownerActor, { service: serviceId, label: 'Read test', shared: false })
          yield* Ref.set(probe.tools, [
            ExecutorTool.make({
              name: 'delete',
              description: '',
              input: { type: 'object' },
              effect: 'destructive',
            }),
            ExecutorTool.make({
              name: 'health',
              description: '',
              input: { type: 'object' },
              effect: 'read',
            }),
          ])
          const test = () =>
            connectionHandlers
              .TestIntegration({ account: 'Read test' })
              .pipe(Effect.provideService(AuthContext, auth))
          yield* Ref.set(probe.decision, 'Allowed')
          expect(yield* test()).toMatchObject({
            account: 'Read test',
            tool: 'health',
            tools: ['delete', 'health'],
          })
          const checked = yield* Ref.get(probe.checked)
          expect(checked.at(-1)).toMatchObject({
            action: { effect: 'read' },
            exposure: 'PersonalInShared',
          })
          const before = yield* Ref.get(probe.calls)
          yield* Ref.set(probe.decision, 'ApprovalRequired')
          expect((yield* test())._tag).toBe('ApprovalRequired')
          yield* Ref.set(probe.decision, 'Blocked')
          expect(yield* test()).toMatchObject({ rule: 'Never change records.' })
          expect(yield* Ref.get(probe.calls)).toBe(before)
          yield* Ref.set(probe.tools, [
            ExecutorTool.make({
              name: 'read',
              description: '',
              input: { type: 'object', required: ['record'] },
              effect: 'read',
            }),
          ])
          expect(yield* test()).toMatchObject({
            reason: 'no read-only tool can be tested without extra input',
          })
          expect(yield* Ref.get(probe.calls)).toBe(before)
          yield* Ref.set(probe.decision, 'Allowed')
        }),
    )
    it.effect(
      'completes keys once through the Person endpoint, keeps one mapping and writes no key in real audit rows',
      () =>
        Effect.gen(function* () {
          const { ownerActor, personalActor, threadId } = yield* fixture()
          const probe = yield* ConnectionProbe
          yield* Ref.set(probe.step, 'EnterKey')
          const executor = yield* Executor
          const submissions = yield* Ref.make(0)
          const secret = 'KEY-MUST-NEVER-ENTER-AUDIT'
          const keyed = Executor.of({
            ...executor,
            complete: Effect.fn('IntegrationTest.complete')(function* (input) {
              const key = input.fields['key']
              if (key === undefined) return yield* Effect.die('Missing test key')
              expect(Redacted.value(key)).toBe(secret)
              yield* Ref.update(submissions, (count) => count + 1)
              return yield* executor.complete(input)
            }),
          })
          const address = ConnectionAddress.of({
            inspect: Effect.fn('IntegrationTest.address')((value) =>
              Effect.succeed(
                ConnectionSource.cases.Mcp.make({ address: value, authorization: 'apiKey' }),
              ),
            ),
          })
          const vivid = AuthState.Vivid({
            person: personalActor.person,
            workspace: personalActor.workspace,
            threadId,
          })
          const person = AuthState.Person({
            person: ownerActor.person,
            workspace: ownerActor.workspace,
            sessionId: SessionId.make('integration-test-session'),
          })
          yield* Effect.gen(function* () {
            const result = yield* connectionHandlers
              .AddIntegration({
                address: 'https://integration.example/mcp',
                name: 'Keyed Records',
                shared: false,
              })
              .pipe(
                Effect.provideService(AuthContext, vivid),
                Effect.provideService(ConnectionAddress, address),
              )
            expect(result._tag).toBe('NeedsKey')
            if (!('step' in result) || !ConnectionStep.guards.EnterKey(result.step))
              return yield* Effect.die('Expected key entry')
            const completed = yield* connectionHandlers
              .CompleteConnection({
                id: result.step.connection.id,
                fields: { key: Redacted.make(secret) },
              })
              .pipe(Effect.provideService(AuthContext, person))
            expect(completed.connection.state._tag).toBe('Ready')
            const listed = yield* connectionHandlers
              .FindIntegrations({ query: 'Keyed' })
              .pipe(Effect.provideService(AuthContext, vivid))
            expect(listed.integrations).toHaveLength(1)
            const store = yield* ConnectionStore
            const persisted = yield* store.get(ownerActor, completed.connection.id)
            const database = yield* Database
            const rows = yield* database.run(
              database
                .select()
                .from(auditEntries)
                .where(eq(auditEntries.personId, ownerActor.person.id)),
            )
            expect(rows.length).toBeGreaterThan(0)
            expect(JSON.stringify({ result, completed, listed, persisted, rows })).not.toContain(
              secret,
            )
            return yield* Effect.void
          }).pipe(
            Effect.provide(connectionStoreLayer, { local: true }),
            Effect.provide(auditLayer, { local: true }),
            Effect.provideService(Executor, keyed),
          )
          expect(yield* Ref.get(submissions)).toBe(1)
          yield* Ref.set(probe.step, 'Done')
        }),
    )
  })
})
