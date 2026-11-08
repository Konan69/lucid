import {
  ConnectionDataClass,
  ConnectionGrant,
  ConnectionPermission,
  ConnectionState,
  CoverageReason,
  OAuthScope,
  ResultCount,
  ResultAsOf,
  ResultCoverage,
  ScopeEvidence,
  connectionDataClassService,
  type Connection,
  type ResultQuery,
} from '@vivid/contracts'
import { Array as Arr, Data, Option, Schema } from 'effect'

/**
 * What an Integration was given and what it may reach, in a Person's words, for every surface:
 * Settings' account row and sheet, the Thread's card when a call was refused for want of access,
 * and the quiet line under a reply that rests on a partial read.
 *
 * The facts are the server's (`ConnectionGrant`, `ConnectionPermission`, `IntegrationResult`);
 * this file only says them. Scopes and coverage arrive as the runtime left them in a tool call's
 * output, which is unknown JSON, so they are decoded here once with the contract's own schemas.
 */

// ── How an account stands ──────────────────────────────────────────────────

/** Whether a standing is good news, something waiting on the Person, or a fault. */
export type AccessTone = 'good' | 'waiting' | 'bad'

export interface AccessStanding {
  readonly tone: AccessTone
  readonly words: string
}

/**
 * Why an account that is not ready is not ready, from its grant. A lapsed sign-in was called
 * "Sign-in not finished" like one that was never finished; the grant says which it is.
 */
const unready = (grant: ConnectionGrant): string =>
  ConnectionGrant.match(grant, {
    Expired: () => 'Sign-in expired',
    Revoked: () => 'Access was taken away',
    ReauthorizationRequired: () => 'Sign in again to keep using it',
    Unverified: () => 'Sign-in not finished',
    NotRequired: () => 'Sign-in not finished',
    Pending: () => 'Sign-in not finished',
    Granted: () => 'Sign-in not finished',
    Partial: () => 'Sign-in not finished',
  })

/** How one account stands, in a word or two, with the tone its dot is drawn in. */
export const accessStanding = (connection: Connection): AccessStanding =>
  ConnectionState.match(connection.state, {
    Ready: (): AccessStanding =>
      ConnectionGrant.guards.Partial(connection.grant)
        ? { tone: 'waiting', words: 'Connected · some access missing' }
        : { tone: 'good', words: 'Connected' },
    NeedsAuthorization: (): AccessStanding => ({ tone: 'waiting', words: unready(connection.grant) }),
    Failed: ({ reason }): AccessStanding => ({ tone: 'bad', words: `Not working: ${reason}` }),
  })

/**
 * Whether pressing "Reconnect" can do anything: only an account waiting on a sign-in is picked
 * up where it stopped. The server refuses to resume a failed one ("Remove this failed integration
 * and connect again", `resumeExisting`), and a ready one answers at once with nothing to do.
 */
export const canReconnect = (connection: Connection) =>
  ConnectionState.guards.NeedsAuthorization(connection.state)

// ── What it was given ──────────────────────────────────────────────────────

const GOOGLE = 'https://www.googleapis.com/auth/'

/**
 * Google's scopes in a Person's words. These are the ones Vivid asks for at sign-in
 * (`apps/server/src/connections/google.ts`); anything else is shown as the service named it,
 * without the address it is written under.
 */
const SCOPE_WORDS = new Map<string, string>([
  ['openid', 'Your name and email address'],
  ['email', 'Your name and email address'],
  ['profile', 'Your name and email address'],
  [`${GOOGLE}userinfo.email`, 'Your name and email address'],
  [`${GOOGLE}userinfo.profile`, 'Your name and email address'],
  ['https://mail.google.com/', 'Read, send and delete your mail'],
  [`${GOOGLE}gmail.settings.basic`, 'Your mail settings'],
  [`${GOOGLE}calendar`, 'See and change your calendars'],
  [`${GOOGLE}drive`, 'See and change your files in Drive'],
  [`${GOOGLE}drive.file`, 'Files Vivid opens or makes in Drive'],
  [`${GOOGLE}documents`, 'See and change your documents'],
  [`${GOOGLE}spreadsheets`, 'See and change your spreadsheets'],
  [`${GOOGLE}tasks`, 'See and change your tasks'],
])

/** One scope in words: Vivid's own for the ones it asks for, else the service's name for it. */
const scopeWord = (scope: OAuthScope) =>
  Option.getOrElse(Option.fromUndefinedOr(SCOPE_WORDS.get(scope)), () =>
    scope.replace(GOOGLE, ''),
  )

/** Each scope once, in words, in the order the service listed them. */
export const scopeWords = (scopes: ReadonlyArray<OAuthScope>): ReadonlyArray<string> =>
  Arr.dedupe(scopes.map(scopeWord))

/**
 * What an account was given, as an account's sheet or row says it under "Access". `given` and
 * `missing` are words (`scopeWords`); `summary` is the one line said when there is no list, or
 * over it.
 */
export interface Granted {
  readonly summary: string
  readonly given: ReadonlyArray<string>
  readonly missing: ReadonlyArray<string>
}

const known = (evidence: ScopeEvidence): ReadonlyArray<string> =>
  ScopeEvidence.match(evidence, {
    Known: ({ values }) => scopeWords(values),
    Unreported: () => [],
    NotApplicable: () => [],
  })

/** What the server saw the account given, never what was asked for at sign-in. */
export const grantedOf = (grant: ConnectionGrant): Granted =>
  ConnectionGrant.match(grant, {
    Unverified: (): Granted => ({ summary: 'Not checked yet', given: [], missing: [] }),
    NotRequired: (): Granted => ({ summary: 'Needs no sign-in', given: [], missing: [] }),
    Pending: (): Granted => ({ summary: 'Nothing yet: sign-in not finished', given: [], missing: [] }),
    Granted: ({ scopes }): Granted => ({
      summary: ScopeEvidence.guards.Known(scopes)
        ? 'Everything Vivid asked for'
        : 'Allowed, though the service does not say exactly what',
      given: known(scopes),
      missing: [],
    }),
    Partial: ({ granted, missing }): Granted => ({
      summary: 'Some of what Vivid asked for',
      given: scopeWords(granted),
      missing: scopeWords(missing),
    }),
    Expired: (): Granted => ({ summary: 'Nothing now: the sign-in expired', given: [], missing: [] }),
    Revoked: (): Granted => ({ summary: 'Nothing now: access was taken away', given: [], missing: [] }),
    ReauthorizationRequired: (): Granted => ({
      summary: 'Nothing until you sign in again',
      given: [],
      missing: [],
    }),
  })

// ── What Vivid may read through it ─────────────────────────────────────────

/** Each kind of data a Person can keep from Vivid on one account, in their words. */
export const DATA_CLASS = {
  GmailDrafts: { name: 'Drafts', detail: 'Mail you have written and not sent' },
  CalendarEventSchedules: {
    name: 'Event times',
    detail: 'What is on your calendar and when you are free',
  },
} as const satisfies Record<ConnectionDataClass, { name: string; detail: string }>

/** One kind of data on an account, and whether Vivid may read it now. */
export interface DataClassAccess {
  readonly dataClass: ConnectionDataClass
  readonly name: string
  readonly detail: string
  readonly allowed: boolean
}

/**
 * The kinds of data this account can keep from Vivid, each with whether it is allowed now. An
 * account with no decision on a class is allowed it; any decision but Allow keeps it out, "Ask"
 * included, which the server treats as not allowed until the Person allows it
 * (`permissionRefusal`). So a screen offers two positions, allowed and off, and never "Ask",
 * which would promise a question nothing asks.
 */
export const dataClassesOf = (connection: Connection): ReadonlyArray<DataClassAccess> =>
  ConnectionDataClass.literals
    .filter((dataClass) => connectionDataClassService[dataClass] === connection.service)
    .map((dataClass) => ({
      dataClass,
      ...DATA_CLASS[dataClass],
      allowed: connection.permissions.every(
        (permission) => permission.dataClass !== dataClass || permission.decision === 'Allow',
      ),
    }))

/** "drafts", "drafts and event times": the classes named in a sentence. */
export const classesSaid = (classes: ReadonlyArray<ConnectionDataClass>) => {
  const names = classes.map((dataClass) => DATA_CLASS[dataClass].name.toLocaleLowerCase())
  const last = names.at(-1)
  if (last === undefined) return ''
  return names.length === 1 ? last : `${names.slice(0, -1).join(', ')} and ${last}`
}

// ── A call refused for want of access ──────────────────────────────────────

/**
 * A call through an Integration that the account could not make, and what the Person can do
 * about it, right where Vivid stopped.
 *
 * - `MoreAccess`: the account was not given what the call needs (`ScopeRequired`).
 * - `Declined`: the Person keeps these kinds of data from Vivid on it (`PermissionDeclined`).
 */
export type Escalation = Data.TaggedEnum<{
  MoreAccess: { readonly account: string }
  Declined: {
    readonly account: string
    readonly classes: Arr.NonEmptyReadonlyArray<ConnectionDataClass>
  }
}>
export const Escalation = Data.taggedEnum<Escalation>()

const readAccount = Schema.decodeUnknownOption(Schema.Struct({ account: Schema.NonEmptyString }))
const readScopeRefusal = Schema.decodeUnknownOption(
  Schema.Struct({ ok: Schema.Literal(false), required: Schema.NonEmptyArray(OAuthScope) }),
)
const readDeclined = Schema.decodeUnknownOption(
  Schema.Struct({ ok: Schema.Literal(false), classes: Schema.NonEmptyArray(ConnectionPermission) }),
)

/**
 * The escalation a finished `use_tool` call stands for, read from its own input (which account)
 * and output (`toolOutcome` in the runtime). Any other call, or one that worked, stands for none.
 */
export const escalationOf = (
  toolName: string,
  input: unknown,
  output: unknown,
): Option.Option<Escalation> => {
  if (toolName !== 'use_tool') return Option.none()
  return Option.flatMap(readAccount(input), ({ account }): Option.Option<Escalation> => {
    const declined = readDeclined(output)
    if (Option.isSome(declined)) {
      const [first, ...rest] = declined.value.classes
      return Option.some(
        Escalation.Declined({
          account,
          classes: [first.dataClass, ...rest.map((entry) => entry.dataClass)],
        }),
      )
    }
    return Option.map(readScopeRefusal(output), () => Escalation.MoreAccess({ account }))
  })
}

// ── How much a reply rests on ──────────────────────────────────────────────

const readEvidence = Schema.decodeUnknownOption(
  Schema.Struct({ coverage: ResultCoverage, asOf: ResultAsOf, observedAt: Schema.Finite }),
)

/** A count as people say it: "1,284". */
const counted = new Intl.NumberFormat()

/** How much of what was asked for came back: "Read 25 of 1,284 messages", "Read 25 messages". */
const amountOf = (query: ResultQuery) => {
  if (!ResultCount.guards.Known(query.fetched)) return 'Read part of it'
  const { value, unit } = query.fetched
  if (ResultCount.guards.Known(query.total) && query.total.value > value)
    return `Read ${counted.format(value)} of ${counted.format(query.total.value)} ${unit}`
  return `Read ${counted.format(value)} ${unit}, not all of them`
}

/** What was left out of a read, beyond its amount, when the reason is one a Person can act on. */
const leftOut = (reason: typeof CoverageReason.Type): Option.Option<string> =>
  CoverageReason.match(reason, {
    PermissionWithheld: ({ classes }) =>
      Option.some(`${classesSaid(classes.map((entry) => entry.dataClass))} kept out`),
    UnsyncedRange: () => Option.some('some dates not synced yet'),
    Pagination: () => Option.none<string>(),
    ProviderTruncation: () => Option.none<string>(),
    OutputClipped: () => Option.none<string>(),
  })

/**
 * The line under a reply that rests on a partial read: how much each partial read took and when
 * it was true ("Read 25 of 1,284 messages from Gmail (Work) · as of 10:40"). Reads that were
 * complete, or did not read anything, say nothing: a reply is assumed to rest on what it read.
 *
 * `outputs` are the finished calls of one reply, as `[toolName, output]`. `at` writes a moment
 * the way the surface writes times. The source's own time is used when the service gave one;
 * otherwise the moment the answer arrived, which is when it was last known to be true.
 */
export const readingOf = (
  outputs: ReadonlyArray<readonly [string, unknown]>,
  at: (moment: number) => string,
): Option.Option<string> => {
  const lines = outputs.flatMap(([toolName, output]) => {
    if (toolName !== 'use_tool') return []
    return Option.toArray(
      Option.flatMap(readEvidence(output), ({ coverage, asOf, observedAt }) => {
        if (!ResultCoverage.guards.Partial(coverage)) return Option.none()
        const amount =
          coverage.query === null
            ? 'Read part of the answer'
            : `${amountOf(coverage.query)} from ${coverage.query.account}`
        const moment = ResultAsOf.guards.Source(asOf) ? asOf.at : observedAt
        const notes = coverage.reasons.flatMap((reason) => Option.toArray(leftOut(reason)))
        return Option.some([amount, ...Arr.dedupe(notes), `as of ${at(moment)}`].join(' · '))
      }),
    )
  })
  return lines.length === 0 ? Option.none() : Option.some(Arr.dedupe(lines).join('\n'))
}
