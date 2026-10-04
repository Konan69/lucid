import { describe, expect, it } from '@effect/vitest'
import {
  ASKED_THRESHOLD,
  BEYOND_THRESHOLD,
  Review,
  reviewOutcome,
  type Consequence,
} from './policy.ts'

const within = BEYOND_THRESHOLD - 0.01
const asked = (consequence: Consequence) =>
  Review.cases.Reviewed.make({ asked: ASKED_THRESHOLD, beyond: within, consequence })
const unasked = (consequence: Consequence) =>
  Review.cases.Reviewed.make({ asked: ASKED_THRESHOLD - 0.01, beyond: within, consequence })

/** The whole policy is this table: what Vivid does with no rule, for every review ending. */
describe('Review policy', () => {
  it('runs whatever the Person asked for, whatever it does', () => {
    expect(reviewOutcome('write', asked('reaches'))).toBe('Run')
    expect(reviewOutcome('destructive', asked('irreversible'))).toBe('Run')
  })

  it('asks when an asked-for action also reaches what the request did not name', () => {
    const hidden = Review.cases.Reviewed.make({
      asked: 0.93,
      beyond: BEYOND_THRESHOLD,
      consequence: 'reaches',
    })
    expect(reviewOutcome('destructive', hidden)).toBe('Ask')
    expect(reviewOutcome('write', hidden)).toBe('Ask')
  })

  it('runs an unasked action only when it is contained and undoable', () => {
    expect(reviewOutcome('write', unasked('contained'))).toBe('Run')
    expect(reviewOutcome('write', unasked('reaches'))).toBe('Ask')
    expect(reviewOutcome('write', unasked('irreversible'))).toBe('Ask')
  })

  it("keeps the source's destructive fact above a contained classification", () => {
    expect(reviewOutcome('destructive', unasked('contained'))).toBe('Ask')
  })

  it('asks when the review could not be made, because the effect label proves nothing', () => {
    expect(reviewOutcome('write', Review.cases.Unreviewed.make({}))).toBe('Ask')
    expect(reviewOutcome('destructive', Review.cases.Unreviewed.make({}))).toBe('Ask')
  })
})
