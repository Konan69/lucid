import { and, eq } from 'drizzle-orm'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import {
  DatabaseFailure,
  Forbidden,
  SessionId,
  Unauthenticated,
  Company,
  Membership,
  Person,
} from '@vivid/contracts'
import { AuthContext } from '@vivid/contracts/api'
import { AuthState } from '@vivid/contracts/api'
import { Database, type PersistedFields } from '../database/client.ts'
import { companyTable, membershipTable } from '../companies/tables.ts'
import { personTable, sessionTable } from './tables.ts'
import { authEffect, localAuthRuntimeLayer } from './provider.ts'

export const requirePerson = Effect.fn('Auth.requirePerson')(function* () {
  const auth = yield* AuthContext
  if (!AuthState.$is('Person')(auth)) {
    return yield* Effect.fail(new Forbidden({ message: 'A Person session is required' }))
  }
  return auth
})

export const requireActiveCompany = Effect.fn('Auth.requireActiveCompany')(function* () {
  const auth = yield* requirePerson()
  if (auth.activeCompany === undefined || auth.membership === undefined) {
    return yield* Effect.fail(new Forbidden({ message: 'An active Company is required' }))
  }
  return { auth, company: auth.activeCompany, membership: auth.membership }
})

const decode = <A>(schema: Schema.ConstraintDecoder<A>, value: PersistedFields) =>
  Schema.decodeUnknownEffect(schema)(value).pipe(
    Effect.mapError(
      () => new DatabaseFailure({ message: 'Database returned invalid authentication data' }),
    ),
  )

/** Resolves Better Auth identity into Vivid's Person, Company, and Membership context. */
export const authenticate = Effect.fn('Auth.authenticate')(function* (headers: Headers) {
  const auth = yield* authEffect
  const session = yield* auth.getSession(headers).pipe(
    Effect.provide(localAuthRuntimeLayer),
    Effect.mapError(() => new Unauthenticated({ message: 'Invalid session' })),
  )
  if (session === null)
    return yield* Effect.fail(new Unauthenticated({ message: 'Authentication required' }))
  const database = yield* Database
  const people = yield* database.run(
    database.select().from(personTable).where(eq(personTable.id, session.user.id)).limit(1),
  )
  const personRow = people[0]
  if (personRow === undefined)
    return yield* Effect.fail(new Unauthenticated({ message: 'Person no longer exists' }))
  const person = yield* decode(Person, {
    id: personRow.id,
    name: personRow.name,
    email: personRow.email,
    image: personRow.image,
  })
  const sessions = yield* database.run(
    database
      .select({ activeCompanyId: sessionTable.activeCompanyId })
      .from(sessionTable)
      .where(eq(sessionTable.id, session.session.id))
      .limit(1),
  )
  const base = AuthState.Person({ person, sessionId: SessionId.make(session.session.id) })
  const sessionRow = sessions[0]
  if (sessionRow === undefined || sessionRow.activeCompanyId === null) return base
  const activeCompanyId = sessionRow.activeCompanyId
  const rows = yield* database.run(
    database
      .select({ company: companyTable, membership: membershipTable })
      .from(membershipTable)
      .innerJoin(companyTable, eq(membershipTable.companyId, companyTable.id))
      .where(
        and(eq(membershipTable.companyId, activeCompanyId), eq(membershipTable.userId, person.id)),
      )
      .limit(1),
  )
  const active = rows[0]
  if (active === undefined) return base
  const [activeCompany, membership] = yield* Effect.all([
    decode(Company, {
      id: active.company.id,
      name: active.company.name,
      slug: active.company.slug,
    }),
    decode(Membership, {
      id: active.membership.id,
      companyId: active.membership.companyId,
      personId: active.membership.userId,
      role: active.membership.role,
    }),
  ])
  return AuthState.Person({ ...base, activeCompany, membership })
})
