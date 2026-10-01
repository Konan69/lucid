import { describe, expect, layer } from '@effect/vitest'
import { Effect, Ref } from 'effect'
import {
  ConnectionId,
  Forbidden,
  ServiceUnavailable,
  Person,
  PersonId,
  SessionId,
  Workspace,
  ActionTarget,
} from '@vivid/contracts'
import { AuthContext, AuthState } from '@vivid/contracts/auth'
import { testDatabaseConfigured } from '../database/testdb.ts'
import { connectionHandlers, connectionRunner } from './handlers.ts'
import { ConnectionStore } from './store.ts'
import {
  Executor,
  ExecutorAccessDenied,
  ExecutorCallOutcome,
  ExecutorRequestId,
  ExecutorResourceMissing,
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
    it.effect('reserves UseTool for Vivid before acquiring any store authority', () =>
      Effect.gen(function* () {
        const failure = yield* connectionHandlers
          .UseTool(toolRequest(ConnectionId.make('absent'), 'read'))
          .pipe(Effect.provideService(AuthContext, personAuth), Effect.flip)
        expect(failure).toBeInstanceOf(Forbidden)
      }),
    )
  })
})

describe.skipIf(!testDatabaseConfigured)('Connection tools through real inventory', () => {
  layer(connectionTestLayer)((it) => {
    it.effect('refuses another Person’s personal account before gate or dispatch', () =>
      Effect.gen(function* () {
        const { ownerActor, memberActor, threadId } = yield* fixture()
        const store = yield* ConnectionStore
        const probe = yield* ConnectionProbe
        const step = yield* store.begin(ownerActor, {
          service: serviceId,
          label: 'Private',
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
          service: serviceId,
          label: 'Shared',
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
        const write = yield* connectionHandlers
          .UseTool(toolRequest(step.connection.id, 'write'))
          .pipe(Effect.provideService(AuthContext, auth))
        expect(write._tag).toBe('Rejected')
        expect(JSON.stringify(write)).toContain('read-only')
        expect(yield* Ref.get(probe.checked)).toEqual(before)
        const found = yield* connectionHandlers
          .FindTools({ query: 'records' })
          .pipe(Effect.provideService(AuthContext, auth))
        expect(found.tools.map((tool) => tool.name)).toEqual(['read'])
        expect(found.tools[0]).toMatchObject({ account: 'Shared', effect: 'read' })
      }),
    )
    it.effect('asks for personal exposure and never dispatches blocked or pending actions', () =>
      Effect.gen(function* () {
        const { ownerActor, threadId } = yield* fixture()
        const store = yield* ConnectionStore
        const probe = yield* ConnectionProbe
        const step = yield* store.begin(ownerActor, {
          service: serviceId,
          label: 'Personal',
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
          service: serviceId,
          label: 'Revoked',
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
            service: serviceId,
            label: 'Deleted resource',
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
            service: serviceId,
            label: 'Misconfigured installation',
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
    it.effect(
      'resumes provider consent only after Vivid allows it and reports uncertain execution',
      () =>
        Effect.gen(function* () {
          const { ownerActor, threadId } = yield* fixture()
          const store = yield* ConnectionStore
          const probe = yield* ConnectionProbe
          const step = yield* store.begin(ownerActor, {
            service: serviceId,
            label: 'Approved account',
            shared: false,
          })
          const auth = AuthState.Vivid({
            person: ownerActor.person,
            workspace: ownerActor.workspace,
            threadId,
          })
          yield* Ref.set(probe.decision, 'Allowed')
          yield* Ref.set(
            probe.outcome,
            ExecutorCallOutcome.cases.ApprovalRequired.make({
              requestId: ExecutorRequestId.make('provider-approval'),
              expiresAt: 100_000,
            }),
          )
          const resumed = yield* connectionHandlers
            .UseTool(toolRequest(step.connection.id, 'write'))
            .pipe(Effect.provideService(AuthContext, auth))
          expect(resumed).toMatchObject({ output: { resumed: true } })
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
