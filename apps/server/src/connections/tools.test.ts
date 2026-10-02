import { describe, expect, layer } from '@effect/vitest'
import { Effect } from 'effect'
import * as TestClock from 'effect/testing/TestClock'
import { ConnectionStep } from '@vivid/contracts'
import { testDatabaseConfigured } from '../database/testdb.ts'
import { ConnectionStore } from './store.ts'
import { connectionTestLayer, fixture, serviceId } from './testing.ts'
import { findTools } from './tools.ts'

/** Discovery uses real scoped records; suffixes must remain stable across ranking queries and ownership. */
describe.skipIf(!testDatabaseConfigured)('Connection account names', () => {
  layer(connectionTestLayer)((it) => {
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
        const writes = yield* findTools(ownerActor, { query: 'write', limit: 25 })
        expect(writes.tools.map((tool) => tool.account)).toEqual(['Gmail (Gmail)'])
        const again = yield* findTools(ownerActor, { query: 'records', limit: 25 })
        expect(
          again.tools.filter((tool) => tool.name === 'read').map((tool) => tool.account),
        ).toEqual(labels.map((tool) => tool.account))
      }),
    )
  })
})
