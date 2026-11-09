import * as NodeCrypto from 'node:crypto'
import { eq, sql } from 'drizzle-orm'
import { DatabaseFailure, type PersonId } from '@vivid/contracts'
import * as Clock from 'effect/Clock'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Match from 'effect/Match'
import * as Option from 'effect/Option'
import * as Redacted from 'effect/Redacted'
import * as Ref from 'effect/Ref'
import * as Schema from 'effect/Schema'
import * as Cookies from 'effect/http/Cookies'
import * as HttpClient from 'effect/http/HttpClient'
import * as HttpClientRequest from 'effect/http/HttpClientRequest'
import { requiredSetting, settingSecret, settingText } from '../config.ts'
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
  ExecutorUserId,
  ExecutorRateLimited,
  ExecutorResponseInvalid,
  ExecutorTransportFailure,
  executorAddress,
  installationCaller,
  type ExecutorPrincipal,
  type ExecutorConnectionOperations,
} from './executor.ts'
import { memberPassword, seal, sealSecret, unseal, type SealSecret } from './seal.ts'
import { executorMembers } from './tables.ts'

/**
 * Each Person's own Executor member, made the first time one of their own Connections needs it.
 *
 * Executor separates members by itself: a member's new app is "Only me", a personal account is
 * used only by the member who connected it, and an owner can manage another member's private app
 * but not call it (executor@2.0.0-beta.23 `apps/docs/content/concepts/organizations-and-access.md`).
 * Sending a Person's Connection calls with their member's key therefore makes Executor, not only
 * Vivid's row mapping, refuse anyone else.
 *
 * Self-host sends no invitation email, so the owner adds a member in one exchange
 * (`apps/hosted/self-host/src/implementation/registration.ts`): the owner signs in, invites an
 * address, and redeeming the invitation (`/self-host/register`) creates the user, its membership
 * and a session together. That session mints the member's organization-pinned key
 * (`/api-key/create`, `apps/hosted/server/src/contracts/api-keys.ts` `CreateApiKey`). The
 * installation key cannot do any of this: API keys do not open sessions
 * (`enableSessionForAPIKeys: false`).
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
const Invitation = Schema.Struct({ id: Schema.NonEmptyString })
const CreatedKey = Schema.Struct({ key: Schema.NonEmptyString })
const CurrentSession = Schema.Struct({ user: Schema.Struct({ id: ExecutorUserId }) })

/** A Better Auth session as the header that carries it on the next request. */
type Session = Redacted.Redacted<string>

/** One answer from Executor's auth routes, read whole before its response is released. */
interface Answer {
  readonly status: number
  readonly cookies: Cookies.Cookies
  readonly body: Option.Option<Schema.Json>
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
 * checks on cookie-authenticated writes, and carries a session as its cookie header. Sign-in
 * answers `None` when Executor refuses the email and password, which is how a retry finds out
 * whether an earlier attempt already made the member.
 */
function makeAuth(transport: HttpClient.HttpClient, url: string) {
  const client = HttpClient.withScope(transport)
  const origin = new URL(url).origin
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
      const answer: Answer = { status: response.status, cookies: response.cookies, body }
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
    signIn: Effect.fn('ExecutorMembers.signIn')(function* (
      email: string,
      password: Redacted.Redacted<string>,
    ) {
      const answer = yield* post(
        '/sign-in/email',
        { email, password: Redacted.value(password) },
        Option.none(),
      )
      if (answer.status === 401 || answer.status === 403) return Option.none<Session>()
      if (answer.status !== 200) return yield* ExecutorAccessDenied.make(context)
      return Option.some(yield* sessionOf(answer))
    }),
    /** `None` when Executor no longer accepts the owner's session. */
    invite: Effect.fn('ExecutorMembers.inviteAs')(function* (
      owner: Session,
      organization: string,
      email: string,
    ) {
      const answer = yield* post(
        '/organization/invite-member',
        { organizationId: organization, email, role: 'member', resend: true },
        Option.some(owner),
      )
      if (answer.status === 401) return Option.none<string>()
      return Option.some((yield* read(Invitation)(answer)).id)
    }),
    register: Effect.fn('ExecutorMembers.register')(function* (
      email: string,
      password: Redacted.Redacted<string>,
      invitation: string,
    ) {
      const answer = yield* post(
        '/self-host/register',
        { name: 'Vivid member', email, password: Redacted.value(password), invitation },
        Option.none(),
      )
      if (answer.status !== 200) return yield* ExecutorAccessDenied.make(context)
      return yield* sessionOf(answer)
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

/**
 * The installation owner's session, kept between provisionings: Executor allows only a few
 * sign-ins per window from one address, and every member needs the owner to invite it. A session
 * Executor no longer accepts is replaced once.
 */
const makeOwner = Effect.fn('ExecutorMembers.owner')(function* (
  auth: Auth,
  credentials: { readonly email: string; readonly password: Redacted.Redacted<string> },
  organization: string,
) {
  const held = yield* Ref.make(Option.none<Session>())
  const session = Effect.fn('ExecutorMembers.ownerSession')(function* (fresh: boolean) {
    const current = yield* Ref.get(held)
    if (!fresh && Option.isSome(current)) return current.value
    const signedIn = yield* auth.signIn(credentials.email, credentials.password)
    // The owner's own sign-in refused is a wrong setting, not a member to make.
    if (Option.isNone(signedIn)) return yield* ExecutorAccessDenied.make(context)
    yield* Ref.set(held, signedIn)
    return signedIn.value
  })
  return Effect.fn('ExecutorMembers.invite')(function* (email: string) {
    const first = yield* auth.invite(yield* session(false), organization, email)
    if (Option.isSome(first)) return first.value
    const retried = yield* auth.invite(yield* session(true), organization, email)
    if (Option.isNone(retried)) return yield* ExecutorAccessDenied.make(context)
    return retried.value
  })
})

/** A random sign-in that says nothing about the Person; `.invalid` is reserved never to resolve. */
const newMemberEmail = () => `m-${NodeCrypto.randomBytes(12).toString('hex')}@members.vivid.invalid`

/** Serializes provisioning for one Person across every server process. */
const memberLock = (person: PersonId) =>
  sql`select pg_advisory_xact_lock(hashtextextended(${`vivid-executor-member:${person}`}, 0))`

const makeMembers = Effect.fn('ExecutorMembers.make')(function* () {
  const database = yield* Database
  const { organization } = yield* executorAddress()
  const ownerEmail = yield* requiredSetting(
    'VIVID_EXECUTOR_OWNER_EMAIL',
    settingText,
    "the Executor owner's email",
  )
  const ownerPassword = yield* requiredSetting(
    'VIVID_EXECUTOR_OWNER_PASSWORD',
    settingSecret,
    "the Executor owner's password",
  )
  // Executor's sign-in routes check the Origin against the address browsers use (its public
  // domain, from which it derives its own auth URL). The private mesh address the API calls use is
  // refused there, so every member sign-in goes to the public address.
  const publicUrl = yield* requiredSetting(
    'VIVID_EXECUTOR_PUBLIC_URL',
    Schema.NonEmptyString.check(
      Schema.makeFilter((value) => URL.canParse(value) || 'an absolute URL'),
    ),
    "Executor's public absolute URL",
  )
  const secret = yield* sealSecret()
  const auth = makeAuth(yield* HttpClient.HttpClient, publicUrl.replace(/\/$/u, ''))
  const invite = yield* makeOwner(
    auth,
    { email: ownerEmail, password: ownerPassword },
    organization,
  )
  const provision = makeProvision({ auth, invite, secret, organization })

  /** The member's key from a Ready row, opened for this request only. */
  const keyOf = (person: PersonId, state: Extract<MemberState, { readonly _tag: 'Ready' }>) =>
    unseal(secret, person, state.sealedKey).pipe(
      Effect.map((key) => ExecutorCaller.cases.Member.make({ user: state.user, key })),
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
      Match.value(principal).pipe(
        Match.when('installation', () => Effect.succeed(installationCaller)),
        Match.whenOr('member', 'adopted-account', 'adopted-public', () => member(personId)),
        Match.exhaustive,
      ),
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
 * The Person's member email, written as Provisioning on the first ask. `fresh` says this call made
 * the row, so Executor has never been asked about the email and the sign-in a retry starts with
 * can be skipped, which keeps provisioning inside Executor's sign-in limit.
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
  if (made !== undefined) return { email: made.email, fresh: true }
  // Another attempt made the row first; a Person deleted meanwhile has no row to continue.
  const existing = yield* database.run(readMember(database, person))
  if (Option.isNone(existing))
    return yield* new DatabaseFailure({
      message: 'Executor member was not returned by the database',
    })
  return { email: existing.value.email, fresh: false }
})

/**
 * Make or find the member for an email and mint its key. Idempotent from any point it stopped:
 * a member already registered is found by signing in with its derived password; one that is not
 * is invited and registered; then a key is minted from that session. A key minted by an attempt
 * whose write was lost stays unused at Executor.
 */
function makeProvision(input: {
  readonly auth: Auth
  readonly invite: (email: string) => Effect.Effect<string, MemberFailure>
  readonly secret: SealSecret
  readonly organization: string
}) {
  const { auth, invite, secret, organization } = input
  return Effect.fn('ExecutorMembers.provision')(function* (
    person: PersonId,
    claimed: { readonly email: string; readonly fresh: boolean },
  ) {
    const password = memberPassword(secret, claimed.email)
    const existing = claimed.fresh
      ? Option.none<Session>()
      : yield* auth.signIn(claimed.email, password)
    const session = Option.isSome(existing)
      ? existing.value
      : yield* auth.register(claimed.email, password, yield* invite(claimed.email))
    const key = yield* auth.mintKey(session, organization)
    const user = yield* auth.userOf(session)
    return MemberState.cases.Ready.make({ user, sealedKey: seal(secret, person, key) })
  })
}

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

/** Watch authority is explicit for every principal. Account delegation grants app use, not
 * direct personal-account use, which beta.23 requires when authorizing event delivery. */
export const watchPrincipal = (principal: ExecutorPrincipal) =>
  Match.value(principal).pipe(
    Match.whenOr('installation', 'adopted-account', () => 'installation' as const),
    Match.whenOr('member', 'adopted-public', () => 'member' as const),
    Match.exhaustive,
  )

/** Separate execution from creator management, with the status authority chosen by the case. */
function adoptedOperations(
  management: ExecutorConnectionOperations,
  execution: ExecutorConnectionOperations,
  status: ExecutorConnectionOperations['status'],
): ExecutorConnectionOperations {
  return {
    ...management,
    appSlug: (app) => execution.appSlug(app),
    tools: (references) => execution.tools(references),
    call: (input) => execution.call(input),
    status,
    refresh: execution.refresh,
    reviseMade: (app, files) =>
      management.reviseMade(app, files).pipe(Effect.tap(() => execution.refresh)),
  }
}

/** Adopted Account status uses the same owner authority as reauthorize's initial status probe. */
export const operationsOf = Effect.fn('ExecutorMembers.operationsOf')(function* (connection: {
  readonly executorPrincipal: ExecutorPrincipal
  readonly personId: PersonId
}) {
  const caller = yield* callerOf(connection)
  const executor = yield* Executor
  const own = executor.as(caller)
  const owner = executor.as(installationCaller)
  return Match.value(connection.executorPrincipal).pipe(
    Match.whenOr('installation', 'member', () => own),
    Match.when('adopted-account', () =>
      adoptedOperations(owner, own, (references) => owner.status(references)),
    ),
    Match.when('adopted-public', () =>
      adoptedOperations(owner, own, (references) => own.status(references)),
    ),
    Match.exhaustive,
  )
})

/** Requires Database, HttpClient and the Executor settings; a missing one stops launch. */
export const executorMembersLayer = Layer.effect(ExecutorMembers, makeMembers())
