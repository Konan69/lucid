import { expect, it } from '@effect/vitest'
import { Cause, Option, Schema } from 'effect'
import { failureOf, FailureOutcome, redact, summarize } from './failure.ts'

class StoreUnavailable extends Schema.TaggedError<StoreUnavailable>()(
  'StoreUnavailable',
  { message: Schema.String, cause: Schema.Unknown },
  { title: 'Store unavailable' },
) {}

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

it('ranks a defect over a typed failure and sets interruption apart', () => {
  const typed = Cause.fail(new StoreUnavailable({ message: 'down', cause: undefined }))
  expect(FailureOutcome.$is('Expected')(failureOf(typed))).toBe(true)
  const both = Cause.combine(typed, Cause.die(new RangeError('out of range')))
  const outcome = failureOf(both)
  expect(FailureOutcome.$is('Defect')(outcome) ? outcome.summary.type : '').toBe('RangeError')
  expect(failureOf(Cause.interrupt(1))).toEqual(FailureOutcome.Interrupted())
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
