import { describe, expect, it } from '@effect/vitest'
import {
  ASKED_THRESHOLD,
  BEYOND_THRESHOLD,
  CONTAINED_THRESHOLD,
  Review,
  reviewOutcome,
} from './policy.ts'

const within = BEYOND_THRESHOLD - 0.01
const open = CONTAINED_THRESHOLD - 0.01
const asked = (contained: number) =>
  Review.cases.Reviewed.make({ asked: ASKED_THRESHOLD, beyond: within, contained })
const unasked = (contained: number) =>
  Review.cases.Reviewed.make({ asked: ASKED_THRESHOLD - 0.01, beyond: within, contained })

/** The whole policy is this table: what Vivid does with no rule, for every review ending. */
describe('Review policy', () => {
  it('runs whatever the Person asked for, whatever it does', () => {
    expect(reviewOutcome('write', asked(open))).toBe('Run')
    expect(reviewOutcome('destructive', asked(0))).toBe('Run')
  })

  it('asks when an asked-for action also reaches what the request did not name', () => {
    const hidden = Review.cases.Reviewed.make({
      asked: 0.93,
      beyond: BEYOND_THRESHOLD,
      contained: open,
    })
    expect(reviewOutcome('destructive', hidden)).toBe('Ask')
    expect(reviewOutcome('write', hidden)).toBe('Ask')
  })

  it('runs an unasked action only when it is contained and undoable', () => {
    expect(reviewOutcome('write', unasked(CONTAINED_THRESHOLD))).toBe('Run')
    expect(reviewOutcome('write', unasked(open))).toBe('Ask')
    expect(reviewOutcome('write', unasked(0))).toBe('Ask')
  })

  it("keeps the source's destructive fact above a contained classification", () => {
    expect(reviewOutcome('destructive', unasked(CONTAINED_THRESHOLD))).toBe('Ask')
  })

  it('lets an undoable write run when no review was made, and asks before a destructive one', () => {
    expect(reviewOutcome('write', Review.cases.Unreviewed.make({}))).toBe('Run')
    expect(reviewOutcome('destructive', Review.cases.Unreviewed.make({}))).toBe('Ask')
  })
})
