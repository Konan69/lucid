import * as Layer from 'effect/Layer'
import { PgClient } from '@effect/sql-pg/PgClient'
import { describe, expect, layer } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import { AuditEvent } from '@vivid/contracts'
import { fixture, trustTestServices } from '../approvals/testing.ts'
import { testDatabaseConfigured, testDatabaseLayer } from '../database/testdb.ts'
import { CHANNEL, Topic } from '../live/changes.ts'
import { Audit } from './record.ts'
import { loadAudit } from './store.ts'
import { payload } from '../live/testing.ts'
import { requireCompany } from '../auth/access.ts'

/** Private Thread contents remain private while attributed action metadata reaches the authorized record. */
/** Share only PostgreSQL; each case builds its own recording ports and captured stores. */
layer(testDatabaseLayer)((it) => {
  describe.skipIf(!testDatabaseConfigured)('Audit attribution and realtime', () => {
    it.effect(
      'members see their own Company events, admins see the Company, and writes announce committed topics',
      () =>
        Effect.gen(function* () {
          const context = yield* Layer.build(trustTestServices)
          return yield* Effect.gen(function* () {
            const test = yield* fixture()
            const audit = yield* Audit
            // The actual PostgreSQL receipt covers recordAudit's transaction, independent of other test ports.
            const notifications = yield* (yield* PgClient).listen(CHANNEL)
            yield* audit.record(
              test.companyVivid,
              AuditEvent.cases.ActionBlocked.make({
                tool: 'command',
                service: 'Computer',
                rule: 'Never remove records',
              }),
            )
            yield* payload(notifications, [
              Topic.thread(test.companyId),
              Topic.person(test.member.person.id),
              Topic.company((yield* requireCompany(test.member.workspace)).company.id),
            ])
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
          }).pipe(Effect.scoped, Effect.provide(context))
        }),
    )
  })
})
