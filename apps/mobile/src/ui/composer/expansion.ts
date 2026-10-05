import { Option } from 'effect'

/**
 * Whether the composer is a capsule or a card, decided from things that do not change with the
 * shape itself.
 *
 * The editor reports the height its text needs, and a draft that needs more than one line must
 * open the card. But the two shapes give the text different widths (the capsule shares its row
 * with the button, the card does not), so the same draft can wrap in the capsule and fit on one
 * line in the card. Deciding from the latest report alone made such a draft flip for ever:
 * wrapped, so open; fits, so close; wrapped again.
 *
 * So the composer holds the text it saw wrap. Only the capsule's reports can say a draft fits on
 * one line, because the capsule is the narrower of the two; a one-line report from the card
 * proves nothing and is ignored. The card then stays open for exactly that text, and closes when
 * the draft changes to something else, which is measured afresh in the capsule.
 */

/** The shape the editor was in when it reported. */
export type Frame = 'capsule' | 'card'

/** One report from the editor: the draft it measured, in which shape, and whether it wrapped. */
export interface Measured {
  readonly text: string
  readonly frame: Frame
  readonly wrapped: boolean
}

/** The text last seen to need more than one line, if any. */
export type Held = Option.Option<string>

/** What is held after a report. */
export const heldAfter = (held: Held, report: Measured): Held => {
  if (report.wrapped) return Option.some(report.text)
  // The card is wider than the capsule: fitting there does not mean fitting at rest.
  if (report.frame === 'card') return held
  return Option.none()
}

/** The card is open while it is being written in, or while it holds the draft it saw wrap. */
export const isOpen = (focused: boolean, held: Held, text: string): boolean =>
  focused || Option.contains(held, text)
