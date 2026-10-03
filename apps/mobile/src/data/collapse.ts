/**
 * Whether a floating action shows its label or only its mark, decided from how a list under it
 * has been scrolled: the label is there at rest and at the top, goes once the list is moving
 * down, and comes back once it is moving up.
 *
 * Ported from T3 Code mobile `src/features/home/material-fab-scroll.ts`
 * (`updateMaterialFabScroll`), thresholds unchanged: always expanded within 8 points of the top,
 * and a change of direction counts only after 12 points, so a wobbling finger and overscroll at
 * either end do not make the button flicker.
 */
export interface Collapse {
  /** The offset the current direction is measured from. */
  readonly anchor: number
  readonly expanded: boolean
}

export const RESTING: Collapse = { anchor: 0, expanded: true }

export function collapseAt(state: Collapse, offset: number, furthest: number): Collapse {
  const y = Math.max(0, Math.min(offset, Math.max(0, furthest)))
  if (y <= 8) return { anchor: y, expanded: true }
  const anchor = state.expanded ? Math.min(state.anchor, y) : Math.max(state.anchor, y)
  if (Math.abs(y - anchor) >= 12) return { anchor: y, expanded: !state.expanded }
  return { anchor, expanded: state.expanded }
}
