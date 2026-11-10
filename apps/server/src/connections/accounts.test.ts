import { ExecutorAppOwnership, installationCaller } from './executor.ts'
import { describe, expect, layer } from '@effect/vitest'
import { Layer, Effect, Option, Redacted, Ref, Schema } from 'effect'
import * as TestClock from 'effect/testing/TestClock'
import {
  ActionTarget,
  AnotherAccountMessage,
  ConnectionId,
  ConnectionMatch,
  ConnectionState,
  ConnectionStep,
  Forbidden,
  SessionId,
  ToolOutcome,
} from '@vivid/contracts'
import { AuthContext, AuthState } from '@vivid/contracts/auth'
import type { Actor } from '../auth/access.ts'
import { testDatabaseConfigured } from '../database/testdb.ts'
import {
  AccountIdentity,
  Executor,
  ExecutorAccountId,
  ExecutorAppId,
  ExecutorOwnerId,
  ExecutorBinding,
  ExecutorReferences,
  ExecutorTransportFailure,
} from './executor.ts'
import { connectionHandlers } from './handlers.ts'
import { ConnectionStore, connectionStoreLayer } from './store.ts'
import {
  ConnectionProbe,
  connectionTestLayer,
  fixture,
  hostedExecutorFixture,
  hostedPrefix,
  hostedService,
  serviceId,
  toolRequest,
} from './testing.ts'

const person = (actor: Actor) =>
  AuthState.Person({
    person: actor.person,
    workspace: actor.workspace,
    sessionId: SessionId.make('accounts-session'),
  })

/**
 * Connects one account on the test service the way a service with a key does, so the Connection
 * holds an account the service can be asked about. `identity` is who the service will say it is.
 * The test clock stands still unless moved, and it is moved here.
 */
const connect = Effect.fn('AccountsTest.connect')(function* (
  actor: Actor,
  identity: Option.Option<AccountIdentity>,
) {
  // Accounts are named in the order they were added, so each is added at its own moment.
  yield* TestClock.adjust('1 second')
  const probe = yield* ConnectionProbe
  yield* Ref.set(probe.step, 'EnterKey')
  yield* Ref.set(probe.identity, identity)
  const begun = yield* connectionHandlers
    .BeginConnection({ from: 'Web', service: serviceId, name: null, shared: false })
    .pipe(Effect.provideService(AuthContext, person(actor)))
  if (!ConnectionStep.guards.EnterKey(begun)) return expect.fail('Key step required')
  const { connection } = yield* connectionHandlers
    .CompleteConnection({ id: begun.connection.id, fields: { key: Redacted.make('stand-in') } })
    .pipe(Effect.provideService(AuthContext, person(actor)))
  return connection
})

const identityOf = Schema.decodeUnknownSync(AccountIdentity)

describe.skipIf(!testDatabaseConfigured)('several accounts on one Integration', () => {
  layer(connectionTestLayer)(
    'clock: names each account by who the service says signed in, and Vivid acts through the one it names',
    (test) => {
      test.effect(
        'names each account by who the service says signed in, and Vivid acts through the one it names',
        () =>
          Effect.gen(function* () {
            const { ownerActor, threadId } = yield* fixture()
            const probe = yield* ConnectionProbe
            const work = yield* connect(ownerActor, Option.some(identityOf('ada@work.example')))
            const home = yield* connect(ownerActor, Option.some(identityOf('ada@home.example')))
            expect(ConnectionState.guards.Ready(work.state)).toBe(true)
            expect([work.identity, work.account]).toEqual([
              'ada@work.example',
              'Records (ada@work.example)',
            ])
            expect([home.identity, home.account]).toEqual([
              'ada@home.example',
              'Records (ada@home.example)',
            ])

            const listed = yield* connectionHandlers
              .ListConnections()
              .pipe(Effect.provideService(AuthContext, person(ownerActor)))
            // Newest first, each under the name it was given when it was connected.
            expect(listed.connections.map((item) => item.account)).toEqual([
              'Records (ada@home.example)',
              'Records (ada@work.example)',
            ])

            const vivid = AuthState.Vivid({
              person: ownerActor.person,
              workspace: ownerActor.workspace,
              threadId,
            })
            const integrations = yield* connectionHandlers
              .FindIntegrations({ query: 'records' })
              .pipe(Effect.provideService(AuthContext, vivid))
            expect(
              integrations.integrations.filter(ConnectionMatch.guards.Account).map((entry) => ({
                account: entry.account,
                identity: entry.identity,
              })),
            ).toEqual([
              { account: 'Records (ada@home.example)', identity: 'ada@home.example' },
              { account: 'Records (ada@work.example)', identity: 'ada@work.example' },
            ])

            const tools = yield* connectionHandlers
              .FindTools({ query: 'read records', limit: 25 })
              .pipe(Effect.provideService(AuthContext, vivid))
            expect(new Set(tools.tools.map((tool) => tool.account))).toEqual(
              new Set(['Records (ada@work.example)', 'Records (ada@home.example)']),
            )

            // The account's name alone decides which Connection a call goes to.
            const resolved = yield* connectionHandlers
              .ResolveTool({ account: 'records (ADA@work.example)', tool: 'read' })
              .pipe(Effect.provideService(AuthContext, vivid))
            expect(resolved.connectionId).toBe(work.id)
            const other = yield* connectionHandlers
              .ResolveTool({ account: 'Records (ada@home.example)', tool: 'read' })
              .pipe(Effect.provideService(AuthContext, vivid))
            expect(other.connectionId).toBe(home.id)

            const inputAt = (yield* Ref.get(probe.inputs)).length
            const { outcome: used } = yield* connectionHandlers
              .UseTool(toolRequest(resolved.connectionId, 'read'))
              .pipe(Effect.provideService(AuthContext, vivid))
            expect(used).toEqual(
              ToolOutcome.cases.Completed.make({ output: { ok: true }, receipt: null }),
            )
            const row = yield* (yield* ConnectionStore).get(ownerActor, work.id)
            expect((yield* Ref.get(probe.inputs)).slice(inputAt)).toEqual([
              { references: row.references, tool: 'read', input: {} },
            ])
            // The Gate, and so an Approval, is asked about the account by its own name.
            const asked = (yield* Ref.get(probe.checked))
              .map((check) => check.action.target)
              .filter(ActionTarget.guards.Connection)
            expect(asked).toMatchObject([
              { connectionId: work.id, account: 'Records (ada@work.example)' },
            ])
          }),
      )
    },
  )

  layer(connectionTestLayer)(
    'clock: lets a Person name an account, change the name and take it away again',
    (test) => {
      test.effect('lets a Person name an account, change the name and take it away again', () =>
        Effect.gen(function* () {
          const { ownerActor, memberActor, threadId } = yield* fixture()
          const connected = yield* connect(ownerActor, Option.some(identityOf('ada@work.example')))
          const rename = (id: ConnectionId, name: string | null, auth: AuthState) =>
            connectionHandlers
              .RenameConnection({ id, name })
              .pipe(Effect.provideService(AuthContext, auth))

          const named = yield* rename(connected.id, 'Work', person(ownerActor))
          // The Person's word leads; who the service says it is stays a separate fact.
          expect(named.connection).toMatchObject({
            name: 'Work',
            identity: 'ada@work.example',
            account: 'Records (Work)',
          })
          const vivid = AuthState.Vivid({
            person: ownerActor.person,
            workspace: ownerActor.workspace,
            threadId,
          })
          const resolved = yield* connectionHandlers
            .ResolveTool({ account: 'Records (Work)', tool: 'read' })
            .pipe(Effect.provideService(AuthContext, vivid))
          expect(resolved.connectionId).toBe(connected.id)
          // "the work one" and the address behind it both find the account.
          const byAddress = yield* connectionHandlers
            .FindIntegrations({ query: 'ada@work.example' })
            .pipe(Effect.provideService(AuthContext, vivid))
          expect(byAddress.integrations.find(ConnectionMatch.guards.Account)).toMatchObject({
            account: 'Records (Work)',
            identity: 'ada@work.example',
          })

          const cleared = yield* rename(connected.id, null, person(ownerActor))
          expect(cleared.connection.account).toBe('Records (ada@work.example)')

          // A name is the Person's to give: not Vivid's, and not another Person's.
          expect(yield* rename(connected.id, 'Mine', vivid).pipe(Effect.flip)).toBeInstanceOf(
            Forbidden,
          )
          expect(
            (yield* rename(connected.id, 'Mine', person(memberActor)).pipe(Effect.flip))._tag,
          ).toBe('NotFound')
        }),
      )
    },
  )

  layer(connectionTestLayer)(
    'clock: keeps an account usable when the service cannot be asked who it is',
    (test) => {
      test.effect('keeps an account usable when the service cannot be asked who it is', () =>
        Effect.gen(function* () {
          const { ownerActor } = yield* fixture()
          const executor = yield* Executor
          const silent = Executor.of({
            ...executor,
            as: (caller) => ({
              ...executor.as(caller),
              identity: Effect.fn('Executor.Test.unreachable')(() =>
                Effect.fail(ExecutorTransportFailure.make({ service: 'connections', tool: null })),
              ),
            }),
          })
          const connected = yield* Effect.gen(function* () {
            // Capture the identity-failing Executor rather than the harness's default account reader.
            const context = yield* Layer.build(Layer.fresh(connectionStoreLayer))
            return yield* connect(ownerActor, Option.none()).pipe(Effect.provide(context))
          }).pipe(Effect.scoped, Effect.provideService(Executor, silent))
          expect(ConnectionState.guards.Ready(connected.state)).toBe(true)
          expect([connected.identity, connected.account]).toEqual([null, 'Records'])
        }),
      )
    },
  )

  layer(connectionTestLayer)(
    'clock: numbers an account by its place on the service, so a name is never handed on',
    (test) => {
      test.effect(
        'numbers an account by its place on the service, so a name is never handed on',
        () =>
          Effect.gen(function* () {
            const { ownerActor, threadId } = yield* fixture()
            const first = yield* connect(ownerActor, Option.none())
            const second = yield* connect(ownerActor, Option.none())
            expect([first.account, second.account]).toEqual(['Records', 'Records (2)'])
            const vivid = AuthState.Vivid({
              person: ownerActor.person,
              workspace: ownerActor.workspace,
              threadId,
            })
            // Vivid was shown the first account as "Records". The Person then names that account.
            const renamed = yield* connectionHandlers
              .RenameConnection({ id: first.id, name: 'Work' })
              .pipe(Effect.provideService(AuthContext, person(ownerActor)))
            expect(renamed.connection.account).toBe('Records (Work)')
            const listed = yield* connectionHandlers
              .ListConnections()
              .pipe(Effect.provideService(AuthContext, person(ownerActor)))
            // The second account keeps its own name. It does not become "Records".
            expect(listed.connections.map((item) => item.account).toSorted()).toEqual([
              'Records (2)',
              'Records (Work)',
            ])
            // So the name Vivid still holds for the first account reaches no account at all, and
            // never the second one.
            expect(
              (yield* connectionHandlers
                .ResolveTool({ account: 'Records', tool: 'read' })
                .pipe(Effect.provideService(AuthContext, vivid), Effect.flip))._tag,
            ).toBe('NotFound')
            const stillSecond = yield* connectionHandlers
              .ResolveTool({ account: 'Records (2)', tool: 'read' })
              .pipe(Effect.provideService(AuthContext, vivid))
            expect(stillSecond.connectionId).toBe(second.id)
          }),
      )
    },
  )

  layer(connectionTestLayer)(
    'clock: refuses a name another account on the same service already has',
    (test) => {
      test.effect('refuses a name another account on the same service already has', () =>
        Effect.gen(function* () {
          const { ownerActor } = yield* fixture()
          const first = yield* connect(ownerActor, Option.none())
          const second = yield* connect(ownerActor, Option.none())
          const rename = (id: ConnectionId, name: string | null) =>
            connectionHandlers
              .RenameConnection({ id, name })
              .pipe(Effect.provideService(AuthContext, person(ownerActor)))
          yield* rename(first.id, 'Work')
          // Case and spaces do not make it a different name.
          expect((yield* rename(second.id, 'work').pipe(Effect.flip))._tag).toBe('Conflict')
          // Saving the name an account already has is not a clash with itself.
          expect((yield* rename(first.id, 'Work')).connection.name).toBe('Work')
          // A third account cannot be added under it either, and nothing is begun for it.
          const probe = yield* ConnectionProbe
          const begins = yield* Ref.get(probe.begins)
          expect(
            (yield* connectionHandlers
              .BeginConnection({ from: 'Web', service: serviceId, name: 'Work', shared: false })
              .pipe(Effect.provideService(AuthContext, person(ownerActor)), Effect.flip))._tag,
          ).toBe('Conflict')
          expect(yield* Ref.get(probe.begins)).toBe(begins)
        }),
      )
    },
  )

  layer(connectionTestLayer)(
    'clock: does not move an account’s authorization revision when it is named',
    (test) => {
      test.effect('does not move an account’s authorization revision when it is named', () =>
        Effect.gen(function* () {
          const { ownerActor } = yield* fixture()
          const connected = yield* connect(ownerActor, Option.some(identityOf('ada@work.example')))
          const store = yield* ConnectionStore
          const before = yield* store.get(ownerActor, connected.id)
          yield* TestClock.adjust('1 minute')
          yield* connectionHandlers
            .RenameConnection({ id: connected.id, name: 'Work' })
            .pipe(Effect.provideService(AuthContext, person(ownerActor)))
          const after = yield* store.get(ownerActor, connected.id)
          // `saveState` compares this revision: a sign-in completing while the Person names the
          // account must still find the revision it read.
          expect([after.name, after.updatedAt]).toEqual(['Work', before.updatedAt])
        }),
      )
    },
  )

  layer(connectionTestLayer)((test) => {
    test.effect('keeps the name a Person gave when they added the account', () =>
      Effect.gen(function* () {
        const { ownerActor } = yield* fixture()
        const probe = yield* ConnectionProbe
        yield* Ref.set(probe.step, 'Done')
        const step = yield* connectionHandlers
          .BeginConnection({ from: 'Web', service: serviceId, name: 'Personal', shared: false })
          .pipe(Effect.provideService(AuthContext, person(ownerActor)))
        expect(step.connection).toMatchObject({
          name: 'Personal',
          identity: null,
          account: 'Records (Personal)',
          origin: 'Catalogue',
        })
      }),
    )
  })

  layer(connectionTestLayer)(
    'clock: lets Vivid ask for one more account only where there is one already',
    (test) => {
      test.effect('lets Vivid ask for one more account only where there is one already', () =>
        Effect.gen(function* () {
          const { ownerActor, memberActor, threadId } = yield* fixture()
          const vivid = (actor: Actor) =>
            AuthState.Vivid({ person: actor.person, workspace: actor.workspace, threadId })
          const offer = (wanted: 'Service' | 'Another', actor: Actor) =>
            connectionHandlers
              .OfferConnection({ service: serviceId, reason: 'To use your work account', wanted })
              .pipe(Effect.provideService(AuthContext, vivid(actor)))
          const isAnother = Schema.is(AnotherAccountMessage)

          // Nothing connected: asking for "another" is asking for the service.
          const first = yield* offer('Another', ownerActor)
          expect(isAnother(first)).toBe(false)
          expect(first.ready).toBe(false)

          const connected = yield* connect(ownerActor, Option.some(identityOf('ada@home.example')))
          const found = yield* connectionHandlers
            .FindTools({ query: 'records', limit: 25 })
            .pipe(Effect.provideService(AuthContext, vivid(ownerActor)))
          // A connected service is no longer on offer, and is the one another account is asked on.
          expect(found.unconnected).toEqual([])
          expect(found.connected.map((service) => service.id)).toEqual([serviceId])

          // The service is there, so the ordinary card is settled.
          expect((yield* offer('Service', ownerActor)).ready).toBe(true)
          const another = yield* offer('Another', ownerActor)
          expect(another.ready).toBe(false)
          // The card carries when Vivid asked. The account that is there was begun before that
          // moment, so it does not answer the request.
          const askedAt = Option.map(
            Option.liftPredicate(another, isAnother),
            (message) => message.another.askedAt,
          )
          expect(Option.map(askedAt, (moment) => moment >= connected.createdAt)).toEqual(
            Option.some(true),
          )

          // Another Person has no account on it: for them the service is still simply on offer.
          const theirs = yield* connectionHandlers
            .FindTools({ query: 'records', limit: 25 })
            .pipe(Effect.provideService(AuthContext, vivid(memberActor)))
          expect(theirs.connected).toEqual([])
          expect(isAnother(yield* offer('Another', memberActor))).toBe(false)
        }),
      )
    },
  )
})

describe.skipIf(!testDatabaseConfigured)('asking Executor who an account is', () => {
  layer(connectionTestLayer)((test) => {
    const references = (account: Option.Option<string>) => {
      const identity = {
        appOwnership: ExecutorAppOwnership.cases.Dedicated.make({}),
        service: hostedService,
        app: ExecutorAppId.make('app'),
        binding: ExecutorBinding.cases.Public.make({}),
        owner: ExecutorOwnerId.make('p-test'),
      }
      return Option.match(account, {
        onNone: () => ExecutorReferences.cases.Public.make(identity),
        onSome: (id) =>
          ExecutorReferences.cases.Authorized.make({
            ...identity,
            account: ExecutorAccountId.make(id),
          }),
      })
    }
    const asked = (remote: Effect.Success<ReturnType<typeof hostedExecutorFixture>>) =>
      Ref.get(remote.requests).pipe(
        Effect.map(
          (requests) =>
            requests.filter(
              (request) => request.path === `POST ${hostedPrefix}/accounts/account/health`,
            ).length,
        ),
      )

    test.effect('runs the app’s own check and names the account by its address', () =>
      Effect.gen(function* () {
        const remote = yield* hostedExecutorFixture()
        yield* Ref.set(remote.identity, {
          displayName: 'Ada Obi',
          email: 'ada@work.example',
          avatarUrl: 'https://images.example/ada.png',
        })
        // The client's scope must stay open until the account check finishes.
        const context = yield* Layer.build(remote.configured)
        const executor = yield* Executor.pipe(Effect.provide(context))
        expect(
          yield* executor.as(installationCaller).identity(references(Option.some('account'))),
        ).toEqual(Option.some('ada@work.example'))
        expect(yield* asked(remote)).toBe(1)
      }).pipe(Effect.scoped),
    )

    test.effect('passes over a value that cannot name an account for the next one', () =>
      Effect.gen(function* () {
        const remote = yield* hostedExecutorFixture()
        yield* Ref.set(remote.identity, { email: `${'a'.repeat(200)}@x.example`, username: 'ada' })
        const context = yield* Layer.build(remote.configured)
        const executor = yield* Executor.pipe(Effect.provide(context))
        expect(
          yield* executor.as(installationCaller).identity(references(Option.some('account'))),
        ).toEqual(Option.some('ada'))
      }).pipe(Effect.scoped),
    )

    test.effect(
      'has no identity for an app with no check, and asks nobody about a public service',
      () =>
        Effect.gen(function* () {
          const remote = yield* hostedExecutorFixture()
          const context = yield* Layer.build(remote.configured)
          const executor = yield* Executor.pipe(Effect.provide(context))
          expect(
            yield* executor.as(installationCaller).identity(references(Option.some('account'))),
          ).toEqual(Option.none())
          expect(yield* asked(remote)).toBe(1)
          expect(
            yield* executor.as(installationCaller).identity(references(Option.none())),
          ).toEqual(Option.none())
          // A Connection with no account was not asked about: there is nobody it could be.
          expect(yield* asked(remote)).toBe(1)
        }).pipe(Effect.scoped),
    )
  })
})
