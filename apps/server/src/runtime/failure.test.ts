import { describe, expect, it } from '@effect/vitest'
import { Option, Schema } from 'effect'
import { classifyFailure, decodeFailureEvidence, providerStatusOf } from './failure.ts'

describe('runtime failure ingress', () => {
  it.each([
    ['429 Too Many Requests', 'RateLimited'],
    ['Provider returned 503', 'ModelUnavailable'],
    ['520 error code: 520', 'ModelUnavailable'],
    ['522 <html>Upstream timed out</html>', 'ModelUnavailable'],
    ['model_not_found', 'ModelUnavailable'],
    ['Insufficient credits', 'ModelUnavailable'],
    ['401 Unauthorized', 'ModelUnavailable'],
    ['403 Forbidden', 'ModelUnavailable'],
    ['ModelConfigurationInvalid', 'ModelUnavailable'],
    ['Upstream idle timeout exceeded', 'TimedOut'],
    ['Request timed out.', 'TimedOut'],
    ['No text and no tool call', 'NoAnswer'],
    ['An unrelated execution failure', 'Unexplained'],
  ])('classifies SDK evidence %s', (message, reason) => {
    expect(classifyFailure(decodeFailureEvidence({ message, meta: { reason: message } }))).toBe(
      reason,
    )
  })

  it('keeps the tagged failure and treats malformed evidence as unexplained', () => {
    const failure = Schema.TaggedStruct('TimedOut', { message: Schema.String }).make({
      message: 'provider request failed',
    })
    expect(classifyFailure(decodeFailureEvidence(failure))).toBe('TimedOut')
    expect(classifyFailure(decodeFailureEvidence({ message: 429 }))).toBe('Unexplained')
  })

  it.each([
    ['520 status code (no body)', Option.some(520)],
    ['504 status code (no body)', Option.some(504)],
    ['503: private upstream body', Option.some(503)],
    ['520 error code: 520', Option.some(520)],
    ['522 <html>Upstream timed out</html>', Option.some(522)],
    ['429: too many requests', Option.some(429)],
    ['5201 private content', Option.none()],
    ['private content includes 520', Option.none()],
    ['999 status code (no body)', Option.none()],
    ['200 status code (no body)', Option.none()],
  ])('exports only a leading provider HTTP failure status from %s', (reason, expected) => {
    expect(providerStatusOf(decodeFailureEvidence({ meta: { reason } }))).toEqual(expected)
  })
})
