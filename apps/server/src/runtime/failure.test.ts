import { describe, expect, it } from '@effect/vitest'
import { Schema } from 'effect'
import { classifyFailure, decodeFailureEvidence } from './failure.ts'

describe('runtime failure ingress', () => {
  it.each([
    ['429 Too Many Requests', 'RateLimited'],
    ['Provider returned 503', 'ModelUnavailable'],
    ['model_not_found', 'ModelUnavailable'],
    ['Insufficient credits', 'ModelUnavailable'],
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
})
