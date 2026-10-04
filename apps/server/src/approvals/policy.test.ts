import { describe, expect, it } from '@effect/vitest'
import { ASKED_THRESHOLD, Review, reviewOutcome } from './policy.ts'

const asked = (consequence: 'contained' | 'reaches' | 'irreversible') =>
  Review.cases.Reviewed.make({ asked: ASKED_THRESHOLD, consequence })
const unasked = (consequence: 'contained' | 'reaches' | 'irreversible') =>
  Review.cases.Reviewed.make({ asked: ASKED_THRESHOLD - 0.01, consequence })

/** The whole policy is this table: what Vivid does with no rule, for every review ending. */
describe('Review policy', () => {
  it('runs whatever the Person asked for, whatever it does', () => {
    expect(reviewOutcome('write', asked('reaches'))).toBe('Run')
    expect(reviewOutcome('destructive', asked('irreversible'))).toBe('Run')
  })

  it('runs an unasked action only when it is contained and undoable', () => {
    expect(reviewOutcome('write', unasked('contained'))).toBe('Run')
    expect(reviewOutcome('write', unasked('reaches'))).toBe('Ask')
    expect(reviewOutcome('write', unasked('irreversible'))).toBe('Ask')
  })

  it("keeps the source's destructive fact above a contained classification", () => {
    expect(reviewOutcome('destructive', unasked('contained'))).toBe('Ask')
  })

  it('does not block undoable work when the review fails, and asks before a destructive one', () => {
    expect(reviewOutcome('write', Review.cases.Unreviewed.make({}))).toBe('Run')
    expect(reviewOutcome('destructive', Review.cases.Unreviewed.make({}))).toBe('Ask')
  })
})
