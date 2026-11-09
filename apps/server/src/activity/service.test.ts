import * as NodeCrypto from 'node:crypto'
import { describe, expect, layer } from '@effect/vitest'
import { eq } from 'drizzle-orm'
import { ActivityRegistration } from '@vivid/contracts'
import { ConfigProvider, Effect, Layer, Result } from 'effect'
import { sessionTable } from '../auth/tables.ts'
import { testDatabaseConfigured, testDatabaseLayer } from '../database/testdb.ts'
import { fixture } from '../push/testing.ts'
import { Activities, activitiesLayer } from './service.ts'
import { activityTargets } from './tables.ts'

const signing = NodeCrypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
const testing = activitiesLayer.pipe(
  Layer.provideMerge(testDatabaseLayer),
  Layer.provide(
    ConfigProvider.layer(
      ConfigProvider.fromUnknown({
        VIVID_APNS_PRIVATE_KEY: signing.privateKey.export({ type: 'pkcs8', format: 'pem' }),
        VIVID_APNS_TEAM_ID: 'test-team',
        VIVID_APNS_KEY_ID: 'test-key',
        VIVID_APNS_BUNDLE_ID: 'work.vivid.test',
        VIVID_APNS_ENVIRONMENT: 'sandbox',
      }),
    ),
  ),
)

/** PostgreSQL proves that token rotation preserves ownership and session revocation removes delivery authority. */
describe.skipIf(!testDatabaseConfigured)('ActivityKit registration', () => {
  layer(testing)((it) => {
    it.effect(
      'rotates push-to-start tokens only for the owner and cascades session revocation',
      () =>
        Effect.gen(function* () {
          const owner = yield* fixture()
          const other = yield* fixture()
          const activities = yield* Activities
          const installation = NodeCrypto.randomUUID()
          yield* activities.register(
            owner.person.id,
            owner.sessionId,
            ActivityRegistration.cases.Start.make({ installation, token: 'a'.repeat(64) }),
          )
          yield* activities.register(
            owner.person.id,
            owner.sessionId,
            ActivityRegistration.cases.Start.make({ installation, token: 'b'.repeat(64) }),
          )
          const refused = yield* activities
            .register(
              other.person.id,
              other.sessionId,
              ActivityRegistration.cases.Start.make({ installation, token: 'c'.repeat(64) }),
            )
            .pipe(Effect.result)
          expect(Result.isFailure(refused) && refused.failure._tag).toBe('Conflict')
          const rows = yield* owner.database.run(
            owner.database
              .select()
              .from(activityTargets)
              .where(eq(activityTargets.installation, installation)),
          )
          expect(rows).toHaveLength(1)
          expect(rows[0]).toMatchObject({
            personId: owner.person.id,
            sessionId: owner.sessionId,
            startToken: 'b'.repeat(64),
            updateToken: null,
          })
          yield* owner.database.run(
            owner.database.delete(sessionTable).where(eq(sessionTable.id, owner.sessionId)),
          )
          expect(
            yield* owner.database.run(
              owner.database
                .select()
                .from(activityTargets)
                .where(eq(activityTargets.installation, installation)),
            ),
          ).toEqual([])
        }),
    )
  })
})
