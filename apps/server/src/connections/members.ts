import * as NodeCrypto from 'node:crypto'
import { eq, sql } from 'drizzle-orm'
import { DatabaseFailure, type PersonId } from '@vivid/contracts'
import * as Clock from 'effect/Clock'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Redacted from 'effect/Redacted'
import * as Schema from 'effect/Schema'
import * as Cookies from 'effect/http/Cookies'
import * as HttpClient from 'effect/http/HttpClient'
import * as HttpClientRequest from 'effect/http/HttpClientRequest'
import {
  Database,
  decodeStored,
  encodeStored,
  type DatabaseInfrastructureError,
} from '../database/client.ts'
import { memberFailure } from './errors.ts'
import {
  Executor,
  ExecutorAccessDenied,
  ExecutorCaller,
  ExecutorRateLimited,
  ExecutorResponseInvalid,
  ExecutorTransportFailure,
  executorAddress,
  installationCaller,
  type ExecutorPrincipal,
} from './executor.ts'
import { seal, sealSecret, unseal, type SealSecret } from './seal.ts'
import { executorMembers } from './tables.ts'
import { ExecutorAuthorization, ExecutorSignIn } from './issuer.ts'

/**
 * Each Person's own Executor member, made the first time one of their own Connections needs it.
 *
 * Executor separates members by itself: a member's new app is "Only me", a personal account is
 * used only by the member who connected it, and an owner can manage another member's private app
 * but not call it (executor@2.0.0-beta.23 `apps/docs/content/concepts/organizations-and-access.md`).
 * Sending a Person's Connection calls with their member's key therefore makes Executor, not only
 * Vivid's row mapping, refuse anyone else.
 *
 * Members originate through Vivid's SSO provider. Executor creates a verified user and its SSO
 * account together, so later browser sign-in never needs to link an unverified credential user.
 * The returned session mints the member's organization-pinned key.
 */
export interface ExecutorMembersService {
  /** The credential to send for a Connection's app and account, decided by its principal. */
  readonly caller: (connection: {
    readonly principal: ExecutorPrincipal
    readonly personId: PersonId
  }) => Effect.Effect<ExecutorCaller, MemberFailure>
}

export class ExecutorMembers extends Context.Service<ExecutorMembers, ExecutorMembersService>()(
  'vivid/ExecutorMembers',
) {}

export type MemberFailure =
  | ExecutorTransportFailure
  | ExecutorRateLimited
  | ExecutorAccessDenied
  | ExecutorResponseInvalid
  | DatabaseInfrastructureError

const ExecutorUserId = Schema.NonEmptyString.pipe(Schema.brand('ExecutorUserId'))

/**
 * Where a Person's member is. `Provisioning` is written before Executor is first asked anything,
 * so a crash at any later step leaves the email to continue with; `Ready` holds the member's user
 * id and its sealed key (`seal.ts`).
 */
export const MemberState = Schema.TaggedUnion({
  Provisioning: {},
  Ready: { user: ExecutorUserId, sealedKey: Schema.NonEmptyString },
})
type MemberState = typeof MemberState.Type
const decodeState = decodeStored(MemberState, 'Executor member')
const encodeState = encodeStored(MemberState, 'Executor member')

const context = { service: 'connections' as const, tool: null }
const SignInAddress = Schema.Struct({ url: Schema.String })
const CreatedKey = Schema.Struct({ key: Schema.NonEmptyString })
const CurrentSession = Schema.Struct({ user: Schema.Struct({ id: ExecutorUserId }) })

/** A Better Auth session as the header that carries it on the next request. */
type Session = Redacted.Redacted<string>

/** One answer from Executor's auth routes, read whole before its response is released. */
interface Answer {
  readonly status: number
  readonly cookies: Cookies.Cookies
  readonly body: Option.Option<Schema.Json>
  readonly location: Option.Option<string>
}

/** A 2xx body in the expected shape; any other answer is Executor refusing this caller. */
const read =
  <A, I>(schema: Schema.Codec<A, I>) =>
  (answer: Answer): Effect.Effect<A, ExecutorResponseInvalid | ExecutorAccessDenied> =>
    answer.status >= 200 && answer.status < 300 && Option.isSome(answer.body)
      ? Schema.decodeUnknownEffect(schema)(answer.body.value).pipe(
          Effect.mapError(() => ExecutorResponseInvalid.make(context)),
        )
      : Effect.fail(ExecutorAccessDenied.make(context))

/** The session cookies an answer set, as one `cookie` header. */
const sessionOf = (answer: Answer) =>
  Cookies.isEmpty(answer.cookies)
    ? Effect.fail(ExecutorResponseInvalid.make(context))
    : Effect.succeed(Redacted.make(Cookies.toCookieHeader(answer.cookies)))

/**
 * The calls to Executor's auth routes. Each sends the instance's own origin, which Better Auth
 * checks on cookie-authenticated writes, and carries the state/session cookie between requests.
 */
function makeAuth(transport: HttpClient.HttpClient, url: string, origin: string) {
  const client = HttpClient.withScope(transport)
  /** Send one request. A limit and a server failure stay distinct from a refusal. */
  const exchange = Effect.fn('ExecutorMembers.exchange')(
    function* (request: HttpClientRequest.HttpClientRequest, session: Option.Option<Session>) {
      const prepared = request.pipe(
        HttpClientRequest.setHeader('origin', origin),
        HttpClientRequest.acceptJson,
        (withOrigin) =>
          Option.match(session, {
            onNone: () => withOrigin,
            onSome: (cookie) =>
              HttpClientRequest.setHeader(withOrigin, 'cookie', Redacted.value(cookie)),
          }),
      )
      const response = yield* client
        .execute(prepared)
        .pipe(Effect.mapError(() => ExecutorTransportFailure.make(context)))
      if (response.status === 429) return yield* ExecutorRateLimited.make(context)
      if (response.status >= 500) return yield* ExecutorTransportFailure.make(context)
      const body = yield* response.json.pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.Json)),
        Effect.option,
      )
      const answer: Answer = { status: response.status, cookies: response.cookies, body, location: Option.fromUndefinedOr(response.headers['location']) }
      return answer
    },
    Effect.scoped,
    Effect.timeoutOrElse({
      duration: '30 seconds',
      orElse: () => Effect.fail(ExecutorTransportFailure.make(context)),
    }),
  )
  const post = (path: string, body: Schema.Json, session: Option.Option<Session>) =>
    HttpClientRequest.bodyJson(HttpClientRequest.post(`${url}/api/auth${path}`), body).pipe(
      Effect.mapError(() => ExecutorResponseInvalid.make(context)),
      Effect.flatMap((request) => exchange(request, session)),
    )
  return {
    /** Keep Executor's state cookie server-side; only this issuer may approve the returned request. */
    signIn: Effect.fn('ExecutorMembers.signIn')(function* (email: string, issuer: ExecutorSignIn['Service']) {
      const started = yield* post('/sign-in/social', { provider: 'sso', callbackURL: origin, disableRedirect: true }, Option.none())
      const address = yield* read(SignInAddress)(started)
      const authorizationUrl = yield* Schema.decodeUnknownEffect(Schema.URLFromString)(address.url).pipe(Effect.mapError(() => ExecutorResponseInvalid.make(context)))
      if (authorizationUrl.href.split('?')[0] !== issuer.discovery.authorization_endpoint)
        return yield* ExecutorResponseInvalid.make(context)
      const authorization = yield* Schema.decodeUnknownEffect(ExecutorAuthorization)(Object.fromEntries(authorizationUrl.searchParams)).pipe(Effect.mapError(() => ExecutorResponseInvalid.make(context)))
      const callback = yield* issuer.issue(email, authorization).pipe(Effect.mapError(() => ExecutorAccessDenied.make(context)))
      // Executor advertises its public callback. Internal transport still reaches that exact route
      // on the private origin, while cookie-write Origin checks use the public browser origin.
      const completed = yield* exchange(HttpClientRequest.get(`${url}${callback.pathname}${callback.search}`), Option.some(yield* sessionOf(started)))
      if (completed.status !== 302 || Option.isNone(completed.location) || new URL(completed.location.value).searchParams.has('error'))
        return yield* ExecutorAccessDenied.make(context)
      return yield* sessionOf(completed)
    }),
    /** Pinned to the organization; no expiry, as the installation key has none. */
    mintKey: (member: Session, organization: string) =>
      post(
        '/api-key/create',
        { name: 'Vivid', metadata: { organization } },
        Option.some(member),
      ).pipe(
        Effect.flatMap(read(CreatedKey)),
        Effect.map(({ key }) => Redacted.make(key)),
      ),
    userOf: (member: Session) =>
      exchange(HttpClientRequest.get(`${url}/api/auth/get-session`), Option.some(member)).pipe(
        Effect.flatMap(read(CurrentSession)),
        Effect.map(({ user }) => user.id),
      ),
  }
}
type Auth = ReturnType<typeof makeAuth>

/** A random sign-in that says nothing about the Person; `.invalid` is reserved never to resolve. */
const newMemberEmail = () => `m-${NodeCrypto.randomBytes(12).toString('hex')}@members.vivid.invalid`

/** Serializes provisioning for one Person across every server process. */
const memberLock = (person: PersonId) =>
  sql`select pg_advisory_xact_lock(hashtextextended(${`vivid-executor-member:${person}`}, 0))`

const makeMembers = Effect.fn('ExecutorMembers.make')(function* () {
  const database = yield* Database
  const { url, organization } = yield* executorAddress()
  const issuer = yield* ExecutorSignIn
  const origin = yield* issuer.dashboard.pipe(Effect.mapError(() => ExecutorAccessDenied.make(context)))
  const secret = yield* sealSecret()
  const auth = makeAuth(yield* HttpClient.HttpClient, url, origin)
  const provision = makeProvision({ auth, issuer, secret, organization })

  /** The member's key from a Ready row, opened for this request only. */
  const keyOf = (person: PersonId, state: Extract<MemberState, { readonly _tag: 'Ready' }>) =>
    unseal(secret, person, state.sealedKey).pipe(
      Effect.map((key) => ExecutorCaller.cases.Member.make({ key })),
    )

  const member = Effect.fn('ExecutorMembers.member')(function* (person: PersonId) {
    const existing = yield* database.run(readMember(database, person))
    if (Option.isSome(existing) && MemberState.guards.Ready(existing.value.state))
      return yield* keyOf(person, existing.value.state)
    const claimed = yield* claimMember(database, person)
    // Executor calls run inside the lock's transaction so a second process waits for this one's
    // member instead of making another; the Provisioning row they continue from is already
    // committed, so a failure here leaves it for the next attempt.
    const ready = yield* completeMember(database, person, () => provision(person, claimed))
    return yield* keyOf(person, ready)
  })

  return ExecutorMembers.of({
    caller: ({ principal, personId }) =>
      principal === 'installation' ? Effect.succeed(installationCaller) : member(personId),
  })
})

/** Hold the per-Person lock until Executor's result and its sealed key commit together. */
const completeMember = Effect.fn('ExecutorMembers.complete')(function* (
  database: Database['Service'],
  person: PersonId,
  provision: () => Effect.Effect<Extract<MemberState, { readonly _tag: 'Ready' }>, MemberFailure>,
) {
  return yield* database.transaction((tx) =>
    Effect.gen(function* () {
      yield* tx.execute(memberLock(person))
      const current = yield* readMember(tx, person)
      if (Option.isSome(current) && MemberState.guards.Ready(current.value.state))
        return current.value.state
      const state = yield* provision()
      const now = yield* Clock.currentTimeMillis
      yield* tx
        .update(executorMembers)
        .set({ state: yield* encodeState(state), updatedAt: now })
        .where(eq(executorMembers.personId, person))
      return state
    }),
  )
})

type Reader = Pick<Database['Service'], 'select'>

/** The Person's member row, decoded. */
const readMember = Effect.fn('ExecutorMembers.read')(function* (
  database: Reader,
  person: PersonId,
) {
  const rows = yield* database
    .select({ email: executorMembers.email, state: executorMembers.state })
    .from(executorMembers)
    .where(eq(executorMembers.personId, person))
  const [row] = rows
  if (row === undefined) return Option.none()
  return Option.some({ email: row.email, state: yield* decodeState(row.state) })
})

/**
 * Persist the member's random SSO identity before making external requests, so every retry uses it.
 */
const claimMember = Effect.fn('ExecutorMembers.claim')(function* (
  database: Database['Service'],
  person: PersonId,
) {
  const now = yield* Clock.currentTimeMillis
  const inserted = yield* database.run(
    database
      .insert(executorMembers)
      .values({
        personId: person,
        email: newMemberEmail(),
        state: yield* encodeState(MemberState.cases.Provisioning.make({})),
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing({ target: executorMembers.personId })
      .returning({ email: executorMembers.email }),
  )
  const [made] = inserted
  if (made !== undefined) return { email: made.email }
  // Another attempt made the row first; a Person deleted meanwhile has no row to continue.
  const existing = yield* database.run(readMember(database, person))
  if (Option.isNone(existing))
    return yield* new DatabaseFailure({
      message: 'Executor member was not returned by the database',
    })
  return { email: existing.value.email }
})

/** Repeat the same SSO identity after a crash, then mint a key and seal it for this Person. */
function makeProvision(input: {
  readonly auth: Auth
  readonly issuer: ExecutorSignIn['Service']
  readonly secret: SealSecret
  readonly organization: string
}) {
  const { auth, issuer, secret, organization } = input
  return Effect.fn('ExecutorMembers.provision')(function* (
    person: PersonId,
    claimed: { readonly email: string },
  ) {
    const session = yield* auth.signIn(claimed.email, issuer)
    const key = yield* auth.mintKey(session, organization)
    const user = yield* auth.userOf(session)
    return MemberState.cases.Ready.make({ user, sealedKey: seal(secret, person, key) })
  })
}

/** Browser authorization first provisions through the same serialized path as an Integration. */
export const executorIdentity = Effect.fn('ExecutorMembers.identity')(function* (person: PersonId) {
  const members = yield* ExecutorMembers
  yield* members.caller({ principal: 'member', personId: person })
  const database = yield* Database
  const identity = yield* database.run(readMember(database, person))
  if (Option.isNone(identity)) return yield* ExecutorAccessDenied.make(context)
  return identity.value.email
})

/**
 * The caller a Connection's app and account are reached as: the installation owner, or the
 * Person's own member, made on first use. A member that cannot be made or read answers as any
 * other Executor failure.
 */
export const callerOf = (connection: {
  readonly executorPrincipal: ExecutorPrincipal
  readonly personId: PersonId
}) =>
  Effect.flatMap(ExecutorMembers, (members) =>
    members.caller({ principal: connection.executorPrincipal, personId: connection.personId }),
  ).pipe(Effect.mapError(memberFailure))

/** The adapter's operations on one Connection, sent as its own caller (`callerOf`). */
export const operationsOf = Effect.fn('ExecutorMembers.operationsOf')(function* (connection: {
  readonly executorPrincipal: ExecutorPrincipal
  readonly personId: PersonId
}) {
  const caller = yield* callerOf(connection)
  return (yield* Executor).as(caller)
})

/** Requires Database, HttpClient and the Executor settings; a missing one stops launch. */
export const executorMembersLayer = Layer.effect(ExecutorMembers, makeMembers())
