import { describe, expect, layer } from '@effect/vitest'
import { Layer, Effect, Ref } from 'effect'
import {
  ConnectionId,
  ConnectionStep,
  Forbidden,
  ServiceUnavailable,
  Person,
  PersonId,
  SessionId,
  Workspace,
  ActionTarget,
  ServiceCatalog,
  ServiceAuthorization,
  InvalidRequest,
  NotFound,
} from '@vivid/contracts'
import { AuthContext, AuthState } from '@vivid/contracts/auth'
import { Changes, Topic } from '../live/changes.ts'
import { testDatabaseConfigured } from '../database/testdb.ts'
import { connectionHandlers, connectionRunner } from './handlers.ts'
import { ConnectionStore, connectionStoreLayer } from './store.ts'
import {
  Executor,
  ExecutorAccessDenied,
  ExecutorCallOutcome,
  ExecutorApprovalUnsupported,
  ExecutorResourceMissing,
  ExecutorAuthorizationUnavailable,
  ExecutorReferences,
  ExecutorAuthorizationId,
  ExecutorServiceEntry,
  connectionSetupMessage,
} from './executor.ts'
import { ConnectionProbe, connectionTestLayer, fixture, serviceId, toolRequest } from './testing.ts'

const personAuth = AuthState.Person({
  person: Person.make({
    id: PersonId.make('test-person'),
    name: 'Person',
    email: 'person@example.test',
  }),
  sessionId: SessionId.make('test-session'),
  workspace: Workspace.cases.Personal.make({}),
})

describe.skipIf(!testDatabaseConfigured)('Connection transport authentication', () => {
  layer(connectionTestLayer)((it) => {
    it.effect('does not offer a service whose sign-in needs operator setup', () =>
      Effect.gen(function* () {
        const { ownerActor, threadId } = yield* fixture()
        const executor = yield* Executor
        const setupRequired = Executor.of({
          ...executor,
          authorization: Effect.fn('Executor.Test.unoffered')(() =>
            Effect.succeed(ServiceAuthorization.cases.SetupRequired.make({})),
          ),
        })
        const auth = AuthState.Vivid({
          person: ownerActor.person,
          workspace: ownerActor.workspace,
          threadId,
        })
        yield* Effect.gen(function* () {
          // The discovery store must capture the setup-required catalog instead of the default fake.
          const context = yield* Layer.build(Layer.fresh(connectionStoreLayer))
          return yield* Effect.gen(function* () {
            const found = yield* connectionHandlers.FindTools({ query: 'records' })
            expect(found.unconnected).toEqual([])
            expect(
              yield* connectionHandlers
                .OfferConnection({ service: serviceId, reason: 'Read records', wanted: 'Service' })
                .pipe(Effect.flip),
            ).toEqual(new InvalidRequest({ message: connectionSetupMessage }))
          }).pipe(Effect.provide(context))
        }).pipe(
          Effect.scoped,
          Effect.provideService(Executor, setupRequired),
          Effect.provideService(AuthContext, auth),
        )
      }),
    )
    it.effect('lets only a signed-in Person search services', () =>
      Effect.gen(function* () {
        const found = yield* connectionHandlers
          .FindServices({ query: 'records' })
          .pipe(Effect.provideService(AuthContext, personAuth))
        expect(ServiceCatalog.guards.Ready(found)).toBe(true)
        expect(found).toMatchObject({ total: 1, services: [{ name: 'Records' }] })
        const { memberActor, threadId } = yield* fixture()
        const probe = yield* ConnectionProbe
        const before = yield* Ref.get(probe.catalogs)
        const failure = yield* connectionHandlers.FindServices({ query: '' }).pipe(
          Effect.provideService(
            AuthContext,
            AuthState.Vivid({
              person: memberActor.person,
              workspace: memberActor.workspace,
              threadId,
            }),
          ),
          Effect.flip,
        )
        expect(failure).toBeInstanceOf(Forbidden)
        expect(yield* Ref.get(probe.catalogs)).toBe(before)
      }),
    )
    it.effect('reserves UseTool for Vivid without reading store state or dispatching', () =>
      Effect.gen(function* () {
        const store = yield* ConnectionStore
        const probe = yield* ConnectionProbe
        const calls = yield* Ref.get(probe.calls)
        // A hostile store read turns an incorrectly routed Person request into a defect;
        // the real Forbidden result must be chosen before any account lookup.
        const unreadable = ConnectionStore.of({
          ...store,
          get: () => Effect.die('Person UseTool must not read a Connection'),
        })
        const failure = yield* connectionHandlers
          .UseTool(toolRequest(ConnectionId.make('absent'), 'read'))
          .pipe(
            Effect.provideService(AuthContext, personAuth),
            Effect.provideService(ConnectionStore, unreadable),
            Effect.flip,
          )
        expect(failure).toBeInstanceOf(Forbidden)
        expect(yield* Ref.get(probe.calls)).toBe(calls)
      }),
    )
  })
})

/** Handler requests exercise authentication, scoped SQL and provider identity through the test Layers. */
describe.skipIf(!testDatabaseConfigured)('ResumeConnection', () => {
  layer(connectionTestLayer)((it) => {
    for (const expected of ['OpenSignIn', 'EnterKey', 'Done'] as const) {
      it.effect(`resumes ${expected} on the same row and provider target`, () =>
        Effect.gen(function* () {
          const { ownerActor } = yield* fixture()
          const probe = yield* ConnectionProbe
          yield* Ref.set(probe.step, expected)
          const auth = AuthState.Person({
            person: ownerActor.person,
            workspace: ownerActor.workspace,
            sessionId: SessionId.make('resume-session'),
          })
          const begun = yield* connectionHandlers
            .BeginConnection({ from: 'Web', service: serviceId, name: null, shared: false })
            .pipe(Effect.provideService(AuthContext, auth))
          const store = yield* ConnectionStore
          const before = yield* store.get(ownerActor, begun.connection.id)
          const begins = yield* Ref.get(probe.begins)
          const resumed = yield* connectionHandlers
            .ResumeConnection({ from: 'Web', id: begun.connection.id })
            .pipe(Effect.provideService(AuthContext, auth))
          expect(resumed._tag).toBe(expected)
          expect(resumed.connection.id).toBe(begun.connection.id)
          expect((yield* store.list(ownerActor)).connections).toHaveLength(1)
          expect(yield* Ref.get(probe.begins)).toBe(begins)
          const after = yield* store.get(ownerActor, begun.connection.id)
          expect(after.references.app).toBe(before.references.app)
          expect(after.references.app).toBe(before.references.app)
          if (ConnectionStep.guards.OpenSignIn(resumed) && ConnectionStep.guards.OpenSignIn(begun))
            expect(resumed.address).not.toBe(begun.address)
          if (ConnectionStep.guards.EnterKey(resumed))
            expect(resumed.fields).toEqual([{ name: 'key', label: 'Key' }])
          yield* Ref.set(probe.step, 'Done')
        }),
      )
    }
    it.effect(
      'refuses known missing installation setup without renewing the provider request',
      () =>
        Effect.gen(function* () {
          const { ownerActor } = yield* fixture()
          const probe = yield* ConnectionProbe
          yield* Ref.set(probe.step, 'OpenSignIn')
          const begun = yield* (yield* ConnectionStore).begin(ownerActor, {
            from: 'Web',
            service: serviceId,
            name: 'Setup required',
            shared: false,
          })
          const executor = yield* Executor
          const setup = Executor.of({
            ...executor,
            catalog: Effect.suspend(() =>
              Effect.succeed([
                ExecutorServiceEntry.make({
                  id: serviceId,
                  name: 'Records',
                  description: 'Records',
                  domain: null,
                  authorization: ServiceAuthorization.cases.SetupRequired.make({}),
                }),
              ]),
            ).pipe(Effect.withSpan('Executor.Test.setupCatalog')),
          })
          const auth = AuthState.Person({
            person: ownerActor.person,
            workspace: ownerActor.workspace,
            sessionId: SessionId.make('setup-session'),
          })
          expect(
            yield* Effect.gen(function* () {
              // Bind resume to the authority that records whether setup is renewed.
              const context = yield* Layer.build(Layer.fresh(connectionStoreLayer))
              return yield* connectionHandlers
                .ResumeConnection({ from: 'Web', id: begun.connection.id })
                .pipe(Effect.provide(context))
            }).pipe(
              Effect.scoped,
              Effect.provideService(Executor, setup),
              Effect.provideService(AuthContext, auth),
              Effect.flip,
            ),
          ).toEqual(new InvalidRequest({ message: connectionSetupMessage }))
          yield* Ref.set(probe.step, 'Done')
        }),
    )
    it.effect(
      'persists replacement authorization and publishes its owner topic when the address response is lost',
      () =>
        Effect.gen(function* () {
          const { ownerActor } = yield* fixture()
          const probe = yield* ConnectionProbe
          yield* Ref.set(probe.step, 'OpenSignIn')
          const store = yield* ConnectionStore
          const begun = yield* store.begin(ownerActor, {
            from: 'Web',
            service: serviceId,
            name: 'Lost renewal',
            shared: false,
          })
          const row = yield* store.get(ownerActor, begun.connection.id)
          const pending = ExecutorReferences.cases.SigningIn.make({
            service: row.service,
            app: row.references.app,
            binding: row.references.binding,
            owner: row.references.owner,

            authorization: ExecutorAuthorizationId.make('retained-renewal'),
          })
          const executor = yield* Executor
          const lost = Executor.of({
            ...executor,
            reauthorize: Effect.fn('Executor.Test.lostRenewal')(() =>
              Effect.fail(ExecutorAuthorizationUnavailable.make({ references: pending })),
            ),
          })
          const topics = yield* Ref.make<readonly Topic[]>([])
          const changes = yield* Changes
          const recording = Changes.of({
            ...changes,
            publish: Effect.fn('Changes.Test.record')((published) =>
              Ref.update(topics, (current) => [...current, ...published]),
            ),
          })
          const auth = AuthState.Person({
            person: ownerActor.person,
            workspace: ownerActor.workspace,
            sessionId: SessionId.make('lost-session'),
          })
          const failure = yield* Effect.gen(function* () {
            // Capture the lost-response adapter before checking persisted replacement authorization.
            const context = yield* Layer.build(Layer.fresh(connectionStoreLayer))
            return yield* connectionHandlers
              .ResumeConnection({ from: 'Web', id: begun.connection.id })
              .pipe(Effect.provide(context))
          }).pipe(
            Effect.scoped,
            Effect.provideService(Executor, lost),
            Effect.provideService(Changes, recording),
            Effect.provideService(AuthContext, auth),
            Effect.flip,
          )
          expect(failure).toBeInstanceOf(ServiceUnavailable)
          expect((yield* store.get(ownerActor, begun.connection.id)).references).toEqual(pending)
          expect(yield* Ref.get(topics)).toContain(Topic.person(ownerActor.person.id))
          expect((yield* store.list(ownerActor)).connections).toHaveLength(1)
          yield* Ref.set(probe.step, 'Done')
        }),
    )
    it.effect('refuses strangers and non-admin shared management exactly as removal does', () =>
      Effect.gen(function* () {
        const { ownerActor, memberActor } = yield* fixture()
        const store = yield* ConnectionStore
        const probe = yield* ConnectionProbe
        yield* Ref.set(probe.step, 'OpenSignIn')
        const personal = yield* store.begin(ownerActor, {
          from: 'Web',
          service: serviceId,
          name: 'Private',
          shared: false,
        })
        const shared = yield* store.begin(ownerActor, {
          from: 'Web',
          service: serviceId,
          name: 'Shared',
          shared: true,
        })
        const auth = AuthState.Person({
          person: memberActor.person,
          workspace: memberActor.workspace,
          sessionId: SessionId.make('member-session'),
        })
        const refusal = yield* connectionHandlers
          .ResumeConnection({ from: 'Web', id: personal.connection.id })
          .pipe(Effect.provideService(AuthContext, auth), Effect.flip)
        expect(refusal).toBeInstanceOf(NotFound)
        expect(
          yield* connectionHandlers
            .ResumeConnection({ from: 'Web', id: shared.connection.id })
            .pipe(Effect.provideService(AuthContext, auth), Effect.flip),
        ).toBeInstanceOf(Forbidden)
        yield* Ref.set(probe.step, 'Done')
      }),
    )
    it.effect('returns Done when authorization completed while the dialog was closed', () =>
      Effect.gen(function* () {
        const { ownerActor } = yield* fixture()
        const probe = yield* ConnectionProbe
        yield* Ref.set(probe.step, 'OpenSignIn')
        const store = yield* ConnectionStore
        const begun = yield* store.begin(ownerActor, {
          from: 'Web',
          service: serviceId,
          name: 'Completed',
          shared: false,
        })
        yield* Ref.set(probe.step, 'Done')
        const auth = AuthState.Person({
          person: ownerActor.person,
          workspace: ownerActor.workspace,
          sessionId: SessionId.make('completed-session'),
        })
        const resumed = yield* connectionHandlers
          .ResumeConnection({ from: 'Web', id: begun.connection.id })
          .pipe(Effect.provideService(AuthContext, auth))
        expect(ConnectionStep.guards.Done(resumed)).toBe(true)
        expect(resumed.connection.id).toBe(begun.connection.id)
        expect(resumed.connection.state._tag).toBe('Ready')
      }),
    )
  })
})

describe.skipIf(!testDatabaseConfigured)('Connection tools through real inventory', () => {
  layer(connectionTestLayer)((it) => {
    it.effect('offers a service whose only Connection has failed', () =>
      Effect.gen(function* () {
        const { ownerActor, threadId } = yield* fixture()
        const store = yield* ConnectionStore
        const step = yield* store.begin(ownerActor, {
          from: 'Web',
          service: serviceId,
          name: 'Failed',
          shared: false,
        })
        yield* store.failed(
          ownerActor,
          yield* store.get(ownerActor, step.connection.id),
          'Provider removed',
        )
        const found = yield* connectionHandlers.FindTools({ query: 'records' }).pipe(
          Effect.provideService(
            AuthContext,
            AuthState.Vivid({
              person: ownerActor.person,
              workspace: ownerActor.workspace,
              threadId,
            }),
          ),
        )
        expect(found.unconnected.map((entry) => entry.id)).toContain(serviceId)
      }),
    )
    it.effect('records an approved action as Failed when discovery fails before dispatch', () =>
      Effect.gen(function* () {
        const { ownerActor } = yield* fixture()
        const store = yield* ConnectionStore
        const probe = yield* ConnectionProbe
        const begun = yield* store.begin(ownerActor, {
          from: 'Web',
          service: serviceId,
          name: 'Unavailable discovery',
          shared: false,
        })
        const executor = yield* Executor
        const calls = yield* Ref.get(probe.calls)
        const unavailable = Executor.of({
          ...executor,
          tools: Effect.fn('Executor.Test.discoveryUnavailable')(() =>
            Effect.fail(
              ServiceUnavailable.make({ service: 'connections', message: 'Discovery unavailable' }),
            ),
          ),
        })
        const outcome = yield* Effect.gen(function* () {
          // The approved action store must retain the failing discovery adapter.
          const context = yield* Layer.build(Layer.fresh(connectionStoreLayer))
          return yield* connectionRunner({
            person: ownerActor.person,
            workspace: ownerActor.workspace,
            target: ActionTarget.cases.Connection.make({
              connectionId: begun.connection.id,
              account: 'Unavailable discovery',
              tool: 'read',
              input: {},
            }),
          }).pipe(Effect.provide(context))
        }).pipe(Effect.scoped, Effect.provideService(Executor, unavailable))
        expect(outcome._tag).toBe('Failed')
        expect(yield* Ref.get(probe.calls)).toBe(calls)
      }),
    )
    it.effect('refuses another Person’s personal account before gate or dispatch', () =>
      Effect.gen(function* () {
        const { ownerActor, memberActor, threadId } = yield* fixture()
        const store = yield* ConnectionStore
        const probe = yield* ConnectionProbe
        const step = yield* store.begin(ownerActor, {
          from: 'Web',
          service: serviceId,
          name: 'Private',
          shared: false,
        })
        const calls = yield* Ref.get(probe.calls)
        const checks = yield* Ref.get(probe.checked)
        const outcome = yield* connectionHandlers
          .UseTool(toolRequest(step.connection.id, 'read'))
          .pipe(
            Effect.provideService(
              AuthContext,
              AuthState.Vivid({
                person: memberActor.person,
                workspace: memberActor.workspace,
                threadId,
              }),
            ),
          )
        expect(outcome._tag).toBe('Rejected')
        expect(yield* Ref.get(probe.calls)).toBe(calls)
        expect(yield* Ref.get(probe.checked)).toEqual(checks)
      }),
    )
    it.effect('lets a Member read shared accounts but rejects writes before the gate', () =>
      Effect.gen(function* () {
        const { ownerActor, memberActor, threadId } = yield* fixture()
        const store = yield* ConnectionStore
        const probe = yield* ConnectionProbe
        yield* Ref.set(probe.decision, 'Allowed')
        const step = yield* store.begin(ownerActor, {
          from: 'Web',
          service: serviceId,
          name: 'Shared',
          shared: true,
        })
        const auth = AuthState.Vivid({
          person: memberActor.person,
          workspace: memberActor.workspace,
          threadId,
        })
        const read = yield* connectionHandlers
          .UseTool(toolRequest(step.connection.id, 'read'))
          .pipe(Effect.provideService(AuthContext, auth))
        expect(read._tag).toBe('Completed')
        const before = yield* Ref.get(probe.checked)
        const calls = yield* Ref.get(probe.calls)
        const write = yield* connectionHandlers
          .UseTool(toolRequest(step.connection.id, 'write'))
          .pipe(Effect.provideService(AuthContext, auth))
        expect(write._tag).toBe('Rejected')
        expect(JSON.stringify(write)).toContain('read-only')
        expect(yield* Ref.get(probe.checked)).toEqual(before)
        expect(yield* Ref.get(probe.calls)).toBe(calls)
        const found = yield* connectionHandlers
          .FindTools({ query: 'records' })
          .pipe(Effect.provideService(AuthContext, auth))
        expect(found.tools.map((tool) => tool.name)).toEqual(['read'])
        expect(found.tools[0]).toMatchObject({ account: 'Records (Shared)', effect: 'read' })
      }),
    )
    it.effect('asks for personal exposure and never dispatches blocked or pending actions', () =>
      Effect.gen(function* () {
        const { ownerActor, threadId } = yield* fixture()
        const store = yield* ConnectionStore
        const probe = yield* ConnectionProbe
        const step = yield* store.begin(ownerActor, {
          from: 'Web',
          service: serviceId,
          name: 'Personal',
          shared: false,
        })
        const auth = AuthState.Vivid({
          person: ownerActor.person,
          workspace: ownerActor.workspace,
          threadId,
        })
        const calls = yield* Ref.get(probe.calls)
        yield* Ref.set(probe.decision, 'Blocked')
        expect(
          (yield* connectionHandlers
            .UseTool(toolRequest(step.connection.id, 'read'))
            .pipe(Effect.provideService(AuthContext, auth)))._tag,
        ).toBe('Blocked')
        yield* Ref.set(probe.decision, 'ApprovalRequired')
        expect(
          (yield* connectionHandlers
            .UseTool(toolRequest(step.connection.id, 'write'))
            .pipe(Effect.provideService(AuthContext, auth)))._tag,
        ).toBe('ApprovalRequired')
        expect(yield* Ref.get(probe.calls)).toBe(calls)
        const checks = yield* Ref.get(probe.checked)
        expect(checks.slice(-2).map((entry) => entry.exposure)).toEqual([
          'PersonalInShared',
          'PersonalInShared',
        ])
        expect(checks.at(-1)).toMatchObject({ action: { effect: 'write' } })
      }),
    )
    it.effect('marks revoked authorization and rejects a removed account after Approval', () =>
      Effect.gen(function* () {
        const { ownerActor, threadId } = yield* fixture()
        const store = yield* ConnectionStore
        const probe = yield* ConnectionProbe
        yield* Ref.set(probe.decision, 'Allowed')
        yield* Ref.set(probe.outcome, ExecutorCallOutcome.cases.NotReady.make({}))
        const step = yield* store.begin(ownerActor, {
          from: 'Web',
          service: serviceId,
          name: 'Revoked',
          shared: false,
        })
        const auth = AuthState.Vivid({
          person: ownerActor.person,
          workspace: ownerActor.workspace,
          threadId,
        })
        expect(
          (yield* connectionHandlers
            .UseTool(toolRequest(step.connection.id, 'read'))
            .pipe(Effect.provideService(AuthContext, auth)))._tag,
        ).toBe('ConnectionNotReady')
        expect((yield* store.get(ownerActor, step.connection.id)).status).toBe(
          'needs-authorization',
        )
        yield* store.remove(ownerActor, step.connection.id)
        const calls = yield* Ref.get(probe.calls)
        const outcome = yield* connectionRunner({
          person: ownerActor.person,
          workspace: ownerActor.workspace,
          target: ActionTarget.cases.Connection.make({
            connectionId: step.connection.id,
            account: 'Revoked',
            tool: 'read',
            input: {},
          }),
        })
        expect(outcome._tag).toBe('Failed')
        expect(yield* Ref.get(probe.calls)).toBe(calls)
        yield* Ref.set(
          probe.outcome,
          ExecutorCallOutcome.cases.Completed.make({ value: { ok: true } }),
        )
      }),
    )
    it.effect(
      'persists deleted provider resources as failed and propagates installation authority failures',
      () =>
        Effect.gen(function* () {
          const { ownerActor, threadId } = yield* fixture()
          const store = yield* ConnectionStore
          const probe = yield* ConnectionProbe
          yield* Ref.set(probe.decision, 'Allowed')
          const step = yield* store.begin(ownerActor, {
            from: 'Web',
            service: serviceId,
            name: 'Deleted resource',
            shared: false,
          })
          const auth = AuthState.Vivid({
            person: ownerActor.person,
            workspace: ownerActor.workspace,
            threadId,
          })
          const executor = yield* Executor
          const missing = Executor.of({
            ...executor,
            call: Effect.fn('Executor.Test.missing')(() =>
              Effect.fail(
                ExecutorResourceMissing.make({
                  service: 'connections',
                  tool: 'read',
                  resource: 'App',
                }),
              ),
            ),
          })
          const outcome = yield* connectionHandlers
            .UseTool(toolRequest(step.connection.id, 'read'))
            .pipe(
              Effect.provideService(AuthContext, auth),
              Effect.provideService(Executor, missing),
            )
          expect(outcome._tag).toBe('Rejected')
          expect((yield* store.get(ownerActor, step.connection.id)).status).toBe('failed')
          const repeated = yield* connectionHandlers
            .UseTool(toolRequest(step.connection.id, 'read'))
            .pipe(Effect.provideService(AuthContext, auth))
          expect(repeated).toMatchObject({ message: 'The saved app no longer exists.' })
          const approved = yield* connectionRunner({
            person: ownerActor.person,
            workspace: ownerActor.workspace,
            target: ActionTarget.cases.Connection.make({
              connectionId: step.connection.id,
              account: 'Deleted resource',
              tool: 'read',
              input: {},
            }),
          })
          expect(approved).toMatchObject({ reason: 'The saved app no longer exists.' })

          const ready = yield* store.begin(ownerActor, {
            from: 'Web',
            service: serviceId,
            name: 'Misconfigured installation',
            shared: false,
          })
          const denied = Executor.of({
            ...executor,
            call: Effect.fn('Executor.Test.denied')(() =>
              Effect.fail(ExecutorAccessDenied.make({ service: 'connections', tool: 'read' })),
            ),
          })
          const failure = yield* connectionHandlers
            .UseTool(toolRequest(ready.connection.id, 'read'))
            .pipe(
              Effect.provideService(AuthContext, auth),
              Effect.provideService(Executor, denied),
              Effect.flip,
            )
          expect(failure).toBeInstanceOf(ServiceUnavailable)
          expect((yield* store.get(ownerActor, ready.connection.id)).status).toBe('ready')
        }),
    )
    it.effect('refuses unsupported provider approvals and reports uncertain execution', () =>
      Effect.gen(function* () {
        const { ownerActor, threadId } = yield* fixture()
        const store = yield* ConnectionStore
        const probe = yield* ConnectionProbe
        const step = yield* store.begin(ownerActor, {
          from: 'Web',
          service: serviceId,
          name: 'Approved account',
          shared: false,
        })
        const auth = AuthState.Vivid({
          person: ownerActor.person,
          workspace: ownerActor.workspace,
          threadId,
        })
        yield* Ref.set(probe.decision, 'Allowed')
        const executor = yield* Executor
        const refused = Executor.of({
          ...executor,
          call: () => Effect.fail(new ExecutorApprovalUnsupported({ tool: 'write' })),
        })
        const failure = yield* connectionHandlers
          .UseTool(toolRequest(step.connection.id, 'write'))
          .pipe(
            Effect.provideService(AuthContext, auth),
            Effect.provideService(Executor, refused),
            Effect.flip,
          )
        expect(failure).toHaveProperty('_tag', 'InvalidRequest')
        expect(failure).toHaveProperty(
          'message',
          'This Integration action needs an approval Vivid cannot give yet.',
        )
        yield* Ref.set(probe.outcome, ExecutorCallOutcome.cases.OutcomeUnknown.make({}))
        const before = yield* Ref.get(probe.calls)
        const uncertain = yield* connectionHandlers
          .UseTool(toolRequest(step.connection.id, 'write'))
          .pipe(Effect.provideService(AuthContext, auth))
        expect(uncertain._tag).toBe('OutcomeUnknown')
        expect(yield* Ref.get(probe.calls)).toBe(before + 1)
        const absent = yield* connectionHandlers
          .UseTool(toolRequest(step.connection.id, 'absent-tool'))
          .pipe(Effect.provideService(AuthContext, auth))
        expect(absent._tag).toBe('Rejected')
        expect(JSON.stringify(absent)).toContain('absent-tool')
        yield* Ref.set(
          probe.outcome,
          ExecutorCallOutcome.cases.Completed.make({ value: { ok: true } }),
        )
      }),
    )
  })
})
