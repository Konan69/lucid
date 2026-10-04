import { describe, expect, layer } from '@effect/vitest'
import { Clock, Deferred, Effect, Fiber, Layer, Logger, Predicate, Ref, Schema } from 'effect'
import { ScriptedAnswer } from '../decisions/testing.ts'
import { DecisionModel } from 'effect/unstable/ai'
import { RELEVANCE_BUDGET } from './relevance.ts'
import { toolEffectsLayer } from './effects.ts'
import * as TestClock from 'effect/testing/TestClock'
import { ActionTarget, ConnectionStep } from '@vivid/contracts'
import { testDatabaseConfigured } from '../database/testdb.ts'
import { ExecutorTool } from './executor.ts'
import { ConnectionStore } from './store.ts'
import { ConnectionProbe, connectionTestLayer, fixture, serviceId } from './testing.ts'
import { connectionRunner, findTools, resolveTool, useTool } from './tools.ts'

/** Discovery uses real scoped records; suffixes must remain stable across ranking queries and ownership. */
describe.skipIf(!testDatabaseConfigured)('Connection account names', () => {
  layer(connectionTestLayer)((it) => {
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
        yield* store.begin(ownerActor, { service: serviceId, label: 'Work', shared: false })
        yield* TestClock.adjust(1)
        yield* store.begin(ownerActor, { service: serviceId, label: 'Team', shared: true })
        const service = yield* findTools(ownerActor, { query: 'Records' })
        expect(service.tools.map((tool) => [tool.account, tool.name])).toEqual([
          ['Work', 'write'],
          ['Work', 'read'],
          ['Team', 'read'],
        ])
        const specific = yield* findTools(ownerActor, { query: 'Records read' })
        expect(specific.tools.map((tool) => tool.name)).toEqual(['read', 'read', 'write'])
        const account = yield* findTools(ownerActor, { query: 'Work' })
        expect(account.tools.map((tool) => tool.account)).toEqual(['Work', 'Work'])
        expect((yield* findTools(ownerActor, { query: 'unrelated' })).tools).toEqual([])
      }),
    )

    it.effect('keeps own-text matches ahead of identity noise and bounds a flooded service', () =>
      Effect.gen(function* () {
        const { ownerActor } = yield* fixture()
        const store = yield* ConnectionStore
        const probe = yield* ConnectionProbe
        const previous = yield* Ref.get(probe.tools)
        yield* Effect.addFinalizer(() => Ref.set(probe.tools, previous))
        yield* store.begin(ownerActor, { service: serviceId, label: 'Work', shared: false })
        yield* TestClock.adjust(1)
        const target = yield* store.begin(ownerActor, {
          service: serviceId,
          label: 'Other',
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
            service: serviceId,
            label: 'Records',
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

    it.effect('distinguishes duplicate accounts by creation order before query filtering', () =>
      Effect.gen(function* () {
        const { ownerActor, memberActor } = yield* fixture()
        const store = yield* ConnectionStore
        const first = yield* store.begin(ownerActor, {
          service: serviceId,
          label: 'Gmail (Gmail)',
          shared: false,
        })
        yield* TestClock.adjust(1)
        const second = yield* store.begin(ownerActor, {
          service: serviceId,
          label: 'Gmail (Gmail)',
          shared: true,
        })
        yield* TestClock.adjust(1)
        yield* store.begin(memberActor, {
          service: serviceId,
          label: 'Gmail (Gmail)',
          shared: false,
        })
        expect(ConnectionStep.guards.Done(first)).toBe(true)
        expect(ConnectionStep.guards.Done(second)).toBe(true)
        const found = yield* findTools(ownerActor, { query: 'read', limit: 25 })
        const labels = found.tools.filter((tool) => tool.name === 'read')
        expect(labels.map((tool) => tool.account)).toEqual(['Gmail (Gmail)', 'Gmail (Gmail) (2)'])
        expect(labels.map((tool) => tool.connectionId)).toEqual([
          first.connection.id,
          second.connection.id,
        ])
        expect(
          (yield* resolveTool(ownerActor, { account: 'Gmail (Gmail)', tool: 'read' })).connectionId,
        ).toBe(first.connection.id)
        expect(
          (yield* resolveTool(ownerActor, { account: 'Gmail (Gmail) (2)', tool: 'read' }))
            .connectionId,
        ).toBe(second.connection.id)
        expect(
          (yield* resolveTool(memberActor, { account: 'Gmail (Gmail)', tool: 'read' }))
            .connectionId,
        ).toBe(second.connection.id)
        expect(
          (yield* Effect.flip(
            resolveTool(ownerActor, { account: 'Gmail (Gmail) (2)', tool: 'write' }),
          ))._tag,
        ).toBe('NotFound')
        expect(
          (yield* resolveTool(ownerActor, { account: '  gmail (GMAIL)  ', tool: 'read' }))
            .connectionId,
        ).toBe(first.connection.id)
        expect(
          (yield* resolveTool(ownerActor, { account: ' GMAIL (gmail) (2) ', tool: 'read' }))
            .connectionId,
        ).toBe(second.connection.id)
        expect(
          (yield* Effect.flip(resolveTool(ownerActor, { account: 'gmail (gmail)', tool: 'READ' })))
            ._tag,
        ).toBe('NotFound')
        const writes = yield* findTools(ownerActor, { query: 'write', limit: 25 })
        expect(writes.tools.map((tool) => tool.account)).toEqual(['Gmail (Gmail)'])
        const again = yield* findTools(ownerActor, { query: 'records', limit: 25 })
        expect(
          again.tools.filter((tool) => tool.name === 'read').map((tool) => tool.account),
        ).toEqual(labels.map((tool) => tool.account))
        yield* store.begin(ownerActor, { service: serviceId, label: 'Owner only', shared: false })
        expect(
          (yield* Effect.flip(resolveTool(memberActor, { account: 'Owner only', tool: 'read' })))
            ._tag,
        ).toBe('NotFound')
      }),
    )

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
          service: serviceId,
          label: 'Work',
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
            service: serviceId,
            label: 'Work',
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
          service: serviceId,
          label: 'Work',
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
            service: serviceId,
            label: 'Work',
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
          service: serviceId,
          label: 'Wiki',
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
          expect(
            (yield* findTools(ownerActor, { query: 'explain repository' })).tools.map(
              (tool) => tool.effect,
            ),
          ).toEqual(['read'])
          expect(
            (yield* resolveTool(ownerActor, { account: 'Wiki', tool: 'ask_question' })).effect,
          ).toBe('read')
          yield* useTool(ownerActor, {
            connectionId: connection.connection.id,
            tool: 'ask_question',
            input: {},
            summary: 'Read documentation',
            rationale: 'Explain the repository',
          })
          expect((yield* Ref.get(probe.checked)).map(({ action }) => action.effect)).toEqual([
            'read',
          ])
          expect(effectCalls).toBe(1)
        }).pipe(Effect.provide(Layer.fresh(toolEffectsLayer.pipe(Layer.provideMerge(modelLayer)))))
      }),
    )

    /** A short remainder cannot fund relevance near its measured median. A typed release
     * spends 1.5s on effects and proves the remaining 0.5s is skipped silently. */
    it.effect('skips relevance silently when classification leaves less than its warm floor', () =>
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
          service: serviceId,
          label: 'Work',
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
          const start = yield* Clock.currentTimeMillis
          const pending = yield* findTools(ownerActor, { query: 'record' }).pipe(Effect.forkChild)
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
        }).pipe(
          Effect.provide(Layer.fresh(toolEffectsLayer.pipe(Layer.provideMerge(modelLayer)))),
          Effect.provide(
            Logger.layer([
              Logger.make(({ message }) => {
                lines.push(JSON.stringify(message))
              }),
            ]),
          ),
        )
      }),
    )

    /** Nine real Integrations exceed the four-way classification fanout. The second wave
     * must stop at the original deadline, retain writes and be judged on the next call;
     * a shared read hint still bypasses Jev and is never lost to optional cancellation. */
    it.effect(
      'bounds all Integration waves together and retries unanswered tools immediately',
      () =>
        Effect.gen(function* () {
          const { ownerActor } = yield* fixture()
          const store = yield* ConnectionStore
          for (let index = 0; index < 9; index += 1)
            yield* store.begin(ownerActor, {
              service: serviceId,
              label: `Account ${index}`,
              shared: false,
            })
          const scriptedStore = ConnectionStore.of({
            ...store,
            tools: Effect.fn('Test.integrationTools')((_actor, row) =>
              Effect.succeed([
                ExecutorTool.make({
                  name: `lookup_${row.label}`,
                  description: 'Lookup existing records',
                  effect: 'write',
                  input: {},
                }),
                ExecutorTool.make({
                  name: `read_${row.label}`,
                  description: 'Read records',
                  effect: 'read',
                  input: {},
                }),
              ]),
            ),
          })
          const firstStarted = yield* Deferred.make<void>()
          const firstRelease = yield* Deferred.make<void>()
          const secondStarted = yield* Deferred.make<void>()
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
                  return yield* Effect.never
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
            // A fresh discovery asks all five unanswered keys without advancing the cache TTL.
            const second = yield* findTools(ownerActor, { query: 'records', limit: 25 })
            expect(second.tools.every((tool) => tool.effect === 'read')).toBe(true)
            expect(retriedNames).toHaveLength(5)
          }).pipe(
            Effect.provideService(ConnectionStore, scriptedStore),
            Effect.provide(Layer.fresh(toolEffectsLayer.pipe(Layer.provideMerge(modelLayer)))),
            Effect.provide(
              Logger.layer([
                Logger.make(({ message }) => {
                  lines.push(JSON.stringify(message))
                }),
              ]),
            ),
          )
        }),
    )

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
          service: serviceId,
          label: 'Work',
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
          yield* useTool(ownerActor, {
            connectionId: connection.connection.id,
            tool: 'lookup_0',
            input: {},
            summary: 'Read',
            rationale: 'Read a record',
          })
          yield* resolveTool(ownerActor, { account: 'Work', tool: 'lookup_1' })
          yield* connectionRunner({
            person: ownerActor.person,
            workspace: ownerActor.workspace,
            target: ActionTarget.cases.Connection.make({
              connectionId: connection.connection.id,
              account: 'Work',
              tool: 'lookup_2',
              input: {},
            }),
          })
          expect(names).toHaveLength(3)
          for (const [index, question] of names.entries())
            expect(question).toContain(`"tool":"lookup_${index}"`)
        }).pipe(Effect.provide(Layer.fresh(toolEffectsLayer.pipe(Layer.provideMerge(modelLayer)))))
      }),
    )
  })
})
