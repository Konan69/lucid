import { describe, expect, layer } from '@effect/vitest'
import { AuthContext, AuthState } from '@vivid/contracts/auth'
import {
  AddIntegrationOutcome,
  ConnectionMatch,
  ConnectionStep,
  Forbidden,
  SessionId,
  InvalidRequest,
  ServiceAuthorization,
  Workspace,
} from '@vivid/contracts'
import { Layer, Effect, Redacted, Ref, Result } from 'effect'
import { eq } from 'drizzle-orm'
import { connections } from './tables.ts'
import { encodeReferences } from './records.ts'
import * as TestClock from 'effect/testing/TestClock'
import { connectionHandlers } from './handlers.ts'
import { ConnectionStore, connectionStoreLayer } from './store.ts'
import { ConnectionAddress, ConnectionSource } from './address.ts'
import {
  Executor,
  ExecutorPublicAddressRequired,
  ExecutorTool,
  connectionSetupMessage,
} from './executor.ts'
import { ConnectionProbe, connectionTestLayer, fixture, serviceId } from './testing.ts'
import { testDatabaseConfigured } from '../database/testdb.ts'
import { auditLayer } from '../audit/record.ts'
import { auditEntries } from '../audit/tables.ts'
import { Database } from '../database/client.ts'

/** Handler calls retain transport authentication, real store scope and real disposable SQL. */
describe.skipIf(!testDatabaseConfigured)('integration public handlers', () => {
  layer(connectionTestLayer)(
    'clock: matches only normalized server addresses in the requested ownership, including redirects',
    (it) => {
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
            yield* store.begin(ownerActor, {
              from: 'Web',
              service: serviceId,
              name: 'Catalogue',
              shared: false,
            })
            expect(
              AddIntegrationOutcome.guards.Added(
                yield* add('https://server.example/mcp', 'Records', false),
              ),
            ).toBe(true)
            expect(yield* add('HTTPS://SERVER.example.:443/mcp', 'Other', false)).toEqual(
              AddIntegrationOutcome.cases.AlreadyConnected.make({
                account: 'Records',
                name: 'Records',
              }),
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
              AddIntegrationOutcome.cases.AlreadyConnected.make({
                account: 'Records',
                name: 'Records',
              }),
            )
            expect(yield* add('https://alias.example/mcp', 'Redirect', true)).toEqual(
              AddIntegrationOutcome.cases.AlreadyConnected.make({
                account: 'Shared',
                name: 'Shared',
              }),
            )
            expect(
              AddIntegrationOutcome.guards.Added(
                yield* add('https://server.example/mcp/', 'Slash', false),
              ),
            ).toBe(true)
            expect(yield* store.records(ownerActor)).toHaveLength(6)
          }),
      )
    },
  )

  layer(connectionTestLayer)((it) => {
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
                  shared: true,
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
              shared: true,
            })
            .pipe(
              Effect.provideService(AuthContext, auth),
              Effect.provideService(ConnectionAddress, address),
            )
          expect(failed).toEqual(
            AddIntegrationOutcome.cases.Failed.make({ account: 'OpenSignIn', name: 'OpenSignIn' }),
          )
          expect(yield* store.records(ownerActor)).toHaveLength(2)
          return yield* Effect.void
        }),
    )

    it.effect(
      'leaves another admin’s pending Company authorization and provider grant untouched',
      () =>
        Effect.gen(function* () {
          const { ownerActor, memberActor, threadId } = yield* fixture()
          const store = yield* ConnectionStore
          const probe = yield* ConnectionProbe
          const previous = yield* Ref.get(probe.step)
          yield* Effect.addFinalizer(() => Ref.set(probe.step, previous))
          yield* Ref.set(probe.step, 'OpenSignIn')
          const address = ConnectionSource.cases.Mcp.make({
            address: 'https://pending.example/shared',
            authorization: 'auto',
          })
          yield* store.add(
            ownerActor,
            { address: address.address, name: 'Company Records', shared: true },
            address,
          )
          const before = yield* store.records(ownerActor)
          const begins = yield* Ref.get(probe.begins)
          const catalogs = yield* Ref.get(probe.catalogs)
          const workspace = Workspace.match<Workspace>(memberActor.workspace, {
            Personal: () => Workspace.cases.Personal.make({}),
            Company: ({ company }) => Workspace.cases.Company.make({ company, role: 'admin' }),
          })
          const result = yield* connectionHandlers
            .AddIntegration({
              address: address.address,
              name: 'Other label',
              shared: true,
            })
            .pipe(
              Effect.provideService(
                AuthContext,
                AuthState.Vivid({
                  person: memberActor.person,
                  workspace,
                  threadId,
                }),
              ),
            )
          expect(result).toEqual(
            AddIntegrationOutcome.cases.AwaitingInitiator.make({ name: 'Company Records' }),
          )
          expect(yield* store.records(ownerActor)).toEqual(before)
          expect(yield* Ref.get(probe.begins)).toBe(begins)
          expect(yield* Ref.get(probe.catalogs)).toBe(catalogs)
        }),
    )

    it.effect('prefers Ready over older Failed duplicates and chooses the newest Ready row', () =>
      Effect.gen(function* () {
        const { ownerActor, threadId } = yield* fixture()
        const store = yield* ConnectionStore
        const source = ConnectionSource.cases.Mcp.make({
          address: 'https://duplicates.example/mcp',
          authorization: 'auto',
        })
        yield* store.add(
          ownerActor,
          { address: source.address, name: 'Older Failed', shared: false },
          source,
        )
        const rows = yield* store.records(ownerActor)
        const row = rows[0]
        if (row === undefined) return yield* Effect.die('Expected imported account')
        yield* store.failed(ownerActor, row, 'Previous attempt failed')
        const database = yield* Database
        // Seed the earlier bug's duplicates through SQL; public Add correctly refuses to create them.
        yield* database.run(
          database.insert(connections).values([
            {
              ...row,
              id: crypto.randomUUID(),
              name: 'Older Ready',
              identity: null,
              serviceName: 'Records',
              references: yield* encodeReferences(row.references),
              status: 'ready',
              reason: null,
              createdAt: row.createdAt + 1,
            },
            {
              ...row,
              id: crypto.randomUUID(),
              name: 'Newest Ready',
              identity: null,
              serviceName: 'Records',
              references: yield* encodeReferences(row.references),
              status: 'ready',
              reason: null,
              createdAt: row.createdAt + 2,
            },
            {
              ...row,
              id: crypto.randomUUID(),
              name: 'Newest Pending',
              identity: null,
              references: yield* encodeReferences(row.references),
              status: 'needs-authorization',
              reason: null,
              createdAt: row.createdAt + 3,
            },
          ]),
        )
        const result = yield* connectionHandlers
          .AddIntegration({ address: source.address, name: 'Again', shared: false })
          .pipe(
            Effect.provideService(
              AuthContext,
              AuthState.Vivid({
                person: ownerActor.person,
                workspace: ownerActor.workspace,
                threadId,
              }),
            ),
          )
        expect(result).toEqual(
          AddIntegrationOutcome.cases.AlreadyConnected.make({
            account: 'Records (Newest Ready)',
            name: 'Records',
          }),
        )
        expect(yield* store.records(ownerActor)).toHaveLength(4)
        return yield* Effect.void
      }),
    )

    it.effect('preserves InvalidRequest from both direct and redirected resume attempts', () =>
      Effect.gen(function* () {
        const { ownerActor, threadId } = yield* fixture()
        const store = yield* ConnectionStore
        const probe = yield* ConnectionProbe
        const previous = yield* Ref.get(probe.step)
        yield* Effect.addFinalizer(() => Ref.set(probe.step, previous))
        yield* Ref.set(probe.step, 'OpenSignIn')
        const source = ConnectionSource.cases.Mcp.make({
          address: 'https://pending.example/mcp',
          authorization: 'auto',
        })
        yield* store.add(
          ownerActor,
          { address: source.address, name: 'Pending', shared: false },
          source,
        )
        const row = (yield* store.records(ownerActor))[0]
        if (row === undefined) return yield* Effect.die('Expected pending account')
        const executor = yield* Executor
        const catalog = yield* executor.catalog
        const entry = catalog[0]
        if (entry === undefined) return yield* Effect.die('Expected catalogue fixture')
        const unavailable = Executor.of({
          ...executor,
          catalog: Effect.suspend(() =>
            Effect.succeed([
              {
                ...entry,
                id: row.service,
                authorization: ServiceAuthorization.cases.SetupRequired.make({}),
              },
            ]),
          ).pipe(Effect.withSpan('Test.setupRequired')),
        })
        const addresses = ConnectionAddress.of({
          inspect: Effect.fn('Test.redirect')(() => Effect.succeed(source)),
        })
        for (const address of [source.address, 'https://alias.example/mcp']) {
          const result = yield* Effect.gen(function* () {
            // Capture InvalidRequest at the store boundary for both resume paths.
            const context = yield* Layer.build(Layer.fresh(connectionStoreLayer))
            return yield* connectionHandlers
              .AddIntegration({ address, name: 'Again', shared: false })
              .pipe(Effect.provideService(ConnectionAddress, addresses), Effect.provide(context))
          }).pipe(
            Effect.scoped,
            Effect.provideService(Executor, unavailable),
            Effect.provideService(
              AuthContext,
              AuthState.Vivid({
                person: ownerActor.person,
                workspace: ownerActor.workspace,
                threadId,
              }),
            ),
            Effect.result,
          )
          expect(result).toEqual(
            Result.fail(InvalidRequest.make({ message: connectionSetupMessage })),
          )
        }
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
        const result = yield* Effect.gen(function* () {
          // This store uses the address-import rejection that needs a product explanation.
          const context = yield* Layer.build(Layer.fresh(connectionStoreLayer))
          return yield* connectionHandlers
            .AddIntegration({
              address: 'https://server.example/mcp',
              name: 'Server',
              shared: false,
            })
            .pipe(Effect.provideService(ConnectionAddress, addresses), Effect.provide(context))
        }).pipe(
          Effect.scoped,
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
            from: 'Web',
            service: serviceId,
            name: 'Shared Records',
            shared: true,
          })
          yield* store.begin(ownerActor, {
            from: 'Web',
            service: serviceId,
            name: 'Private Records',
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
            { name: 'Records', account: 'Records (Shared Records)', connected: true, shared: true },
            { name: 'Records', connected: true },
          ])
          expect(JSON.stringify(response)).not.toContain('Private Records')
          const unrelated = yield* connectionHandlers
            .FindIntegrations({ query: 'fetch web pages or search the web' })
            .pipe(Effect.provideService(AuthContext, auth))
          expect(unrelated.integrations.filter(ConnectionMatch.guards.Account)).toHaveLength(1)
          expect(unrelated.integrations[0]).toMatchObject({
            name: 'Records',
            account: 'Records (Shared Records)',
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
  })

  layer(connectionTestLayer)(
    'clock: bounds discovery, prioritizes matches and recent accounts, and reports omissions',
    (it) => {
      it.effect(
        'bounds discovery, prioritizes matches and recent accounts, and reports omissions',
        () =>
          Effect.gen(function* () {
            const { ownerActor, personalActor, threadId } = yield* fixture()
            const store = yield* ConnectionStore
            for (let index = 0; index < 25; index++) {
              yield* store.begin(ownerActor, {
                from: 'Web',
                service: serviceId,
                name: `Account ${index}`,
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
              Array.from({ length: 24 }, (_, index) => `Records (Account ${24 - index})`),
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
              'Records (Account 20)',
              'Records (Account 10)',
              'Records (Account 0)',
            ])
            expect(narrowedAccounts[3]).toMatchObject({ account: 'Records (Account 24)' })
            expect(narrowed.omittedAccounts).toBe(1)
            expect(response.integrations).toHaveLength(25)
            expect(response.integrations.slice(0, 24).every(ConnectionMatch.guards.Account)).toBe(
              true,
            )
            expect(response.integrations[24]).toMatchObject({ name: 'Records', connected: true })
            expect(ConnectionMatch.guards.Catalog(response.integrations[24])).toBe(true)
          }),
      )
    },
  )

  layer(connectionTestLayer)((it) => {
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
          yield* store.begin(ownerActor, {
            from: 'Web',
            service: serviceId,
            name: 'Read test',
            shared: false,
          })
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
              .TestIntegration({ account: 'Records (Read test)' })
              .pipe(Effect.provideService(AuthContext, auth))
          yield* Ref.set(probe.decision, 'Allowed')
          expect(yield* test()).toMatchObject({
            account: 'Records (Read test)',
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
    it.layer(auditLayer)('key completion audit', (it) => {
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
              // The replacement store captures the real audit service supplied by the nested harness.
              const context = yield* Layer.build(Layer.fresh(connectionStoreLayer))
              return yield* Effect.gen(function* () {
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
                expect(
                  JSON.stringify({ result, completed, listed, persisted, rows }),
                ).not.toContain(secret)
                return yield* Effect.void
              }).pipe(Effect.provide(context))
            }).pipe(Effect.scoped, Effect.scoped, Effect.provideService(Executor, keyed))
            expect(yield* Ref.get(submissions)).toBe(1)
            yield* Ref.set(probe.step, 'Done')
          }),
      )
    })
  })
})
