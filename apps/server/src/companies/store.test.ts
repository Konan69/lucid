import * as NodeCrypto from 'node:crypto'
import { describe, expect, layer } from '@effect/vitest'
import { CompanyId, InvitationId, PersonId } from '@vivid/contracts'
import { and, eq } from 'drizzle-orm'
import { Effect, Layer, Result } from 'effect'
import * as HttpServerRequest from 'effect/http/HttpServerRequest'
import { authEffect, localAuthRuntimeLayer } from '../auth/provider.ts'
import { personTable } from '../auth/tables.ts'
import { Database } from '../database/client.ts'
import { testConfigLayer, testDatabaseConfigured, testDatabaseLayer } from '../database/testdb.ts'
import { changesLayer } from '../live/changes.ts'
import { CompanyStore, companyStoreLayer } from './store.ts'
import { companyTable, invitationTable, membershipTable } from './tables.ts'

const testLayer = Layer.mergeAll(companyStoreLayer, changesLayer, localAuthRuntimeLayer).pipe(
  Layer.provideMerge(testDatabaseLayer),
  Layer.provideMerge(testConfigLayer),
)

/**
 * A Company whose owner invited `email` as an admin. Nobody holds that address yet, which is the
 * state the invitation link is sent in. Cleanup is registered before the first write and removes
 * whoever registered the invited address during the test.
 */
const invited = Effect.fn('CompanyTest.invited')(function* () {
  const database = yield* Database
  const owner = PersonId.make(NodeCrypto.randomUUID())
  const companyId = CompanyId.make(NodeCrypto.randomUUID())
  const invitationId = InvitationId.make(NodeCrypto.randomUUID())
  const email = `${NodeCrypto.randomUUID()}@example.test`
  yield* Effect.addFinalizer(() =>
    database.run(database.delete(companyTable).where(eq(companyTable.id, companyId))).pipe(
      Effect.andThen(database.run(database.delete(personTable).where(eq(personTable.id, owner)))),
      Effect.andThen(
        database.run(database.delete(personTable).where(eq(personTable.email, email))),
      ),
      Effect.asVoid,
      Effect.catch(() => Effect.sync(() => expect.fail('Company fixture cleanup failed'))),
    ),
  )
  yield* database.run(
    database
      .insert(personTable)
      .values({ id: owner, name: 'Owner', email: `${owner}@example.test`, emailVerified: true }),
  )
  yield* database.run(
    database.insert(companyTable).values({ id: companyId, name: 'Company test', slug: companyId }),
  )
  yield* database.run(
    database.insert(invitationTable).values({
      id: invitationId,
      companyId,
      email,
      role: 'admin',
      status: 'pending',
      expiresAt: new Date('2100-01-01T00:00:00Z'),
      inviterId: owner,
    }),
  )
  return { companyId, invitationId, email }
})

type Invited = Effect.Success<ReturnType<typeof invited>>

/**
 * Registers the invited address with a password through the production auth adapter, exactly as
 * someone holding the link would, and returns the Person the adapter stored.
 */
const signedUp = Effect.fn('CompanyTest.signedUp')(function* (email: string) {
  const auth = yield* authEffect
  const response = yield* auth.fetch.pipe(
    Effect.provideService(
      HttpServerRequest.HttpServerRequest,
      HttpServerRequest.fromWeb(
        new Request('http://127.0.0.1:8787/api/auth/sign-up/email', {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:8787' },
          body: JSON.stringify({ email, name: 'Link holder', password: 'test-Company-0123456789' }),
        }),
      ),
    ),
  )
  expect(response.status).toBe(200)
  const database = yield* Database
  const [row] = yield* database.run(
    database
      .select({ id: personTable.id, verified: personTable.emailVerified })
      .from(personTable)
      .where(eq(personTable.email, email)),
  )
  if (row === undefined) return expect.fail('Sign-up must persist a Person')
  return { id: PersonId.make(row.id), name: 'Link holder', verified: row.verified }
})

/** What the invitation and the Company's Memberships say after an attempt. */
const outcome = Effect.fn('CompanyTest.outcome')(function* (test: Invited, personId: PersonId) {
  const database = yield* Database
  const [invitation] = yield* database.run(
    database
      .select({ status: invitationTable.status })
      .from(invitationTable)
      .where(eq(invitationTable.id, test.invitationId)),
  )
  const memberships = yield* database.run(
    database
      .select({ role: membershipTable.role })
      .from(membershipTable)
      .where(
        and(eq(membershipTable.companyId, test.companyId), eq(membershipTable.userId, personId)),
      ),
  )
  return { invitation, memberships }
})

describe.skipIf(!testDatabaseConfigured)('Accepting an invitation', () => {
  layer(testLayer)((it) => {
    /** The production auth adapter signs up on its own SQL connection with the live adapter clock. */
    it.effect('refuses a password account that registered the invited address unverified', () =>
      Effect.gen(function* () {
        const test = yield* invited()
        const holder = yield* signedUp(test.email)
        // Better Auth stores a password sign-up as unverified and signs it in regardless.
        expect(holder.verified).toBe(false)
        const store = yield* CompanyStore
        // Its own tag, carrying who asked and for which invitation: not the `Forbidden` a wrong
        // address gets, so a client never tells this Person their address is the wrong one. Any
        // other failure stays a failure here and an accept is not the context, so both fail the test.
        const refused = yield* store.accept(holder, test.invitationId).pipe(
          Effect.as('accepted' as const),
          Effect.catchTag('MailboxUnconfirmed', (failure) =>
            Effect.succeed({ personId: failure.personId, invitationId: failure.invitationId }),
          ),
          Effect.result,
        )
        expect(refused).toEqual(
          Result.succeed({ personId: holder.id, invitationId: test.invitationId }),
        )
        // The invitation is still open for the address's real owner, and no role was granted.
        expect(yield* outcome(test, holder.id)).toEqual({
          invitation: { status: 'pending' },
          memberships: [],
        })
      }).pipe(Effect.scoped),
    )

    /** The stored flag is what a Google sign-in or a completed verification writes. */
    it.effect('grants the invited role once the stored address is verified', () =>
      Effect.gen(function* () {
        const test = yield* invited()
        const holder = yield* signedUp(test.email)
        const database = yield* Database
        yield* database.run(
          database
            .update(personTable)
            .set({ emailVerified: true })
            .where(eq(personTable.id, holder.id)),
        )
        const store = yield* CompanyStore
        const joined = yield* store.accept(holder, test.invitationId)
        expect(joined.member.role).toBe('admin')
        expect(yield* outcome(test, holder.id)).toEqual({
          invitation: { status: 'accepted' },
          memberships: [{ role: 'admin' }],
        })
      }).pipe(Effect.scoped),
    )

    it.effect('refuses a verified Person whose address is not the invited one', () =>
      Effect.gen(function* () {
        const test = yield* invited()
        const database = yield* Database
        const other = PersonId.make(NodeCrypto.randomUUID())
        yield* Effect.addFinalizer(() =>
          database.run(database.delete(personTable).where(eq(personTable.id, other))).pipe(
            Effect.asVoid,
            Effect.catch(() => Effect.sync(() => expect.fail('Company fixture cleanup failed'))),
          ),
        )
        yield* database.run(
          database.insert(personTable).values({
            id: other,
            name: 'Other',
            email: `${other}@example.test`,
            emailVerified: true,
          }),
        )
        const store = yield* CompanyStore
        const refused = yield* store
          .accept({ id: other, name: 'Other' }, test.invitationId)
          .pipe(Effect.result)
        expect(Result.isFailure(refused) ? refused.failure._tag : 'accepted').toBe('Forbidden')
        expect(yield* outcome(test, other)).toEqual({
          invitation: { status: 'pending' },
          memberships: [],
        })
      }).pipe(Effect.scoped),
    )
  })
})
