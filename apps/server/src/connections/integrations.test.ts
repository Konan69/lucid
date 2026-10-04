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
import { ConnectionAddress, ConnectionSource } from './address.ts'
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
      'matches only normalized server addresses in the requested ownership, including redirects',
      () =>
        Effect.gen(function* () {
          const { ownerActor, threadId } = yield* fixture()
          const store = yield* ConnectionStore
          const auth = AuthState.Vivid({
            person: ownerActor.person,
            workspace: ownerActor.workspace,
            threadId,
          })
          const address = ConnectionAddress.of({
            inspect: Effect.fn('Test.redirect')((value) =>
              Effect.succeed(
                ConnectionSource.cases.Mcp.make({
                  address: value.replace('alias.example', 'server.example'),
                  authorization: 'auto',
                }),
              ),
            ),
          })
          const add = (url: string, name: string, shared: boolean) =>
            connectionHandlers
              .AddIntegration({
                address: url,
                name,
                shared,
              })
              .pipe(
                Effect.provideService(AuthContext, auth),
                Effect.provideService(ConnectionAddress, address),
              )
          yield* store.begin(ownerActor, { service: serviceId, label: 'Catalogue', shared: false })
          expect(
            AddIntegrationOutcome.guards.Added(
              yield* add('https://server.example/mcp', 'Records', false),
            ),
          ).toBe(true)
          expect(yield* add('HTTPS://SERVER.example:443/mcp/', 'Other', false)).toEqual(
            AddIntegrationOutcome.cases.AlreadyConnected.make({ account: 'Records' }),
          )
          yield* TestClock.adjust(1)
          expect(
            AddIntegrationOutcome.guards.Added(
              yield* add('https://different.example/mcp', 'Records', false),
            ),
          ).toBe(true)
          expect(
            AddIntegrationOutcome.guards.Added(
              yield* add('https://gmail.example/mcp', 'Gmail', false),
            ),
          ).toBe(true)
          expect(
            AddIntegrationOutcome.guards.Added(
              yield* add('https://server.example/mcp', 'Shared', true),
            ),
          ).toBe(true)
          expect(yield* add('https://alias.example/mcp', 'Redirect', false)).toEqual(
            AddIntegrationOutcome.cases.AlreadyConnected.make({ account: 'Records' }),
          )
          expect(yield* add('https://alias.example/mcp', 'Redirect', true)).toEqual(
            AddIntegrationOutcome.cases.AlreadyConnected.make({ account: 'Shared' }),
          )
          expect(yield* store.records(ownerActor)).toHaveLength(5)
        }),
    )

    it.effect(
      'resumes both pending authorization forms across two attempts without a second row',
      () =>
        Effect.gen(function* () {
          const { ownerActor, threadId } = yield* fixture()
          const store = yield* ConnectionStore
          const probe = yield* ConnectionProbe
          const previous = yield* Ref.get(probe.step)
          yield* Effect.addFinalizer(() => Ref.set(probe.step, previous))
          const auth = AuthState.Vivid({
            person: ownerActor.person,
            workspace: ownerActor.workspace,
            threadId,
          })
          const address = ConnectionAddress.of({
            inspect: Effect.fn('Test.address')((value) =>
              Effect.succeed(
                ConnectionSource.cases.Mcp.make({ address: value, authorization: 'auto' }),
              ),
            ),
          })
          for (const step of ['OpenSignIn', 'EnterKey'] as const) {
            yield* Ref.set(probe.step, step)
            const add = () =>
              connectionHandlers
                .AddIntegration({
                  address: `https://pending.example/${step}`,
                  name: step,
                  shared: false,
                })
                .pipe(
                  Effect.provideService(AuthContext, auth),
                  Effect.provideService(ConnectionAddress, address),
                )
            const first = yield* add()
            const second = yield* add()
            expect(AddIntegrationOutcome.guards.PendingAuthorization(second)).toBe(true)
            if (!AddIntegrationOutcome.guards.PendingAuthorization(second) || !('step' in first))
              return yield* Effect.die('Expected pending authorization')
            expect(second.account).toBe(step)
            expect(second.step.connection.id).toBe(first.step.connection.id)
          }
          const rows = yield* store.records(ownerActor)
          expect(rows).toHaveLength(2)
          for (const row of rows) {
            yield* store.failed(ownerActor, row, 'Provider resource missing')
          }
          const failed = yield* connectionHandlers
            .AddIntegration({
              address: 'https://pending.example/OpenSignIn',
              name: 'OpenSignIn',
              shared: false,
            })
            .pipe(
              Effect.provideService(AuthContext, auth),
              Effect.provideService(ConnectionAddress, address),
            )
          expect(failed).toEqual(AddIntegrationOutcome.cases.Failed.make({ account: 'OpenSignIn' }))
          expect(yield* store.records(ownerActor)).toHaveLength(2)
          return yield* Effect.void
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
    it.effect(
      'bounds discovery, prioritizes matches and recent accounts, and reports omissions',
      () =>
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
            Array.from({ length: 24 }, (_, index) => `Account ${24 - index}`),
          )
          expect(response.omittedAccounts).toBe(1)
          const narrowed = yield* connectionHandlers.FindIntegrations({ query: '0' }).pipe(
            Effect.provideService(
              AuthContext,
              AuthState.Vivid({
                person: personalActor.person,
                workspace: personalActor.workspace,
                threadId,
              }),
            ),
          )
          const narrowedAccounts = narrowed.integrations.filter(ConnectionMatch.guards.Account)
          expect(narrowedAccounts.slice(0, 3).map((entry) => entry.account)).toEqual([
            'Account 20',
            'Account 10',
            'Account 0',
          ])
          expect(narrowedAccounts[3]).toMatchObject({ account: 'Account 24' })
          expect(narrowed.omittedAccounts).toBe(1)
          expect(response.integrations).toHaveLength(25)
          expect(response.integrations.slice(0, 24).every(ConnectionMatch.guards.Account)).toBe(
            true,
          )
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
