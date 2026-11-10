import {
  ActionTarget,
  IntegrationAnswerOutcome,
  IntegrationPause,
  type Approval,
  type InputRequest,
  IntegrationForm as IntegrationFormSchema,
  type IntegrationResponse,
} from '@vivid/contracts'
import { Array as Arr, Data, Option } from 'effect'

/**
 * An Integration's question to the Person, as the fields every client draws and checks.
 *
 * An Integration asks mid-call with a form: a message and a JSON schema of flat properties
 * (MCP elicitation, `requestedSchema`, which `packages/contracts/src/asks.ts` stores as the
 * protocol sent it). The schema is read here once into `Entry` values, one per property in the
 * schema's own order, and each entry carries the value the Person has given so far, typed for its
 * kind: a picked choice, picked choices, yes or no, or the words in a field. A client draws an
 * entry, edits it through `pick`, `turn` and `type`, says `problemOf` beside it, and sends
 * `contentOf` once every entry is acceptable.
 *
 * The kinds follow the protocol's primitive definitions (`effect/ai/McpSchema`,
 * `PrimitiveSchemaDefinition`): a string with `enum` or `oneOf` (and the legacy `enumNames`) is
 * one choice; an array whose items are such a set is several; a boolean is yes or no; a string,
 * number or integer is typed. The limits the protocol carries (length, format, range, how many
 * picks) are what `problemOf` checks, so a value the schema would refuse never leaves the client.
 */

/** A string's declared shape, from the protocol's `format`. */
export type Format = 'email' | 'uri' | 'date' | 'date-time'

/** One offered choice: the value sent, and the words the Person reads. */
export interface Choice {
  readonly value: string
  readonly label: string
}

/** What every entry has: the key it is sent under, its title, its help line, and whether it must be given. */
interface Base {
  readonly key: string
  /** The property's `title`, else its key. */
  readonly title: string
  /** The property's `description`, drawn quietly under the title. */
  readonly help: Option.Option<string>
  readonly required: boolean
}

/**
 * One property of the form and what the Person has given for it.
 *
 * - `One`: a closed set, one of which is picked.
 * - `Several`: a closed set, any number of which are picked within `least` and `most`.
 * - `Toggle`: yes or no.
 * - `Text`: words, within the length and format the schema says.
 * - `Number`: a number typed as words, so a half-typed "1." stays as the Person wrote it.
 */
export type Entry = Data.TaggedEnum<{
  One: Base & { readonly choices: ReadonlyArray<Choice>; readonly picked: Option.Option<string> }
  Several: Base & {
    readonly choices: ReadonlyArray<Choice>
    readonly least: number
    readonly most: Option.Option<number>
    readonly picked: ReadonlyArray<string>
  }
  Toggle: Base & { readonly on: Option.Option<boolean> }
  Text: Base & {
    readonly format: Option.Option<Format>
    readonly least: Option.Option<number>
    readonly most: Option.Option<number>
    readonly words: string
  }
  Number: Base & {
    readonly integer: boolean
    readonly least: Option.Option<number>
    readonly most: Option.Option<number>
    readonly words: string
  }
}>
export const Entry = Data.taggedEnum<Entry>()

/** The form as stored with its request: the protocol's own message and schema. */
export type IntegrationForm = typeof IntegrationFormSchema.Type
type Property = IntegrationForm['requestedSchema']['properties'][string]

/** The Integration form a request carries, when it is an Integration's mid-call question. */
export const formOf = (request: InputRequest): Option.Option<IntegrationForm> => {
  if (request.integration === null || request.integration.continuation === null)
    return Option.none()
  const { pause } = request.integration.continuation
  return IntegrationPause.guards.Input(pause) ? Option.some(pause.form) : Option.none()
}

/**
 * Whether an Approval answers an Integration that paused its call. The server takes only Allow
 * and Don't allow for it (`requireDecisionAuthority`, `apps/server/src/approvals/store.ts`):
 * the Integration asks every time, and the saved call is answered as it was asked, never edited.
 */
export const isIntegrationApproval = (approval: Approval): boolean =>
  approval.action.continuation !== null

/** The name of the Integration a request was raised by, as the Person labelled its account. */
export const integrationName = (request: InputRequest): Option.Option<string> =>
  request.integration !== null && ActionTarget.guards.Connection(request.integration.target)
    ? Option.some(request.integration.target.account)
    : Option.none()

/** The protocol leaves a property's optional keys out; each is read here as present or absent. */
const some = Option.fromUndefinedOr

/** The choices of a single pick, with the legacy `enumNames` as their words where given. */
const singleChoices = (property: Property & { readonly type: 'string' }): ReadonlyArray<Choice> => {
  if ('oneOf' in property)
    return property.oneOf.map((one) => ({ value: one.const, label: one.title }))
  if (!('enum' in property)) return []
  const names: ReadonlyArray<string> =
    'enumNames' in property ? Option.getOrElse(some(property.enumNames), () => []) : []
  return property.enum.map((value, place) => ({
    value,
    label: Option.getOrElse(Arr.get(names, place), () => value),
  }))
}

/** One property read into its entry, with the schema's default as the starting value. */
const entryOf = (key: string, property: Property, required: boolean): Entry => {
  const base: Base = {
    key,
    title: Option.getOrElse(some(property.title), () => key),
    help: Option.filter(some(property.description), (help) => help.trim().length > 0),
    required,
  }
  switch (property.type) {
    case 'boolean':
      return Entry.Toggle({ ...base, on: some(property.default) })
    case 'number':
    case 'integer':
      return Entry.Number({
        ...base,
        integer: property.type === 'integer',
        least: some(property.minimum),
        most: some(property.maximum),
        words: property.default === undefined ? '' : String(property.default),
      })
    case 'array': {
      const choices =
        'anyOf' in property.items
          ? property.items.anyOf.map((one) => ({ value: one.const, label: one.title }))
          : property.items.enum.map((value) => ({ value, label: value }))
      return Entry.Several({
        ...base,
        choices,
        least: Option.getOrElse(some(property.minItems), () => (required ? 1 : 0)),
        most: some(property.maxItems),
        picked: Option.getOrElse(some(property.default), () => []).filter((value) =>
          choices.some((choice) => choice.value === value),
        ),
      })
    }
    case 'string': {
      if ('oneOf' in property || 'enum' in property) {
        const choices = singleChoices(property)
        return Entry.One({
          ...base,
          choices,
          picked: Option.filter(some(property.default), (value) =>
            choices.some((choice) => choice.value === value),
          ),
        })
      }
      return Entry.Text({
        ...base,
        format: some(property.format),
        least: some(property.minLength),
        most: some(property.maxLength),
        words: Option.getOrElse(some(property.default), () => ''),
      })
    }
  }
}

/** The form's entries, in the schema's order, each starting from its default. */
export const entriesOf = (form: IntegrationForm): ReadonlyArray<Entry> => {
  const required = new Set(Option.getOrElse(some(form.requestedSchema.required), () => []))
  return Object.entries(form.requestedSchema.properties).map(([key, property]) =>
    entryOf(key, property, required.has(key)),
  )
}

/** The same entries with the one under `key` changed by `change`. */
const edit = (
  entries: ReadonlyArray<Entry>,
  key: string,
  change: (entry: Entry) => Entry,
): ReadonlyArray<Entry> => entries.map((entry) => (entry.key === key ? change(entry) : entry))

/**
 * A choice was pressed. On a single pick it is the pick; on several it is added, or taken out
 * when it was already there. Any other kind is left as it was.
 */
export const pick = (entries: ReadonlyArray<Entry>, key: string, value: string) =>
  edit(entries, key, (entry) => {
    if (Entry.$is('One')(entry)) return Entry.One({ ...entry, picked: Option.some(value) })
    if (!Entry.$is('Several')(entry)) return entry
    const picked = entry.picked.includes(value)
      ? entry.picked.filter((one) => one !== value)
      : [...entry.picked, value]
    return Entry.Several({ ...entry, picked })
  })

/** Yes or No was pressed on a yes-or-no entry. */
export const turn = (entries: ReadonlyArray<Entry>, key: string, on: boolean) =>
  edit(entries, key, (entry) =>
    Entry.$is('Toggle')(entry) ? Entry.Toggle({ ...entry, on: Option.some(on) }) : entry,
  )

/** Words were typed into a text or number entry, exactly as typed. */
export const type = (entries: ReadonlyArray<Entry>, key: string, words: string) =>
  edit(entries, key, (entry) => {
    if (Entry.$is('Text')(entry)) return Entry.Text({ ...entry, words })
    return Entry.$is('Number')(entry) ? Entry.Number({ ...entry, words }) : entry
  })

/** The two rows a yes-or-no entry is drawn as, in that order. */
export const YES_NO: ReadonlyArray<{ readonly on: boolean; readonly label: string }> = [
  { on: true, label: 'Yes' },
  { on: false, label: 'No' },
]

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u
const DATE = /^\d{4}-\d{2}-\d{2}$/u
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?$/u

/** Whether words are a full web address, as the protocol's `uri` format means. */
const isAddress = (words: string): boolean => {
  if (!URL.canParse(words)) return false
  return /^[a-z][a-z0-9+.-]*:/iu.test(words)
}

/** What is wrong with typed words for their declared format, when anything is. */
const formatProblem = (format: Format, words: string): Option.Option<string> => {
  switch (format) {
    case 'email':
      return EMAIL.test(words) ? Option.none() : Option.some('Enter an email address.')
    case 'uri':
      return isAddress(words) ? Option.none() : Option.some('Enter a full address, like https://…')
    case 'date':
      return DATE.test(words) && !Number.isNaN(Date.parse(words))
        ? Option.none()
        : Option.some('Enter a date like 2026-11-10.')
    case 'date-time':
      return DATE_TIME.test(words) && !Number.isNaN(Date.parse(words))
        ? Option.none()
        : Option.some('Enter a date and time like 2026-11-10T14:30.')
  }
}

/** What is wrong with typed words, against the entry's length and format. */
const textProblem = (entry: Extract<Entry, { _tag: 'Text' }>): Option.Option<string> => {
  const words = entry.words.trim()
  if (words.length === 0) return entry.required ? Option.some('Fill this in.') : Option.none()
  if (Option.exists(entry.least, (least) => words.length < least))
    return Option.map(entry.least, (least) => `Use at least ${least} characters.`)
  if (Option.exists(entry.most, (most) => words.length > most))
    return Option.map(entry.most, (most) => `Use at most ${most} characters.`)
  return Option.flatMap(entry.format, (format) => formatProblem(format, words))
}

/** What is wrong with a typed number, against the entry's kind and range. */
const numberProblem = (entry: Extract<Entry, { _tag: 'Number' }>): Option.Option<string> => {
  const words = entry.words.trim()
  if (words.length === 0) return entry.required ? Option.some('Fill this in.') : Option.none()
  const value = Number(words)
  if (!Number.isFinite(value)) return Option.some('Enter a number.')
  if (entry.integer && !Number.isInteger(value)) return Option.some('Enter a whole number.')
  if (Option.exists(entry.least, (least) => value < least))
    return Option.map(entry.least, (least) => `Enter ${least} or more.`)
  if (Option.exists(entry.most, (most) => value > most))
    return Option.map(entry.most, (most) => `Enter ${most} or less.`)
  return Option.none()
}

/** What is wrong with how many choices are picked. */
const severalProblem = (entry: Extract<Entry, { _tag: 'Several' }>): Option.Option<string> => {
  const count = entry.picked.length
  if (count === 0 && !entry.required && entry.least <= 1) return Option.none()
  if (count < entry.least)
    return Option.some(entry.least <= 1 ? 'Pick at least one.' : `Pick at least ${entry.least}.`)
  return Option.exists(entry.most, (most) => count > most)
    ? Option.map(entry.most, (most) => `Pick at most ${most}.`)
    : Option.none()
}

/**
 * What is wrong with an entry's value, in one sentence for beside it, when anything is. A
 * required entry with nothing given is wrong too: it keeps Send off until it is given.
 */
export const problemOf = (entry: Entry): Option.Option<string> =>
  Entry.$match(entry, {
    One: ({ required, picked }) =>
      required && Option.isNone(picked) ? Option.some('Pick one.') : Option.none(),
    Several: severalProblem,
    Toggle: ({ required, on }) =>
      required && Option.isNone(on) ? Option.some('Pick Yes or No.') : Option.none(),
    Text: textProblem,
    Number: numberProblem,
  })

type Content = Extract<IntegrationResponse, { readonly action: 'accept' }>['content']
type Given = Content[string]

/** An entry's value as it is sent, when it has one. Nothing given is left out of the answer. */
const givenOf = (entry: Entry): Option.Option<Given> =>
  Entry.$match(entry, {
    One: ({ picked }) => picked,
    Several: ({ picked }) => (picked.length === 0 ? Option.none() : Option.some(picked)),
    Toggle: ({ on }) => on,
    Text: ({ words }) =>
      words.trim().length === 0 ? Option.none() : Option.some<Given>(words.trim()),
    Number: ({ words }) =>
      words.trim().length === 0 ? Option.none() : Option.some<Given>(Number(words.trim())),
  })

/**
 * What Send answers with: every entry that has a value, under its key. Nothing while any entry
 * has a problem, so a form the schema would refuse cannot be sent.
 */
export const contentOf = (entries: ReadonlyArray<Entry>): Option.Option<Content> => {
  if (entries.some((entry) => Option.isSome(problemOf(entry)))) return Option.none()
  return Option.some(
    Object.fromEntries(
      entries.flatMap((entry) =>
        Option.toArray(Option.map(givenOf(entry), (given) => [entry.key, given] as const)),
      ),
    ),
  )
}

/**
 * Whether an entry is drawn with its title over it. A form of one choice needs none: the
 * banner's head is the Integration's message, which asks it. Every other entry is named.
 */
export const titled = (entries: ReadonlyArray<Entry>): boolean =>
  !(
    entries.length === 1 &&
    entries.every((entry) => !Entry.$is('Text')(entry) && !Entry.$is('Number')(entry))
  )

/**
 * How an expired Integration ask ends in the Thread, under what was asked. An Approval paused
 * before the call ran, so nothing was sent; a question came mid-call, so the Integration may
 * already have done part of the work (`integrationExpiredMessage`, `@vivid/contracts`).
 */
export const EXPIRED_APPROVAL = 'Expired before you answered. Nothing was sent.'

/** The expired line of an Integration's question, naming the Integration when it is known. */
export const expiredQuestion = (request: InputRequest): string =>
  `Expired before you answered. ${Option.getOrElse(integrationName(request), () => 'The Integration')} may already have acted.`

/**
 * What an answered Integration question says as the bubble of the Person who answered. The
 * server keeps Vivid's account of the ending as the request's answer, not what the Person typed,
 * so the bubble says only which button they pressed: Skip, or Send.
 */
export const answeredWords = (request: InputRequest): string =>
  Option.match(Option.fromNullOr(request.integrationOutcome), {
    onNone: () => 'Sent',
    onSome: (outcome) =>
      IntegrationAnswerOutcome.isAnyOf(['Declined', 'Cancelled'])(outcome) ? 'Skipped' : 'Sent',
  })
