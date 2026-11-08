import { describe, expect, layer } from '@effect/vitest'
import { Clock, Deferred, Effect, Fiber, Layer, Logger, Predicate, Ref, Schema } from 'effect'
import { ScriptedAnswer } from '../decisions/testing.ts'
import { DecisionModel } from 'effect/ai'
import { RELEVANCE_BUDGET } from './relevance.ts'
import { ToolEffects, toolEffectsLayer } from './effects.ts'
import * as TestClock from 'effect/testing/TestClock'
import {
  ActionTarget,
  ConnectionStep,
  Conflict,
  InvalidRequest,
  ServiceUnavailable,
  ToolOutcome,
} from '@vivid/contracts'
import { Message } from '../observability/messages.ts'
import { ActionOutcome } from '../approvals/gate.ts'
import { testDatabaseConfigured } from '../database/testdb.ts'
import {
  Executor,
  ExecutorCallOutcome,
  ExecutorNotReady,
  ExecutorResourceMissing,
  ExecutorTool,
} from './executor.ts'
import { ConnectionStore, ToolDiscovery, connectionStoreLayer } from './store.ts'
import { ConnectionProbe, connectionTestLayer, fixture, serviceId } from './testing.ts'
import { connectionRunner, findTools, resolveTool, useTool } from './tools.ts'

/** Each refusal assertion owns its recorder; the current loggers are retained when the capture is provided. */
const refusalLogs = () => {
  const lines: string[] = []
  return {
    capture: Logger.make((entry) => lines.push(Logger.formatSimple.log(entry))),
    recorded: () => lines.filter((line) => line.includes(Message.refusal)),
  }
}

/** Discovery uses real scoped records; suffixes must remain stable across ranking queries and ownership. */
describe.skipIf(!testDatabaseConfigured)('Connection account names', () => {
  layer(connectionTestLayer)((it) => {
    /** Exercise admission refusals and provider rejection through useTool, retaining real scope/state reads. */
    it.effect.each([
      'IntegrationUnavailable',
      'IntegrationFailed',
      'ToolUnknown',
      'SharedReadOnly',
      'ServiceRejected',
    ])('records %s at the tool decision without private input or service prose', (reason) => {
      const logs = refusalLogs()
      return Effect.gen(function* () {
        const context = yield* Logger.CurrentLoggers
        return yield* Effect.gen(function* () {
          const { ownerActor, memberActor } = yield* fixture()
          const store = yield* ConnectionStore
          const probe = yield* ConnectionProbe
          const previous = yield* Ref.get(probe.outcome)
          const checked = yield* Ref.get(probe.checked)
          // The shared Layer survives this test; restore its next reply and Gate observations.
          yield* Effect.addFinalizer(() =>
            Ref.set(probe.outcome, previous).pipe(Effect.andThen(Ref.set(probe.checked, checked))),
          )
          const step = yield* store.begin(ownerActor, {
            from: 'Web',
            service: serviceId,
            name: 'Private account',
            shared: reason === 'SharedReadOnly',
          })
          const row = yield* store.get(ownerActor, step.connection.id)
          const calls = yield* Ref.get(probe.calls)
          if (reason === 'IntegrationFailed')
            yield* store.failed(ownerActor, row, 'Private service failure')
          if (reason === 'ServiceRejected')
            yield* Ref.set(
              probe.outcome,
              ExecutorCallOutcome.cases.Rejected.make({ message: 'Private service refusal' }),
            )
          const { outcome } = yield* useTool(
            reason === 'IntegrationUnavailable' || reason === 'SharedReadOnly'
              ? memberActor
              : ownerActor,
            {
              connectionId: row.id,
              tool: reason === 'ToolUnknown' ? 'private_missing_tool' : 'write',
              input: { private: 'Private tool input' },
              summary: 'Private summary',
              rationale: 'Private rationale',
            },
          )
          expect(ToolOutcome.guards.Rejected(outcome)).toBe(true)
          expect(yield* Ref.get(probe.calls)).toBe(calls + (reason === 'ServiceRejected' ? 1 : 0))
          const recorded = logs.recorded()
          expect(recorded).toHaveLength(1)
          expect(recorded[0]).toContain('vivid.refusal.kind=ToolRejected')
          expect(recorded[0]).toContain(`vivid.refusal.reason=${reason}`)
          expect(recorded[0]).not.toContain('Private')
          expect(recorded[0]).not.toContain('private_missing_tool')
        }).pipe(Effect.provideService(Logger.CurrentLoggers, new Set([...context, logs.capture])))
      }).pipe(Effect.scoped)
    })

    /** A missing foreign resource is Vivid's durable Integration failure, not a service rejection. */
    it.effect('records IntegrationFailed when execution loses its resource', () => {
      const logs = refusalLogs()
      return Effect.gen(function* () {
        const context = yield* Logger.CurrentLoggers
        return yield* Effect.gen(function* () {
          const { ownerActor } = yield* fixture()
          const store = yield* ConnectionStore
          const probe = yield* ConnectionProbe
          const checked = yield* Ref.get(probe.checked)
          yield* Effect.addFinalizer(() => Ref.set(probe.checked, checked))
          const step = yield* store.begin(ownerActor, {
            from: 'Web',
            service: serviceId,
            name: 'Work',
            shared: false,
          })
          const executor = yield* Executor
          const { outcome } = yield* useTool(ownerActor, {
            connectionId: step.connection.id,
            tool: 'read',
            input: {},
            summary: 'Read',
            rationale: '',
          }).pipe(
            Effect.provideService(
              Executor,
              Executor.of({
                ...executor,
                call: () =>
                  Effect.fail(
                    new ExecutorResourceMissing({
                      service: 'connections',
                      tool: 'read',
                      resource: 'App',
                    }),
                  ),
              }),
            ),
          )
          expect(ToolOutcome.guards.Rejected(outcome)).toBe(true)
          expect((yield* store.get(ownerActor, step.connection.id)).status).toBe('failed')
          expect(logs.recorded()).toHaveLength(1)
          expect(logs.recorded()[0]).toContain('vivid.refusal.reason=IntegrationFailed')
          expect(logs.recorded()[0]).not.toContain('ServiceRejected')
        }).pipe(Effect.provideService(Logger.CurrentLoggers, new Set([...context, logs.capture])))
      }).pipe(Effect.scoped)
    })

    /** Discovery must distinguish a newly failed Integration from an empty ready catalog. */
    it.effect.each(['direct', 'approved'] as const)(
      'records IntegrationFailed once when %s discovery loses its resource',
      (caller) => {
        const logs = refusalLogs()
        return Effect.gen(function* () {
          const context = yield* Logger.CurrentLoggers
          return yield* Effect.gen(function* () {
            const { ownerActor } = yield* fixture()
            const store = yield* ConnectionStore
            const step = yield* store.begin(ownerActor, {
              from: 'Web',
              service: serviceId,
              name: 'Work',
              shared: false,
            })
            const executor = yield* Executor
            const target = ActionTarget.cases.Connection.make({
              connectionId: step.connection.id,
              account: 'Records (Work)',
              tool: 'read',
              input: {},
            })
            const calls = yield* Ref.get((yield* ConnectionProbe).calls)
            const outcome = yield* Effect.gen(function* () {
              // Capture the missing-resource discovery adapter so the stored failure is observed by both callers.
              const context = yield* Layer.build(Layer.fresh(connectionStoreLayer))
              return yield* Effect.gen(function* () {
                if (caller === 'approved')
                  return yield* connectionRunner({
                    person: ownerActor.person,
                    workspace: ownerActor.workspace,
                    target,
                  })
                return (yield* useTool(ownerActor, { ...target, summary: 'Read', rationale: '' }))
                  .outcome
              }).pipe(Effect.provide(context))
            }).pipe(
              Effect.scoped,
              Effect.provideService(
                Executor,
                Executor.of({
                  ...executor,
                  tools: () =>
                    Effect.fail(
                      new ExecutorResourceMissing({
                        service: 'connections',
                        tool: 'read',
                        resource: 'App',
                      }),
                    ),
                }),
              ),
            )
            expect(outcome).toEqual(
              caller === 'approved'
                ? ActionOutcome.cases.Failed.make({
                    reason: 'This tool is no longer available on this integration.',
                  })
                : ToolOutcome.cases.Rejected.make({
                    message: 'Tool read is not available on this integration.',
                  }),
            )
            expect((yield* store.get(ownerActor, step.connection.id)).status).toBe('failed')
            expect(yield* Ref.get((yield* ConnectionProbe).calls)).toBe(calls)
            expect(logs.recorded()).toHaveLength(1)
            expect(logs.recorded()[0]).toContain('vivid.refusal.reason=IntegrationFailed')
          }).pipe(Effect.provideService(Logger.CurrentLoggers, new Set([...context, logs.capture])))
        }).pipe(Effect.scoped)
      },
    )

    /** Approved actions recheck the same admission rules before sending any provider action. */
    it.effect.each([
      'IntegrationUnavailable',
      'IntegrationFailed',
      'NeedsAuthorization',
      'ToolUnknown',
      'SharedReadOnly',
    ] as const)('approved execution records %s once before dispatch', (reason) => {
      const logs = refusalLogs()
      return Effect.gen(function* () {
        const context = yield* Logger.CurrentLoggers
        return yield* Effect.gen(function* () {
          const { ownerActor, memberActor } = yield* fixture()
          const store = yield* ConnectionStore
          const probe = yield* ConnectionProbe
          const calls = yield* Ref.get(probe.calls)
          const step = yield* store.begin(ownerActor, {
            from: 'Web',
            service: serviceId,
            name: 'Work',
            shared: reason === 'SharedReadOnly',
          })
          const row = yield* store.get(ownerActor, step.connection.id)
          if (reason === 'IntegrationFailed')
            yield* store.failed(ownerActor, row, 'Private failure')
          if (reason === 'NeedsAuthorization') yield* store.notReady(ownerActor, row)
          const outcome = yield* connectionRunner({
            person: reason === 'IntegrationUnavailable' ? memberActor.person : ownerActor.person,
            workspace: ownerActor.workspace,
            target: ActionTarget.cases.Connection.make({
              connectionId: row.id,
              account: 'Records (Work)',
              tool: reason === 'ToolUnknown' ? 'missing' : 'write',
              input: {},
            }),
          })
          const expected = {
            IntegrationUnavailable:
              'The integration is no longer available; check its authorization and your access.',
            IntegrationFailed: 'Private failure',
            NeedsAuthorization: 'This integration needs authorization.',
            ToolUnknown: 'This tool is no longer available on this integration.',
            SharedReadOnly: 'This tool is no longer available on this integration.',
          }
          expect(outcome).toEqual(ActionOutcome.cases.Failed.make({ reason: expected[reason] }))
          expect(yield* Ref.get(probe.calls)).toBe(calls)
          expect(logs.recorded()).toHaveLength(1)
          if (reason === 'NeedsAuthorization') {
            expect(logs.recorded()[0]).toContain('vivid.refusal.kind=IntegrationNotReady')
            expect(logs.recorded()[0]).toContain(`vivid.refusal.service=${serviceId}`)
          } else {
            expect(logs.recorded()[0]).toContain('vivid.refusal.kind=ToolRejected')
            expect(logs.recorded()[0]).toContain(`vivid.refusal.reason=${reason}`)
          }
          expect(logs.recorded()[0]).not.toContain('Private failure')
        }).pipe(Effect.provideService(Logger.CurrentLoggers, new Set([...context, logs.capture])))
      }).pipe(Effect.scoped)
    })

    /** Discovery failures must retain the approved caller's pre-recording outcomes and prose. */
    it.effect.each([
      new InvalidRequest({ message: 'Private catalog failure' }),
      new Conflict({ message: 'Private catalog conflict' }),
    ])('approved discovery preserves $_tag outcome and reason', (error) => {
      const logs = refusalLogs()
      return Effect.gen(function* () {
        const context = yield* Logger.CurrentLoggers
        return yield* Effect.gen(function* () {
          const { ownerActor } = yield* fixture()
          const store = yield* ConnectionStore
          const step = yield* store.begin(ownerActor, {
            from: 'Web',
            service: serviceId,
            name: 'Work',
            shared: false,
          })
          const probe = yield* ConnectionProbe
          const calls = yield* Ref.get(probe.calls)
          const outcome = yield* connectionRunner({
            person: ownerActor.person,
            workspace: ownerActor.workspace,
            target: ActionTarget.cases.Connection.make({
              connectionId: step.connection.id,
              account: 'Records (Work)',
              tool: 'read',
              input: {},
            }),
          }).pipe(
            Effect.provideService(
              ConnectionStore,
              ConnectionStore.of({
                ...store,
                tools: () => Effect.fail(error),
              }),
            ),
          )
          const expected =
            error instanceof Conflict
              ? ActionOutcome.cases.Unknown.make({})
              : ActionOutcome.cases.Failed.make({ reason: 'Private catalog failure' })
          expect(outcome).toEqual(expected)
          expect(yield* Ref.get(probe.calls)).toBe(calls)
          // A conflict leaves the action Unknown, and an uncertain action is not a refusal.
          if (error instanceof Conflict) {
            expect(logs.recorded()).toHaveLength(0)
            return
          }
          expect(logs.recorded()).toHaveLength(1)
          expect(logs.recorded()[0]).toContain('vivid.refusal.reason=IntegrationUnavailable')
        }).pipe(Effect.provideService(Logger.CurrentLoggers, new Set([...context, logs.capture])))
      }).pipe(Effect.scoped)
    })

    /** Pre-dispatch infrastructure loss is a retryable approved failure and one tool refusal. */
    it.effect('approved discovery ServiceUnavailable records IntegrationUnavailable once', () => {
      const logs = refusalLogs()
      return Effect.gen(function* () {
        const context = yield* Logger.CurrentLoggers
        return yield* Effect.gen(function* () {
          const { ownerActor } = yield* fixture()
          const store = yield* ConnectionStore
          const step = yield* store.begin(ownerActor, {
            from: 'Web',
            service: serviceId,
            name: 'Work',
            shared: false,
          })
          const calls = yield* Ref.get((yield* ConnectionProbe).calls)
          const outcome = yield* connectionRunner({
            person: ownerActor.person,
            workspace: ownerActor.workspace,
            target: ActionTarget.cases.Connection.make({
              connectionId: step.connection.id,
              account: 'Records (Work)',
              tool: 'read',
              input: {},
            }),
          }).pipe(
            Effect.provideService(
              ConnectionStore,
              ConnectionStore.of({
                ...store,
                tools: () =>
                  Effect.fail(
                    new ServiceUnavailable({
                      service: 'connections',
                      message: 'Private discovery outage',
                    }),
                  ),
              }),
            ),
          )
          expect(outcome).toEqual(
            ActionOutcome.cases.Failed.make({
              reason: 'Tool discovery failed before the action was sent. Retry discovery.',
            }),
          )
          expect(yield* Ref.get((yield* ConnectionProbe).calls)).toBe(calls)
          expect(logs.recorded()).toHaveLength(1)
          expect(logs.recorded()[0]).toContain('vivid.refusal.reason=IntegrationUnavailable')
          expect(logs.recorded()[0]).not.toContain('Private')
        }).pipe(Effect.provideService(Logger.CurrentLoggers, new Set([...context, logs.capture])))
      }).pipe(Effect.scoped)
    })

    /** A carried service rejection belongs to runConnection, even when an Approval invokes it. */
    it.effect('approved execution records ServiceRejected once after dispatch', () => {
      const logs = refusalLogs()
      return Effect.gen(function* () {
        const context = yield* Logger.CurrentLoggers
        return yield* Effect.gen(function* () {
          const { ownerActor } = yield* fixture()
          const store = yield* ConnectionStore
          const step = yield* store.begin(ownerActor, {
            from: 'Web',
            service: serviceId,
            name: 'Work',
            shared: false,
          })
          const probe = yield* ConnectionProbe
          const previous = yield* Ref.get(probe.outcome)
          yield* Effect.addFinalizer(() => Ref.set(probe.outcome, previous))
          yield* Ref.set(
            probe.outcome,
            ExecutorCallOutcome.cases.Rejected.make({ message: 'Private service refusal' }),
          )
          const calls = yield* Ref.get(probe.calls)
          const outcome = yield* connectionRunner({
            person: ownerActor.person,
            workspace: ownerActor.workspace,
            target: ActionTarget.cases.Connection.make({
              connectionId: step.connection.id,
              account: 'Records (Work)',
              tool: 'read',
              input: {},
            }),
          })
          expect(outcome).toEqual(
            ActionOutcome.cases.Failed.make({ reason: 'Private service refusal' }),
          )
          expect(yield* Ref.get(probe.calls)).toBe(calls + 1)
          expect(logs.recorded()).toHaveLength(1)
          expect(logs.recorded()[0]).toContain('vivid.refusal.reason=ServiceRejected')
          expect(logs.recorded()[0]).not.toContain('Private')
        }).pipe(Effect.provideService(Logger.CurrentLoggers, new Set([...context, logs.capture])))
      }).pipe(Effect.scoped)
    })

    /** Tool metadata can disappear before dispatch; the refusal belongs to this call. */
    it.effect('records unavailable tool discovery as IntegrationUnavailable', () => {
      const logs = refusalLogs()
      return Effect.gen(function* () {
        const context = yield* Logger.CurrentLoggers
        return yield* Effect.gen(function* () {
          const { ownerActor } = yield* fixture()
          const store = yield* ConnectionStore
          const step = yield* store.begin(ownerActor, {
            from: 'Web',
            service: serviceId,
            name: 'Work',
            shared: false,
          })
          const unavailable = ConnectionStore.of({
            ...store,
            tools: () => Effect.fail(new InvalidRequest({ message: 'Private catalog failure' })),
          })
          const { outcome } = yield* useTool(ownerActor, {
            connectionId: step.connection.id,
            tool: 'read',
            input: {},
            summary: 'Read',
            rationale: '',
          }).pipe(Effect.provideService(ConnectionStore, unavailable))
          expect(ToolOutcome.guards.Rejected(outcome)).toBe(true)
          const recorded = logs.recorded()
          expect(recorded).toHaveLength(1)
          expect(recorded[0]).toContain('vivid.refusal.kind=ToolRejected')
          expect(recorded[0]).toContain('vivid.refusal.reason=IntegrationUnavailable')
          expect(recorded[0]).not.toContain('Private catalog failure')
        }).pipe(Effect.provideService(Logger.CurrentLoggers, new Set([...context, logs.capture])))
      }).pipe(Effect.scoped)
    })

    /** Both stored and service-discovered authorization loss decide one NotReady per call. */
    it.effect.each(['stored', 'service'])(
      'records %s IntegrationNotReady once with its service identity',
      (source) => {
        const logs = refusalLogs()
        return Effect.gen(function* () {
          const context = yield* Logger.CurrentLoggers
          return yield* Effect.gen(function* () {
            const { ownerActor } = yield* fixture()
            const store = yield* ConnectionStore
            const probe = yield* ConnectionProbe
            const previous = yield* Ref.get(probe.outcome)
            const checked = yield* Ref.get(probe.checked)
            // The shared Layer survives this test; restore its next reply and Gate observations.
            yield* Effect.addFinalizer(() =>
              Ref.set(probe.outcome, previous).pipe(
                Effect.andThen(Ref.set(probe.checked, checked)),
              ),
            )
            const step = yield* store.begin(ownerActor, {
              from: 'Web',
              service: serviceId,
              name: 'Private account',
              shared: false,
            })
            const row = yield* store.get(ownerActor, step.connection.id)
            if (source === 'stored') yield* store.notReady(ownerActor, row)
            else yield* Ref.set(probe.outcome, ExecutorCallOutcome.cases.NotReady.make({}))
            const { outcome } = yield* useTool(ownerActor, {
              connectionId: row.id,
              tool: 'read',
              input: {},
              summary: 'Read',
              rationale: '',
            })
            expect(ToolOutcome.guards.ConnectionNotReady(outcome)).toBe(true)
            const recorded = logs.recorded()
            expect(recorded).toHaveLength(1)
            expect(recorded[0]).toContain('vivid.refusal.kind=IntegrationNotReady')
            expect(recorded[0]).toContain(`vivid.refusal.service=${serviceId}`)
            expect(recorded[0]).not.toContain('Private account')
          }).pipe(Effect.provideService(Logger.CurrentLoggers, new Set([...context, logs.capture])))
        }).pipe(Effect.scoped)
      },
    )
  })

  layer(connectionTestLayer)(
    'clock: ranks service and account words while withholding shared writes',
    (it) => {
      it.effect('ranks service and account words while withholding shared writes', () =>
        Effect.gen(function* () {
          const { ownerActor } = yield* fixture()
          const store = yield* ConnectionStore
          const probe = yield* ConnectionProbe
          const previousTools = yield* Ref.get(probe.tools)
          yield* Effect.addFinalizer(() => Ref.set(probe.tools, previousTools))
          yield* Ref.set(probe.tools, [
            ExecutorTool.make({
              name: 'write',
              description: 'Change entries',
              effect: 'write',
              input: {},
            }),
            ExecutorTool.make({
              name: 'read',
              description: 'Read entries',
              effect: 'read',
              input: {},
            }),
          ])
          yield* store.begin(ownerActor, {
            from: 'Web',
            service: serviceId,
            name: 'Work',
            shared: false,
          })
          yield* TestClock.adjust(1)
          yield* store.begin(ownerActor, {
            from: 'Web',
            service: serviceId,
            name: 'Team',
            shared: true,
          })
          const service = yield* findTools(ownerActor, { query: 'Records' })
          expect(service.tools.map((tool) => [tool.account, tool.name])).toEqual([
            ['Records (Work)', 'write'],
            ['Records (Work)', 'read'],
            ['Records (Team)', 'read'],
          ])
          const specific = yield* findTools(ownerActor, { query: 'Records read' })
          expect(specific.tools.map((tool) => tool.name)).toEqual(['read', 'read', 'write'])
          const account = yield* findTools(ownerActor, { query: 'Work' })
          expect(account.tools.map((tool) => tool.account)).toEqual([
            'Records (Work)',
            'Records (Work)',
          ])
          expect((yield* findTools(ownerActor, { query: 'unrelated' })).tools).toEqual([])
        }),
      )
    },
  )

  layer(connectionTestLayer)(
    'clock: a lapsed sign-in is saved at discovery and leaves the other accounts findable',
    (it) => {
      /** Production, 26 October 2026: Executor answered OAuthReconnectRequired for a Person's Gmail,
       * Vivid kept it Ready, and every find_tools failed for all of their Integrations. */
      it.effect(
        'a lapsed sign-in is saved at discovery and leaves the other accounts findable',
        () =>
          Effect.gen(function* () {
            const { ownerActor } = yield* fixture()
            const store = yield* ConnectionStore
            const lapsed = yield* store.begin(ownerActor, {
              from: 'Web',
              service: serviceId,
              name: 'Work',
              shared: false,
            })
            yield* TestClock.adjust(1)
            yield* store.begin(ownerActor, {
              from: 'Web',
              service: serviceId,
              name: 'Home',
              shared: false,
            })
            const lapsedReferences = JSON.stringify(
              (yield* store.get(ownerActor, lapsed.connection.id)).references,
            )
            const executor = yield* Executor
            const found = yield* Effect.gen(function* () {
              // The store holds the Executor it was built with, so it is built again over this one.
              const context = yield* Layer.build(Layer.fresh(connectionStoreLayer))
              return yield* findTools(ownerActor, { query: 'Records' }).pipe(
                Effect.provide(context),
              )
            }).pipe(
              Effect.scoped,
              Effect.provideService(
                Executor,
                Executor.of({
                  ...executor,
                  tools: (references) =>
                    JSON.stringify(references) === lapsedReferences
                      ? Effect.fail(ExecutorNotReady.make({ service: 'connections', tool: null }))
                      : executor.tools(references),
                }),
              ),
            )
            expect(new Set(found.tools.map((tool) => tool.account))).toEqual(
              new Set(['Records (Home)']),
            )
            expect((yield* store.get(ownerActor, lapsed.connection.id)).status).toBe(
              'needs-authorization',
            )
          }),
      )
    },
  )

  layer(connectionTestLayer)(
    'clock: keeps own-text matches ahead of identity noise and bounds a flooded service',
    (it) => {
      it.effect('keeps own-text matches ahead of identity noise and bounds a flooded service', () =>
        Effect.gen(function* () {
          const { ownerActor } = yield* fixture()
          const store = yield* ConnectionStore
          const probe = yield* ConnectionProbe
          const previous = yield* Ref.get(probe.tools)
          yield* Effect.addFinalizer(() => Ref.set(probe.tools, previous))
          yield* store.begin(ownerActor, {
            from: 'Web',
            service: serviceId,
            name: 'Work',
            shared: false,
          })
          yield* TestClock.adjust(1)
          const target = yield* store.begin(ownerActor, {
            from: 'Web',
            service: serviceId,
            name: 'Other',
            shared: false,
          })
          yield* Ref.set(probe.tools, [
            ...Array.from({ length: 59 }, (_, index) =>
              ExecutorTool.make({
                name: `operation_${index}`,
                description: 'Generic operation',
                effect: 'read',
                input: {},
              }),
            ),
            ExecutorTool.make({
              name: 'search',
              description: 'Search entries',
              effect: 'read',
              input: {},
            }),
          ])
          const found = yield* findTools(ownerActor, { query: 'how does search work', limit: 2 })
          expect(found.tools.map((tool) => tool.name)).toEqual(['search', 'search'])
          expect(found.tools[1]).toMatchObject({ connectionId: target.connection.id })
          const flood = yield* findTools(ownerActor, { query: 'Records search', limit: 25 })
          expect(flood.tools).toHaveLength(25)
          expect(flood.tools[0]).toMatchObject({ name: 'search' })
        }),
      )
    },
  )

  layer(connectionTestLayer)((it) => {
    it.effect(
      'resolves a tool beyond the ranked discovery limit and a name with no query words',
      () =>
        Effect.gen(function* () {
          const { ownerActor } = yield* fixture()
          const store = yield* ConnectionStore
          const probe = yield* ConnectionProbe
          const previousTools = yield* Ref.get(probe.tools)
          yield* Effect.addFinalizer(() => Ref.set(probe.tools, previousTools))
          yield* Ref.set(probe.tools, [
            ...Array.from({ length: 40 }, (_, index) =>
              ExecutorTool.make({
                name: `get_records_${index}`,
                description: 'Get records',
                effect: 'read',
                input: {},
              }),
            ),
            ExecutorTool.make({
              name: 'get_records_target',
              description: 'Get records',
              effect: 'read',
              input: {},
            }),
            ExecutorTool.make({ name: '---', description: '', effect: 'read', input: {} }),
          ])
          const connected = yield* store.begin(ownerActor, {
            from: 'Web',
            service: serviceId,
            name: null,
            shared: false,
          })
          const found = yield* findTools(ownerActor, { query: 'get records', limit: 25 })
          expect(found.tools).toHaveLength(25)
          expect(found.tools.some((tool) => tool.name === 'get_records_target')).toBe(false)
          for (const name of ['get_records_target', '---']) {
            const resolved = yield* resolveTool(ownerActor, { account: 'Records', tool: name })
            expect(resolved.connectionId).toBe(connected.connection.id)
            expect(resolved.name).toBe(name)
          }
          expect(
            (yield* Effect.flip(resolveTool(ownerActor, { account: 'Records', tool: 'missing' })))
              ._tag,
          ).toBe('NotFound')
        }),
    )
  })

  layer(connectionTestLayer)(
    'clock: distinguishes duplicate accounts by creation order before query filtering',
    (it) => {
      it.effect('distinguishes duplicate accounts by creation order before query filtering', () =>
        Effect.gen(function* () {
          const { ownerActor, memberActor } = yield* fixture()
          const store = yield* ConnectionStore
          const first = yield* store.begin(ownerActor, {
            from: 'Web',
            service: serviceId,
            name: 'Gmail (Gmail)',
            shared: false,
          })
          yield* TestClock.adjust(1)
          const second = yield* store.begin(ownerActor, {
            from: 'Web',
            service: serviceId,
            name: 'Gmail (Gmail)',
            shared: true,
          })
          yield* TestClock.adjust(1)
          yield* store.begin(memberActor, {
            from: 'Web',
            service: serviceId,
            name: 'Gmail (Gmail)',
            shared: false,
          })
          expect(ConnectionStep.guards.Done(first)).toBe(true)
          expect(ConnectionStep.guards.Done(second)).toBe(true)
          const found = yield* findTools(ownerActor, { query: 'read', limit: 25 })
          const labels = found.tools.filter((tool) => tool.name === 'read')
          expect(labels.map((tool) => tool.account)).toEqual([
            'Records (Gmail (Gmail))',
            'Records (Gmail (Gmail)) (2)',
          ])
          expect(labels.map((tool) => tool.connectionId)).toEqual([
            first.connection.id,
            second.connection.id,
          ])
          expect(
            (yield* resolveTool(ownerActor, { account: 'Records (Gmail (Gmail))', tool: 'read' }))
              .connectionId,
          ).toBe(first.connection.id)
          expect(
            (yield* resolveTool(ownerActor, {
              account: 'Records (Gmail (Gmail)) (2)',
              tool: 'read',
            })).connectionId,
          ).toBe(second.connection.id)
          expect(
            (yield* resolveTool(memberActor, { account: 'Records (Gmail (Gmail))', tool: 'read' }))
              .connectionId,
          ).toBe(second.connection.id)
          expect(
            (yield* Effect.flip(
              resolveTool(ownerActor, { account: 'Records (Gmail (Gmail)) (2)', tool: 'write' }),
            ))._tag,
          ).toBe('NotFound')
          expect(
            (yield* resolveTool(ownerActor, {
              account: '  records (gmail (GMAIL))  ',
              tool: 'read',
            })).connectionId,
          ).toBe(first.connection.id)
          expect(
            (yield* resolveTool(ownerActor, {
              account: ' RECORDS (GMAIL (gmail)) (2) ',
              tool: 'read',
            })).connectionId,
          ).toBe(second.connection.id)
          expect(
            (yield* Effect.flip(
              resolveTool(ownerActor, { account: 'records (gmail (gmail))', tool: 'READ' }),
            ))._tag,
          ).toBe('NotFound')
          const writes = yield* findTools(ownerActor, { query: 'write', limit: 25 })
          expect(writes.tools.map((tool) => tool.account)).toEqual(['Records (Gmail (Gmail))'])
          const again = yield* findTools(ownerActor, { query: 'records', limit: 25 })
          expect(
            again.tools.filter((tool) => tool.name === 'read').map((tool) => tool.account),
          ).toEqual(labels.map((tool) => tool.account))
          const mine = yield* store.begin(ownerActor, {
            from: 'Web',
            service: serviceId,
            name: 'Owner only',
            shared: false,
          })
          // The owner acts through the account under its name; another Person cannot find it.
          const owned = { account: 'Records (Owner only)', tool: 'read' }
          expect((yield* resolveTool(ownerActor, owned)).connectionId).toBe(mine.connection.id)
          expect((yield* Effect.flip(resolveTool(memberActor, owned)))._tag).toBe('NotFound')
        }),
      )
    },
  )

  layer(connectionTestLayer)((it) => {
    /** Only the lexical top twenty reach Jev; lower-scored candidates stay visible. */
    it.effect('scores only twenty lexical candidates and retains below-threshold tools', () =>
      Effect.gen(function* () {
        const { ownerActor } = yield* fixture()
        const probe = yield* ConnectionProbe
        const previous = yield* Ref.get(probe.tools)
        yield* Effect.addFinalizer(() => Ref.set(probe.tools, previous))
        yield* Ref.set(
          probe.tools,
          Array.from({ length: 45 }, (_, index) =>
            ExecutorTool.make({
              name: `operation_${index}`,
              description: 'Read a record',
              effect: 'read',
              input: {},
            }),
          ),
        )
        yield* (yield* ConnectionStore).begin(ownerActor, {
          from: 'Web',
          service: serviceId,
          name: 'Work',
          shared: false,
        })
        const sizes: number[] = []
        const states: Schema.Json[] = []
        const model = yield* DecisionModel.make({
          decide: ({ state, decisions }) => {
            states.push(state)
            sizes.push(Object.keys(decisions).length)
            return Effect.succeed({
              answers: Object.fromEntries(
                Object.keys(decisions).map((key, index) => [
                  key,
                  ScriptedAnswer.cases.Probability.make({ probability: index === 19 ? 0.9 : 0.1 }),
                ]),
              ),
              usage: { inputTokens: undefined, outputTokens: undefined },
            })
          },
        })
        const result = yield* findTools(ownerActor, { query: 'record', limit: 25 }).pipe(
          Effect.provideService(DecisionModel.DecisionModel, model),
        )
        expect(states).toEqual([{ request: 'record' }])
        expect(sizes).toEqual([20])
        expect(result.tools.map((tool) => tool.name)).toEqual([
          'operation_19',
          ...Array.from({ length: 19 }, (_, index) => `operation_${index}`),
          ...Array.from({ length: 5 }, (_, index) => `operation_${index + 20}`),
        ])
      }),
    )

    /** One-result discovery keeps Jev's winner; larger bounds protect the lexical first in
     * the final slot. Both choices are observable through the real public discovery seam. */
    it.effect.each([1, 8])(
      'keeps the promoted winner and applies the lexical safeguard at limit %s',
      (limit) =>
        Effect.gen(function* () {
          const { ownerActor } = yield* fixture()
          const probe = yield* ConnectionProbe
          const previous = yield* Ref.get(probe.tools)
          yield* Effect.addFinalizer(() => Ref.set(probe.tools, previous))
          yield* Ref.set(probe.tools, [
            ExecutorTool.make({
              name: 'needle',
              description: 'Read needle records',
              effect: 'read',
              input: {},
            }),
            ...Array.from({ length: 8 }, (_, index) =>
              ExecutorTool.make({
                name: `lookup_${index}`,
                description: 'Read needle records',
                effect: 'read',
                input: {},
              }),
            ),
          ])
          yield* (yield* ConnectionStore).begin(ownerActor, {
            from: 'Web',
            service: serviceId,
            name: 'Work',
            shared: false,
          })
          const model = yield* DecisionModel.make({
            decide: ({ decisions }) =>
              Effect.succeed({
                answers: Object.fromEntries(
                  Object.keys(decisions).map((key, index) => [
                    key,
                    ScriptedAnswer.cases.Probability.make({ probability: index === 0 ? 0.1 : 0.9 }),
                  ]),
                ),
                usage: { inputTokens: undefined, outputTokens: undefined },
              }),
          })
          const result = yield* findTools(ownerActor, { query: 'needle', limit }).pipe(
            Effect.provideService(DecisionModel.DecisionModel, model),
          )
          expect(result.tools.map((tool) => tool.name)).toEqual(
            limit === 1
              ? ['lookup_0']
              : [...Array.from({ length: 7 }, (_, index) => `lookup_${index}`), 'needle'],
          )
        }),
    )

    /** A sole lexical result has no relative position to enrich. A stalled supplied model
     * proves public discovery returns without entering the semantic provider at all. */
    it.effect('a single lexical candidate never calls relevance', () =>
      Effect.gen(function* () {
        const { ownerActor } = yield* fixture()
        const probe = yield* ConnectionProbe
        const previous = yield* Ref.get(probe.tools)
        yield* Effect.addFinalizer(() => Ref.set(probe.tools, previous))
        yield* Ref.set(probe.tools, [
          ExecutorTool.make({
            name: 'read',
            description: 'Read records',
            effect: 'read',
            input: {},
          }),
        ])
        yield* (yield* ConnectionStore).begin(ownerActor, {
          from: 'Web',
          service: serviceId,
          name: 'Work',
          shared: false,
        })
        let calls = 0
        const model = yield* DecisionModel.make({
          decide: () => {
            calls += 1
            return Effect.never
          },
        })
        const result = yield* findTools(ownerActor, { query: 'read' }).pipe(
          Effect.provideService(DecisionModel.DecisionModel, model),
        )
        expect(result.tools.map((tool) => tool.name)).toEqual(['read'])
        expect(calls).toBe(0)
      }),
    )
  })

  layer(connectionTestLayer)(
    'clock: slow mandatory reads leave the full optional relevance budget',
    (it) => {
      /** Catalog I/O is mandatory OFF work. Its latency must not consume Jev's
       * shared allowance or prevent relevance when effect hints need no judgment. */
      it.effect('slow mandatory reads leave the full optional relevance budget', () =>
        Effect.gen(function* () {
          const { ownerActor } = yield* fixture()
          const store = yield* ConnectionStore
          yield* store.begin(ownerActor, {
            from: 'Web',
            service: serviceId,
            name: 'Work',
            shared: false,
          })
          const recordsStarted = yield* Deferred.make<void>()
          const releaseRecords = yield* Deferred.make<void>()
          const toolsStarted = yield* Deferred.make<void>()
          const releaseTools = yield* Deferred.make<void>()
          const scriptedStore = ConnectionStore.of({
            ...store,
            records: Effect.fn('Test.slowRecords')(function* (actor) {
              yield* Deferred.succeed(recordsStarted, undefined)
              yield* Deferred.await(releaseRecords)
              return yield* store.records(actor)
            }),
            tools: Effect.fn('Test.slowCatalog')(function* () {
              yield* Deferred.succeed(toolsStarted, undefined)
              yield* Deferred.await(releaseTools)
              return ToolDiscovery.cases.Ready.make({
                tools: ['list_records', 'search_records'].map((name) =>
                  ExecutorTool.make({
                    name,
                    description: 'Read existing records',
                    effect: 'read',
                    input: {},
                  }),
                ),
              })
            }),
          })
          let calls = 0
          const model = yield* DecisionModel.make({
            decide: ({ decisions }) => {
              calls += 1
              return Effect.succeed({
                answers: Object.fromEntries(
                  Object.keys(decisions).map((key, index) => [
                    key,
                    ScriptedAnswer.cases.Probability.make({ probability: index === 1 ? 0.9 : 0.1 }),
                  ]),
                ),
                usage: { inputTokens: undefined, outputTokens: undefined },
              })
            },
          })
          const started = yield* Clock.currentTimeMillis
          const pending = yield* findTools(ownerActor, { query: 'records', limit: 1 }).pipe(
            Effect.provideService(ConnectionStore, scriptedStore),
            Effect.provideService(DecisionModel.DecisionModel, model),
            Effect.forkChild,
          )
          yield* Deferred.await(recordsStarted)
          yield* TestClock.adjust('2300 millis')
          yield* Deferred.succeed(releaseRecords, undefined)
          yield* Deferred.await(toolsStarted)
          yield* TestClock.adjust('2700 millis')
          yield* Deferred.succeed(releaseTools, undefined)
          expect((yield* Fiber.join(pending)).tools.map((tool) => tool.name)).toEqual([
            'search_records',
          ])
          expect(calls).toBe(1)
          expect((yield* Clock.currentTimeMillis) - started).toBe(5000)
        }),
      )
    },
  )

  layer(connectionTestLayer)('clock: preserves lexical order on low relevance or timeout', (it) => {
    /** Low scores cannot hide lexical candidates; time exhaustion cannot reorder them. */
    it.effect.each(['below', 'timeout'] as const)(
      'preserves lexical order on %s relevance',
      (mode) =>
        Effect.gen(function* () {
          const { ownerActor } = yield* fixture()
          const probe = yield* ConnectionProbe
          const previous = yield* Ref.get(probe.tools)
          yield* Effect.addFinalizer(() => Ref.set(probe.tools, previous))
          yield* Ref.set(probe.tools, [
            ExecutorTool.make({
              name: 'list_records',
              description: 'List records',
              effect: 'read',
              input: {},
            }),
            ExecutorTool.make({
              name: 'search_records',
              description: 'Search records',
              effect: 'read',
              input: {},
            }),
            ExecutorTool.make({
              name: 'get_record',
              description: 'Get one record',
              effect: 'read',
              input: {},
            }),
          ])
          yield* (yield* ConnectionStore).begin(ownerActor, {
            from: 'Web',
            service: serviceId,
            name: 'Work',
            shared: false,
          })
          const started = yield* Deferred.make<void>()
          const model = yield* DecisionModel.make({
            decide: ({ decisions }) => {
              if (mode === 'timeout')
                return Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never))
              return Effect.succeed({
                answers: Object.fromEntries(
                  Object.keys(decisions).map((key) => [
                    key,
                    ScriptedAnswer.cases.Probability.make({ probability: 0.1 }),
                  ]),
                ),
                usage: { inputTokens: undefined, outputTokens: undefined },
              })
            },
          })
          const pending = yield* findTools(ownerActor, { query: 'search records', limit: 25 }).pipe(
            Effect.provideService(DecisionModel.DecisionModel, model),
            Effect.forkChild,
          )
          if (mode === 'timeout') {
            yield* Deferred.await(started)
            yield* TestClock.adjust(RELEVANCE_BUDGET)
          }
          expect((yield* Fiber.join(pending)).tools.map((tool) => tool.name)).toEqual([
            'search_records',
            'list_records',
            'get_record',
          ])
        }),
    )
  })

  layer(connectionTestLayer)((it) => {
    /** Discovery and use must agree after an undeclared read is recovered from Executor's
     * default mutation hint. One cached effect answer survives both public paths. */
    it.effect('discovery, resolution and execution share a cached read classification', () =>
      Effect.gen(function* () {
        const { ownerActor } = yield* fixture()
        const probe = yield* ConnectionProbe
        const previous = yield* Ref.get(probe.tools)
        yield* Effect.addFinalizer(() => Ref.set(probe.tools, previous))
        yield* Ref.set(probe.tools, [
          ExecutorTool.make({
            name: 'ask_question',
            description: 'Answer a repository question',
            effect: 'write',
            input: {},
          }),
        ])
        const connection = yield* (yield* ConnectionStore).begin(ownerActor, {
          from: 'Web',
          service: serviceId,
          name: 'Wiki',
          shared: false,
        })
        let effectCalls = 0
        const modelLayer = Layer.effect(
          DecisionModel.DecisionModel,
          DecisionModel.make({
            decide: ({ decisions }) => {
              const answers: Record<string, DecisionModel.ProviderAnswer> = {}
              for (const [key, decision] of Object.entries(decisions)) {
                if (Predicate.isTagged(decision, 'Classify')) {
                  effectCalls += 1
                  answers[key] = ScriptedAnswer.cases.Classify.make({
                    label: 'read',
                    probabilities: { read: 0.99, write: 0.01, destructive: 0 },
                  })
                } else answers[key] = ScriptedAnswer.cases.Probability.make({ probability: 0.9 })
              }
              return Effect.succeed({
                answers,
                usage: { inputTokens: undefined, outputTokens: undefined },
              })
            },
          }),
        )
        yield* Effect.gen(function* () {
          // An empty classifier cache belongs to this model recorder, not the harness default model.
          const context = yield* Layer.build(
            Layer.fresh(toolEffectsLayer.pipe(Layer.provideMerge(modelLayer))),
          )
          return yield* Effect.gen(function* () {
            expect(
              (yield* findTools(ownerActor, { query: 'explain repository' })).tools.map(
                (tool) => tool.effect,
              ),
            ).toEqual(['read'])
            expect(
              (yield* resolveTool(ownerActor, { account: 'Records (Wiki)', tool: 'ask_question' }))
                .effect,
            ).toBe('read')
            const calls = yield* Ref.get(probe.calls)
            const { outcome: used } = yield* useTool(ownerActor, {
              connectionId: connection.connection.id,
              tool: 'ask_question',
              input: {},
              summary: 'Read documentation',
              rationale: 'Explain the repository',
            })
            expect(used).toEqual(ToolOutcome.cases.Completed.make({ output: { ok: true } }))
            expect(yield* Ref.get(probe.calls)).toBe(calls + 1)
            expect((yield* Ref.get(probe.checked)).map(({ action }) => action.effect)).toEqual([
              'read',
            ])
            expect(effectCalls).toBe(1)
          }).pipe(Effect.provide(context))
        }).pipe(Effect.scoped)
      }),
    )
  })

  layer(connectionTestLayer)(
    'clock: skips relevance silently when classification leaves less than its warm floor',
    (it) => {
      /** A short remainder cannot fund relevance near its measured median. A typed release
       * spends 1.5s on effects and proves the remaining 0.5s is skipped silently. */
      it.effect(
        'skips relevance silently when classification leaves less than its warm floor',
        () =>
          Effect.gen(function* () {
            const { ownerActor } = yield* fixture()
            const probe = yield* ConnectionProbe
            const previous = yield* Ref.get(probe.tools)
            yield* Effect.addFinalizer(() => Ref.set(probe.tools, previous))
            yield* Ref.set(
              probe.tools,
              [0, 1].map((index) =>
                ExecutorTool.make({
                  name: `lookup_${index}`,
                  description: 'Lookup a record',
                  effect: 'write',
                  input: {},
                }),
              ),
            )
            yield* (yield* ConnectionStore).begin(ownerActor, {
              from: 'Web',
              service: serviceId,
              name: 'Work',
              shared: false,
            })
            const effectsStarted = yield* Deferred.make<void>()
            const releaseEffects = yield* Deferred.make<void>()
            const lines: string[] = []
            let calls = 0
            const modelLayer = Layer.effect(
              DecisionModel.DecisionModel,
              DecisionModel.make({
                decide: Effect.fn('Test.discoveryDeadline')(function* ({ decisions }) {
                  calls += 1
                  if (calls > 1) {
                    return yield* Effect.never
                  }
                  yield* Deferred.succeed(effectsStarted, undefined)
                  yield* Deferred.await(releaseEffects)
                  return {
                    answers: Object.fromEntries(
                      Object.keys(decisions).map((key) => [
                        key,
                        ScriptedAnswer.cases.Classify.make({
                          label: 'read',
                          probabilities: { read: 0.99, write: 0.01, destructive: 0 },
                        }),
                      ]),
                    ),
                    usage: { inputTokens: undefined, outputTokens: undefined },
                  }
                }),
              }),
            )
            yield* Effect.gen(function* () {
              // The deferred classifier owns the warm-floor timing and warning receipts in this case.
              const context = yield* Layer.build(
                Layer.fresh(toolEffectsLayer.pipe(Layer.provideMerge(modelLayer))),
              )
              return yield* Effect.gen(function* () {
                const start = yield* Clock.currentTimeMillis
                const pending = yield* findTools(ownerActor, { query: 'record' }).pipe(
                  Effect.forkChild,
                )
                yield* Deferred.await(effectsStarted)
                yield* TestClock.adjust('1500 millis')
                yield* Deferred.succeed(releaseEffects, undefined)
                expect((yield* Fiber.join(pending)).tools.map((tool) => tool.name)).toEqual([
                  'lookup_0',
                  'lookup_1',
                ])
                expect((yield* Clock.currentTimeMillis) - start).toBe(1500)
                expect(calls).toBe(1)
                expect(lines.some((line) => line.includes('unavailable'))).toBe(false)
              }).pipe(Effect.provide(context))
            }).pipe(
              Effect.scoped,
              Effect.provideService(
                Logger.CurrentLoggers,
                new Set([
                  Logger.make(({ message }) => {
                    lines.push(JSON.stringify(message))
                  }),
                ]),
              ),
            )
          }),
      )
    },
  )

  layer(connectionTestLayer)(
    'clock: bounds discovery while late Integration lookups fill the shared cache',
    (it) => {
      /** Nine real Integrations exceed the four-way classification fanout. The second wave
       * must stop at the original deadline and retain writes for this caller. Their
       * bounded lookups continue in the Layer and supply the next call's cached reads;
       * a shared read hint still bypasses Jev and survives optional cancellation. */
      it.effect('bounds discovery while late Integration lookups fill the shared cache', () =>
        Effect.gen(function* () {
          const { ownerActor } = yield* fixture()
          const store = yield* ConnectionStore
          for (let index = 0; index < 9; index += 1)
            yield* store.begin(ownerActor, {
              from: 'Web',
              service: serviceId,
              name: `Account ${index}`,
              shared: false,
            })
          const scriptedStore = ConnectionStore.of({
            ...store,
            tools: Effect.fn('Test.integrationTools')((_actor, row) =>
              Effect.succeed(
                ToolDiscovery.cases.Ready.make({
                  tools: [
                    ExecutorTool.make({
                      name: `lookup_${row.name}`,
                      description: 'Lookup existing records',
                      effect: 'write',
                      input: {},
                    }),
                    ExecutorTool.make({
                      name: `read_${row.name}`,
                      description: 'Read records',
                      effect: 'read',
                      input: {},
                    }),
                  ],
                }),
              ),
            ),
          })
          const firstStarted = yield* Deferred.make<void>()
          const firstRelease = yield* Deferred.make<void>()
          const secondStarted = yield* Deferred.make<void>()
          const secondRelease = yield* Deferred.make<void>()
          const firstNames: string[] = []
          const retriedNames: string[] = []
          let wave = 0
          const modelLayer = Layer.effect(
            DecisionModel.DecisionModel,
            DecisionModel.make({
              decide: Effect.fn('Test.integrationWaves')(function* ({ decisions }) {
                // Relevance is a separate provider workload after the second discovery recovers.
                if (
                  Object.values(decisions).every((decision) =>
                    Predicate.isTagged(decision, 'Probability'),
                  )
                )
                  return {
                    answers: Object.fromEntries(
                      Object.keys(decisions).map((key) => [
                        key,
                        ScriptedAnswer.cases.Probability.make({ probability: 0.1 }),
                      ]),
                    ),
                    usage: { inputTokens: undefined, outputTokens: undefined },
                  }
                wave += 1
                const questions = Object.values(decisions).map((decision) => decision.instructions)
                if (wave === 1) {
                  firstNames.push(...questions)
                  yield* Deferred.succeed(firstStarted, undefined)
                  yield* Deferred.await(firstRelease)
                } else if (wave === 2) {
                  yield* Deferred.succeed(secondStarted, undefined)
                  yield* Deferred.await(secondRelease)
                } else retriedNames.push(...questions)
                return {
                  answers: Object.fromEntries(
                    Object.keys(decisions).map((key) => [
                      key,
                      ScriptedAnswer.cases.Classify.make({
                        label: 'read',
                        probabilities: { read: 1, write: 0, destructive: 0 },
                      }),
                    ]),
                  ),
                  usage: { inputTokens: undefined, outputTokens: undefined },
                }
              }),
            }),
          )
          const lines: string[] = []
          yield* Effect.gen(function* () {
            // This cache outlives the first discovery caller so late batch receipts can populate it.
            const context = yield* Layer.build(
              Layer.fresh(toolEffectsLayer.pipe(Layer.provideMerge(modelLayer))),
            )
            return yield* Effect.gen(function* () {
              const started = yield* Clock.currentTimeMillis
              const pending = yield* findTools(ownerActor, { query: 'records', limit: 25 }).pipe(
                Effect.forkChild,
              )
              yield* Deferred.await(firstStarted)
              yield* TestClock.adjust('1700 millis')
              yield* Deferred.succeed(firstRelease, undefined)
              yield* Deferred.await(secondStarted)
              yield* TestClock.adjust('300 millis')
              const first = yield* Fiber.join(pending)
              expect((yield* Clock.currentTimeMillis) - started).toBe(2000)
              expect(first.tools.filter((tool) => tool.effect === 'read')).toHaveLength(13)
              expect(first.tools.filter((tool) => tool.effect === 'write')).toHaveLength(5)
              expect(firstNames).toHaveLength(4)
              expect(wave).toBe(2)
              expect(lines.some((line) => line.includes('unavailable'))).toBe(false)
              // The first caller has left. Await the late public classification
              // receipt before the second discovery, proving it reads completed cache.
              yield* TestClock.adjust('100 millis')
              yield* Deferred.succeed(secondRelease, undefined)
              const service = yield* store.service(serviceId)
              yield* (yield* ToolEffects).classifyBatch({
                serviceId,
                service: service.name,
                tools: first.tools
                  .filter((tool) => tool.effect === 'write')
                  .map((tool) =>
                    ExecutorTool.make({
                      name: tool.name,
                      description: tool.description,
                      effect: tool.effect,
                      input: {},
                    }),
                  ),
              })
              const second = yield* findTools(ownerActor, { query: 'records', limit: 25 })
              expect(second.tools.every((tool) => tool.effect === 'read')).toBe(true)
              // The ninth Integration never began its lookup before the deadline;
              // only that unstarted key needs a new request. Four late keys are cached.
              expect(retriedNames).toHaveLength(1)
              expect(wave).toBe(3)
            }).pipe(Effect.provideService(ConnectionStore, scriptedStore), Effect.provide(context))
          }).pipe(
            Effect.scoped,
            Effect.provideService(
              Logger.CurrentLoggers,
              new Set([
                Logger.make(({ message }) => {
                  lines.push(JSON.stringify(message))
                }),
              ]),
            ),
          )
        }),
      )
    },
  )

  layer(connectionTestLayer)((it) => {
    /** Every execution entrypoint inspects exactly the requested undeclared tool. */
    it.effect('direct use, resolution and approved use never classify the whole catalog', () =>
      Effect.gen(function* () {
        const { ownerActor } = yield* fixture()
        const probe = yield* ConnectionProbe
        const previous = yield* Ref.get(probe.tools)
        yield* Effect.addFinalizer(() => Ref.set(probe.tools, previous))
        yield* Ref.set(
          probe.tools,
          Array.from({ length: 40 }, (_, index) =>
            ExecutorTool.make({
              name: `lookup_${index}`,
              description: 'Lookup a record',
              effect: 'write',
              input: {},
            }),
          ),
        )
        const connection = yield* (yield* ConnectionStore).begin(ownerActor, {
          from: 'Web',
          service: serviceId,
          name: 'Work',
          shared: false,
        })
        const names: string[] = []
        const modelLayer = Layer.effect(
          DecisionModel.DecisionModel,
          DecisionModel.make({
            decide: Effect.fn('Test.requestedEffect')(({ decisions }) => {
              const questions = Object.values(decisions)
              expect(questions).toHaveLength(1)
              for (const question of questions) names.push(question.instructions)
              return Effect.succeed({
                answers: {
                  tool_0: ScriptedAnswer.cases.Classify.make({
                    label: 'read',
                    probabilities: { read: 0.99, write: 0.01, destructive: 0 },
                  }),
                },
                usage: { inputTokens: undefined, outputTokens: undefined },
              })
            }),
          }),
        )
        yield* Effect.gen(function* () {
          // Bind a fresh classifier to the model that counts classification for each execution entrypoint.
          const context = yield* Layer.build(
            Layer.fresh(toolEffectsLayer.pipe(Layer.provideMerge(modelLayer))),
          )
          return yield* Effect.gen(function* () {
            const { outcome: used } = yield* useTool(ownerActor, {
              connectionId: connection.connection.id,
              tool: 'lookup_0',
              input: {},
              summary: 'Read',
              rationale: 'Read a record',
            })
            expect(used).toEqual(ToolOutcome.cases.Completed.make({ output: { ok: true } }))
            const resolved = yield* resolveTool(ownerActor, {
              account: 'Records (Work)',
              tool: 'lookup_1',
            })
            expect(resolved).toMatchObject({
              connectionId: connection.connection.id,
              name: 'lookup_1',
              effect: 'read',
            })
            const executed = yield* connectionRunner({
              person: ownerActor.person,
              workspace: ownerActor.workspace,
              target: ActionTarget.cases.Connection.make({
                connectionId: connection.connection.id,
                account: 'Records (Work)',
                tool: 'lookup_2',
                input: {},
              }),
            })
            expect(executed).toEqual(ActionOutcome.cases.Succeeded.make({ result: '{"ok":true}' }))
            expect(names).toHaveLength(3)
            for (const [index, question] of names.entries())
              expect(question).toContain(`"tool":"lookup_${index}"`)
          }).pipe(Effect.provide(context))
        }).pipe(Effect.scoped)
      }),
    )
  })
})
