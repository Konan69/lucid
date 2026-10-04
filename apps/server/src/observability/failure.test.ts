import { expect, it } from '@effect/vitest'
import { EffectDrizzleQueryError } from 'drizzle-orm/effect-core/errors'
import { Cause, Exit, Option, Schema } from 'effect'
import * as PlatformError from 'effect/PlatformError'
import * as HttpClientError from 'effect/unstable/http/HttpClientError'
import * as HttpClientRequest from 'effect/unstable/http/HttpClientRequest'
import * as HttpServerError from 'effect/unstable/http/HttpServerError'
import * as HttpServerRequest from 'effect/unstable/http/HttpServerRequest'
import * as SqlError from 'effect/unstable/sql/SqlError'
import {
  failuresOf,
  FailureOutcome,
  fixedTypeNames,
  primaryOf,
  redact,
  summarize,
} from './failure.ts'

class StoreUnavailable extends Schema.TaggedError<StoreUnavailable>()(
  'StoreUnavailable',
  { message: Schema.String, cause: Schema.Unknown },
  { title: 'Store unavailable' },
) {}

/** A declared error whose schema identifier is not its tag: the tag is what is reported. */
class Renamed extends Schema.TaggedError<Renamed>('test/observability/Renamed')(
  'RenamedTag',
  {},
  { title: 'Renamed' },
) {}

const decodeText = Schema.decodeUnknownExit(Schema.String)

/** Text that has the shape of an identifier and is not one: it came from data. */
const PRIVATE = 'PrivateTokenABC123'

/** A foreign SDK's error, whose tag is whatever the SDK assigned. */
class Foreign extends Error {
  readonly _tag: string
  constructor(tag: string, cause: unknown) {
    super('foreign failure', { cause })
    this._tag = tag
  }
}

/** Effect Drizzle's wrapper: the statement and its parameters are the message. */
const statementFailure = (cause: unknown) =>
  new EffectDrizzleQueryError({
    query: 'insert into messages (body) values ($1)',
    params: ['my private note'],
    cause,
  })

it('reports the driver beneath a statement wrapper and never the statement', () => {
  const driver = Object.assign(new Error('duplicate key value violates unique constraint'), {
    code: '23505',
    constraint: 'messages_key_unique',
    table: 'messages',
  })
  const summary = summarize(
    'expected',
    new StoreUnavailable({
      message: 'Message could not be stored',
      cause: statementFailure(driver),
    }),
  )
  expect(summary).toEqual({
    type: 'StoreUnavailable',
    message: Option.some('Message could not be stored'),
    rootType: Option.some('Error'),
    databaseCode: Option.some('23505'),
    databaseConstraint: Option.some('messages_key_unique'),
    databaseTable: Option.some('messages'),
  })
  // Thrown bare, the wrapper has no message of its own to offer: the driver's is used.
  const bare = summarize('expected', statementFailure(driver))
  expect(bare.type).toBe('EffectDrizzleQueryError')
  expect(bare.message).toEqual(Option.some('duplicate key value violates unique constraint'))
  expect(statementFailure(driver).message).toContain('my private note')
  expect(redact(String(statementFailure(driver).stack))).not.toContain('my private note')
})

it('bounds a cyclic cause chain and names an untyped failure', () => {
  const first = new Error('first', { cause: new RangeError('second') })
  Object.assign(first.cause ?? {}, { cause: first })
  expect(summarize('defect', first)).toMatchObject({
    type: 'Error',
    rootType: Option.some('RangeError'),
  })
  expect(summarize('expected', 'the disk is full')).toMatchObject({
    type: '_OTHER',
    message: Option.some('the disk is full'),
  })
})

it('lists every failure in a cause, ranks a defect first, and sets interruption apart', () => {
  const typed = Cause.fail(new StoreUnavailable({ message: 'down', cause: undefined }))
  expect(failuresOf(typed).map((failure) => failure._tag)).toEqual(['Expected'])
  const all = failuresOf(
    Cause.combine(
      Cause.combine(typed, Cause.interrupt(1)),
      Cause.combine(Cause.die(new RangeError('out of range')), Cause.fail('the disk is full')),
    ),
  )
  expect(all.map((failure) => [failure._tag, failure.summary.type])).toEqual([
    ['Expected', 'StoreUnavailable'],
    ['Defect', 'RangeError'],
    ['Expected', '_OTHER'],
  ])
  const primary = primaryOf(all)
  expect(Option.isSome(primary) ? primary.value.summary.type : '').toBe('RangeError')
  expect(Option.map(primaryOf(failuresOf(typed)), FailureOutcome.$is('Expected'))).toEqual(
    Option.some(true),
  )
  expect(failuresOf(Cause.interrupt(1))).toEqual([])
  expect(primaryOf([])).toEqual(Option.none())
})

it('types a declared failure by the tag its class was made with', () => {
  expect(summarize('expected', new Renamed({})).type).toBe('RenamedTag')
  // Effect's SQL errors and Effect Drizzle's are such classes too.
  const unknown = new SqlError.UnknownError({ cause: undefined })
  expect(summarize('expected', new SqlError.SqlError({ reason: unknown })).type).toBe('SqlError')
  // A declared error that was turned into a defect is still that error.
  expect(summarize('defect', new Renamed({})).type).toBe('RenamedTag')
  // The class is asked, never the instance: an instance cannot rename its type.
  const renamed = Object.assign(new StoreUnavailable({ message: 'down', cause: undefined }), {
    name: PRIVATE,
  })
  expect(summarize('expected', renamed).type).toBe('StoreUnavailable')
})

it("types Effect's own errors by their class, under the tag each one carries", () => {
  const request = HttpClientRequest.get('http://backend.invalid')
  const listed = [
    new HttpServerError.HttpServerError({
      reason: new HttpServerError.RouteNotFound({
        request: HttpServerRequest.fromWeb(new Request('http://server.invalid')),
      }),
    }),
    new HttpClientError.HttpClientError({
      reason: new HttpClientError.TransportError({ request, cause: undefined }),
    }),
    new PlatformError.PlatformError(
      new PlatformError.BadArgument({ module: 'FileSystem', method: 'open' }),
    ),
    new Cause.TimeoutError(),
    new Cause.NoSuchElementError(),
  ]
  // The name written beside each class in `failure.ts` is the tag the class gives its instances.
  for (const failure of listed) {
    expect(summarize('expected', failure).type).toBe(failure._tag)
    expect(fixedTypeNames).toContain(failure._tag)
  }
  const refused = decodeText(1)
  const [schemaFailure] = Exit.isFailure(refused) ? failuresOf(refused.cause) : []
  expect(schemaFailure === undefined ? '' : schemaFailure.summary.type).toBe('SchemaError')
})

it('exports no type that is a property of what was thrown', () => {
  // A tag is whatever the thrower assigned. One with the shape of an identifier is still not a
  // type the code declared, so a typed failure carrying it has no type.
  expect(summarize('expected', new Foreign(PRIVATE, undefined)).type).toBe('_OTHER')
  expect(summarize('expected', { _tag: PRIVATE, name: PRIVATE }).type).toBe('_OTHER')
  // A defect is typed by the built-in class it is an instance of, whatever its `name` was set to.
  const named = Object.assign(new TypeError('boom'), { name: PRIVATE })
  expect(summarize('defect', named).type).toBe('TypeError')
  expect(summarize('defect', new Foreign(PRIVATE, undefined)).type).toBe('Error')
  expect(summarize('defect', { name: PRIVATE }).type).toBe('_OTHER')
  // The innermost cause the same way: a class names it, or nothing does.
  expect(summarize('expected', new Foreign('Outer', named)).rootType).toEqual(
    Option.some('TypeError'),
  )
  expect(summarize('expected', new Foreign('Outer', { name: PRIVATE })).rootType).toEqual(
    Option.none(),
  )
  // Pointing `constructor` at a declared class does not make a value an instance of it.
  expect(summarize('expected', { constructor: StoreUnavailable }).type).toBe('_OTHER')
  // Every type therefore comes from a class: a declared tag, or one of a fixed list.
  expect(fixedTypeNames).not.toContain(PRIVATE)
})

it('strips address queries, tokens and email addresses from diagnostic text', () => {
  expect(
    redact(
      'GET https://person:pw@example.com/return?code=abc#frag failed for dami@example.com with api_key=xyz sentry_key=abc',
    ),
  ).toBe(
    'GET https://example.com/return failed for [EMAIL REDACTED] with api_key=[REDACTED] sentry_key=[REDACTED]',
  )
})
