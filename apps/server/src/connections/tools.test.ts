import { describe, expect, layer } from '@effect/vitest'
import { Effect, Ref } from 'effect'
import * as TestClock from 'effect/testing/TestClock'
import { ConnectionStep } from '@vivid/contracts'
import { testDatabaseConfigured } from '../database/testdb.ts'
import { ExecutorTool } from './executor.ts'
import { ConnectionStore } from './store.ts'
import { ConnectionProbe, connectionTestLayer, fixture, serviceId } from './testing.ts'
import { findTools, resolveTool } from './tools.ts'

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
  })
})
