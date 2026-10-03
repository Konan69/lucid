import { describe, expect, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Ref from 'effect/Ref'
import { AuditEvent } from '@vivid/contracts'
import { fixture, Observation, trustTestLayer } from '../approvals/testing.ts'
import { testDatabaseConfigured } from '../database/testdb.ts'
import { Topic } from '../live/changes.ts'
import { Audit } from './record.ts'
import { loadAudit } from './store.ts'

/** Private Thread contents remain private while attributed action metadata reaches the authorized record. */
describe.skipIf(!testDatabaseConfigured)('Audit attribution and realtime', () => {
  it.effect(
    'members see their own Company events, admins see the Company, and writes publish topics',
    () =>
      Effect.gen(function* () {
        const test = yield* fixture()
        const audit = yield* Audit
        yield* audit.record(
          test.companyVivid,
          AuditEvent.cases.ActionBlocked.make({
            tool: 'command',
            service: 'Computer',
            rule: 'Never remove records',
          }),
        )
        yield* audit.record(
          test.owner,
          AuditEvent.cases.RuleAdded.make({ action: 'Ask before writing', decision: 'Ask' }),
        )
        const own = (yield* loadAudit(test.member)).entries
        expect(own).toHaveLength(1)
        expect(own[0]).toMatchObject({
          by: 'vivid',
          threadId: test.companyId,
          actor: { id: test.member.person.id },
        })
        expect((yield* loadAudit(test.owner)).entries).toHaveLength(2)
        expect((yield* loadAudit(test.personal)).entries).toEqual([])
        const published = yield* Ref.get((yield* Observation).topics)
        expect(published).toContain(Topic.thread(test.companyId))
        expect(published).toContain(Topic.person(test.member.person.id))
      }).pipe(Effect.scoped, Effect.provide(trustTestLayer)),
  )
})
