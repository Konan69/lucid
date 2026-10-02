import * as Schema from 'effect/Schema'
import { PageRectangle, PagePlacement, ShowingTab, Tab } from '../shared/pages.ts'

const Generation = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const Scale = Schema.Number.check(Schema.isFinite(), Schema.isGreaterThan(0))

/** A visible lease binds native input and geometry to one page and one presentation generation. */
export const PagePresentation = Schema.TaggedUnion({
  Hidden: { generation: Generation },
  Visible: { generation: Generation, owner: Tab, rectangle: PageRectangle, scale: Scale },
})
export type PagePresentation = typeof PagePresentation.Type

/** Resize/zoom retain a lease; visibility and ownership changes revoke it until a fresh place call. */
export const PresentationChange = Schema.TaggedUnion({
  Place: { placement: PagePlacement, owner: ShowingTab, scale: Scale },
  Reframe: { scale: Scale },
  Invalidate: { reason: Schema.Literals(['hidden', 'switch', 'modal', 'detached']) },
})
export type PresentationChange = typeof PresentationChange.Type

/** The same pure rule drives main and tests, so a zoom cannot resurrect a revoked input owner. */
export function reducePresentation(
  state: PagePresentation,
  change: PresentationChange,
): PagePresentation {
  return PresentationChange.match(change, {
    Invalidate: () => PagePresentation.cases.Hidden.make({ generation: state.generation + 1 }),
    Reframe: ({ scale }) =>
      PagePresentation.match(state, {
        Hidden: () => state,
        Visible: (visible) => PagePresentation.cases.Visible.make({ ...visible, scale }),
      }),
    Place: ({ placement, owner, scale }) => {
      const generation = state.generation + 1
      if (placement === 'hidden' || ShowingTab.guards.None(owner))
        return PagePresentation.cases.Hidden.make({ generation })
      return PagePresentation.cases.Visible.make({
        generation,
        owner: owner.value,
        rectangle: placement,
        scale,
      })
    },
  })
}

/** Selection equality is about the opaque identity, not clone object or revision equality. */
export function sameShowing(left: typeof ShowingTab.Type, right: typeof ShowingTab.Type): boolean {
  return ShowingTab.match(left, {
    None: () => ShowingTab.guards.None(right),
    Some: ({ value }) => ShowingTab.guards.Some(right) && right.value === value,
  })
}
