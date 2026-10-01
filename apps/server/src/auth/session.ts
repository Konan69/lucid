import { and, eq } from 'drizzle-orm'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import {
  Company,
  Forbidden,
  NotFound,
  PersonId,
  Role,
  SessionId,
  ThreadId,
  Unauthenticated,
  Workspace,
} from '@vivid/contracts'
import { AuthState } from '@vivid/contracts/auth'
import { companyTable, membershipTable } from '../companies/tables.ts'
import { Database, decodeStored } from '../database/client.ts'
import { canSee, findThread } from '../threads/access.ts'
import { findPerson } from './access.ts'
import { authEffect, localAuthRuntimeLayer } from './provider.ts'
import { sessionTable } from './tables.ts'

const decodeCompany = decodeStored(Company, 'Company')
const decodeRole = decodeStored(Role, 'Membership role')
const decodePersonId = decodeStored(PersonId, 'Person id')
const decodeThreadId = decodeStored(ThreadId, 'Thread id')

/**
 * The workspace a Person is in when their session names a Company.
 *
 * A session's active Company is a preference, not a permission: the Membership is read on every
 * call, so a Person removed from a Company is back in their personal space on their next request
 * without anyone having to end their session.
 */
export const workspaceIn = Effect.fn('Auth.workspaceIn')(function* (
  personId: PersonId,
  companyId: Option.Option<string>,
) {
  if (Option.isNone(companyId)) return Workspace.cases.Personal.make({})
  const database = yield* Database
  const rows = yield* database.run(
    database
      .select({ company: companyTable, role: membershipTable.role })
      .from(membershipTable)
      .innerJoin(companyTable, eq(membershipTable.companyId, companyTable.id))
      .where(
        and(eq(membershipTable.companyId, companyId.value), eq(membershipTable.userId, personId)),
      )
      .limit(1),
  )
  const row = rows[0]
  if (row === undefined) return Workspace.cases.Personal.make({})
  const company = yield* decodeCompany({
    id: row.company.id,
    name: row.company.name,
    slug: row.company.slug,
  })
  return Workspace.cases.Company.make({ company, role: yield* decodeRole(row.role) })
})

/** Resolves a Better Auth session, cookie or bearer, into the Person and where they are working. */
export const authenticate = Effect.fn('Auth.authenticate')(function* (headers: Headers) {
  const auth = yield* authEffect
  const session = yield* auth.getSession(headers).pipe(
    Effect.provide(localAuthRuntimeLayer),
    Effect.mapError(() => new Unauthenticated({ message: 'Invalid session' })),
  )
  if (session === null)
    return yield* Effect.fail(new Unauthenticated({ message: 'Authentication required' }))
  const person = yield* findPerson(session.user.id)
  if (Option.isNone(person))
    return yield* Effect.fail(new Unauthenticated({ message: 'Person no longer exists' }))
  const sessionId = SessionId.make(session.session.id)
  return AuthState.Person({
    person: person.value,
    sessionId,
    workspace: yield* sessionWorkspace(person.value.id, sessionId),
  })
})

/**
 * Where a session is working right now. Read fresh each time it is asked: switching workspace and
 * being removed from a Company both take effect on open live queries without a reconnect.
 */
export const sessionWorkspace = Effect.fn('Auth.sessionWorkspace')(function* (
  personId: PersonId,
  sessionId: SessionId,
) {
  const database = yield* Database
  const sessions = yield* database.run(
    database
      .select({ activeCompanyId: sessionTable.activeCompanyId })
      .from(sessionTable)
      .where(eq(sessionTable.id, sessionId))
      .limit(1),
  )
  const active = Option.flatMap(Option.fromUndefinedOr(sessions[0]), (row) =>
    Option.fromNullOr(row.activeCompanyId),
  )
  return yield* workspaceIn(personId, active)
})

/**
 * Resolves the Person Vivid is acting for from the two headers the runtime sends with a tool call.
 *
 * The runtime is trusted to hold the runtime token, and nothing more. It names a Thread and a
 * Person; the server checks both against its own records before any tool runs: the Thread must
 * exist, the Person must still be able to see it, and the workspace is the Thread's own, with the
 * Person's current role there. A Person who was removed from a Company or from a shared Thread
 * therefore stops being someone Vivid can act for, in the middle of a Run if need be.
 */
export const authenticateVivid = Effect.fn('Auth.authenticateVivid')(function* (input: {
  readonly thread: string
  readonly actor: string
}) {
  const threadId = yield* decodeThreadId(input.thread)
  const personId = yield* decodePersonId(input.actor)
  const thread = yield* findThread(threadId)
  if (Option.isNone(thread))
    return yield* Effect.fail(new NotFound({ message: 'Thread not found' }))
  const person = yield* findPerson(personId)
  if (Option.isNone(person))
    return yield* Effect.fail(new Forbidden({ message: 'Vivid has nobody to act for here' }))
  if (!(yield* canSee(thread.value, person.value.id))) {
    return yield* Effect.fail(new Forbidden({ message: 'Vivid has nobody to act for here' }))
  }
  const workspace = yield* workspaceIn(person.value.id, Option.fromNullOr(thread.value.companyId))
  return AuthState.Vivid({ person: person.value, workspace, threadId })
})
