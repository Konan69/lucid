import { describe, expect, it } from '@effect/vitest'
import { Option, Schema } from 'effect'
import { classifyFailure, decodeFailureEvidence, providerStatusOf } from './failure.ts'

describe('runtime failure ingress', () => {
  it('classifies independently authored SDK failure evidence', () => {
    const examples = [
      ['429 Too Many Requests', 'RateLimited'],
      ['429 <html>Gateway timed out</html>', 'RateLimited'],
      ['408 status code (no body)', 'TimedOut'],
      ['400 status code (no body)', 'ModelUnavailable'],
      ['404 status code (no body)', 'ModelUnavailable'],
      ['413 Request too large', 'ModelUnavailable'],
      ['422: {"error":"private payload"}', 'ModelUnavailable'],
      ['Server requested 30s retry delay (max: 2s). 503 Gateway timed out', 'ModelUnavailable'],
      ['Server requested 30s retry delay (max: 2s). 429 Too Many Requests', 'RateLimited'],
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
    ] as const
    for (const [message, reason] of examples)
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

  it('exports only known provider HTTP failures, never incidental numbers in private prose', () => {
    const examples = [
      ['520 status code (no body)', Option.some(520)],
      ['504 status code (no body)', Option.some(504)],
      ['503: private upstream body', Option.some(503)],
      ['520 error code: 520', Option.some(520)],
      ['522 <html>Upstream timed out</html>', Option.some(522)],
      ['429: too many requests', Option.some(429)],
      ['408 status code (no body)', Option.some(408)],
      ['400 status code (no body)', Option.some(400)],
      ['404 status code (no body)', Option.some(404)],
      ['413 Request too large', Option.some(413)],
      ['422: {"error":"private payload"}', Option.some(422)],
      ['Server requested 30s retry delay (max: 2s). 503 Gateway timed out', Option.some(503)],
      ['Server requested 30s retry delay (max: 2s). 429 Too Many Requests', Option.some(429)],
      [
        'private text: Server requested 30s retry delay (max: 2s). 503 Gateway timed out',
        Option.none(),
      ],
      ['Server requested 30s retry delay (max: 2s). private status 503', Option.none()],
      ['5201 private content', Option.none()],
      ['private content includes 520', Option.none()],
      ['999 status code (no body)', Option.none()],
      ['200 status code (no body)', Option.none()],
    ] as const
    for (const [reason, expected] of examples)
      expect(providerStatusOf(decodeFailureEvidence({ meta: { reason } }))).toEqual(expected)
  })
})
