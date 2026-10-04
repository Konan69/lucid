import { expect, it } from '@effect/vitest'
import { Cause, Option, Schema } from 'effect'
import { failuresOf, FailureOutcome, primaryOf, redact, summarize } from './failure.ts'

class StoreUnavailable extends Schema.TaggedError<StoreUnavailable>()(
  'StoreUnavailable',
  { message: Schema.String, cause: Schema.Unknown },
  { title: 'Store unavailable' },
) {}

/** A foreign SDK's error, whose tag is whatever the SDK assigned. */
class Foreign extends Error {
  readonly _tag: string
  constructor(tag: string, cause: unknown) {
    super('foreign failure', { cause })
    this._tag = tag
  }
}

/** Shaped like Effect Drizzle's wrapper: the statement and its parameters are the message. */
const statementFailure = (cause: unknown) =>
  Object.assign(
    new Error('Failed query: insert into messages (body) values ($1)\nparams: my private note', {
      cause,
    }),
    { name: 'EffectDrizzleQueryError' },
  )

it('reports the driver beneath a statement wrapper and never the statement', () => {
  const driver = Object.assign(new Error('duplicate key value violates unique constraint'), {
    code: '23505',
    constraint: 'messages_key_unique',
    table: 'messages',
  })
  const summary = summarize(
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
  const bare = summarize(statementFailure(driver))
  expect(bare.type).toBe('EffectDrizzleQueryError')
  expect(bare.message).toEqual(Option.some('duplicate key value violates unique constraint'))
  expect(redact(String(statementFailure(driver).stack))).not.toContain('my private note')
})

it('bounds a cyclic cause chain and names an untyped failure', () => {
  const first = { name: 'First', cause: { name: 'Second' } }
  Object.assign(first.cause, { cause: first })
  expect(summarize(first).rootType).toEqual(Option.some('Second'))
  expect(summarize('the disk is full')).toMatchObject({
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

it('names a failure by its tag or name only when that is an identifier', () => {
  expect(summarize(new Foreign('Http.Faults.ReportsOverBudget', undefined)).type).toBe(
    'Http.Faults.ReportsOverBudget',
  )
  // A tag or a name is whatever the thrower assigned; text is not a type and is not cleaned up.
  expect(summarize(new Foreign('tenant 42: Ada Lovelace', undefined)).type).toBe('_OTHER')
  expect(summarize(new Foreign('https://example.com/a?token=abc', undefined)).type).toBe('_OTHER')
  expect(
    summarize(Object.assign(new Error('x'), { name: `Failed for ${'x'.repeat(200)}` })).type,
  ).toBe('_OTHER')
  expect(summarize({ name: 'T'.repeat(121) }).type).toBe('_OTHER')
  const nested = summarize(new Foreign('Outer', { name: 'dami@example.com' }))
  expect(nested.rootType).toEqual(Option.none())
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
