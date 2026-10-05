import { Option } from 'effect'
import { describe, expect, it } from 'vitest'
import { heldAfter, isOpen, type Frame, type Held } from './expansion'

/**
 * Plays the composer's own loop for an unfocused draft: draw the shape, take the editor's report
 * for that shape, and repeat until the shape stops changing. `wrapsIn` is the draft's behaviour
 * at each width. Returns the shapes drawn, so a flip that never settles shows as a long list.
 */
function settle(text: string, wrapsIn: Record<Frame, boolean>, start: Held = Option.none()) {
  const drawn: Frame[] = []
  let held = start
  for (let step = 0; step < 10; step += 1) {
    const frame: Frame = isOpen(false, held, text) ? 'card' : 'capsule'
    drawn.push(frame)
    const next = heldAfter(held, { text, frame, wrapped: wrapsIn[frame] })
    if (Option.getOrNull(next) === Option.getOrNull(held)) return drawn
    held = next
  }
  return drawn
}

describe('composer expansion', () => {
  it('opens once and stays open for a draft that wraps only in the capsule', () => {
    expect(
      settle('a draft a little wider than the capsule', { capsule: true, card: false }),
    ).toEqual(['capsule', 'card'])
  })

  it('stays a capsule for a draft that fits on one line', () => {
    expect(settle('short', { capsule: false, card: false })).toEqual(['capsule'])
  })

  it('closes when the draft changes to something that fits', () => {
    const held = Option.some('the long draft that was sent')
    expect(isOpen(false, held, '')).toBe(false)
    // One more report clears what was held; the shape is a capsule throughout.
    expect(settle('', { capsule: false, card: false }, held)).toEqual(['capsule', 'capsule'])
  })

  it('is open while focused whatever the draft', () => {
    expect(isOpen(true, Option.none(), '')).toBe(true)
  })

  it('reopens after blur for text typed in the card that would wrap at rest', () => {
    // Typed in the card, where it fit on one line, so nothing was held when focus left.
    expect(settle('typed while open', { capsule: true, card: false })).toEqual(['capsule', 'card'])
  })
})
