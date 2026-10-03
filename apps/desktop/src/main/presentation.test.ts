import { describe, expect, it } from '@effect/vitest'
import { ShowingTab, Tab } from '../shared/pages.ts'
import { PagePresentation, PresentationChange, reducePresentation } from './presentation.ts'

const first = Tab.make('f198da28-8b59-4b86-8d14-f81f441954e1')
const second = Tab.make('4134ce7b-785f-4170-bc54-7e03f16320a0')
const rectangle = { x: 10, y: 20, width: 100, height: 200 }
const hidden = PagePresentation.cases.Hidden.make({ generation: 0 })

/** A placement receipt captures the current selection and measured CSS rectangle. */
function place(state: PagePresentation, owner: Tab): PagePresentation {
  return reducePresentation(
    state,
    PresentationChange.cases.Place.make({
      placement: rectangle,
      owner: ShowingTab.cases.Some.make({ value: owner }),
      scale: 1,
    }),
  )
}

describe('page presentation ownership', () => {
  it('revokes geometry and input on hiding, switching, modal opening and detachment', () => {
    const visible = place(hidden, first)
    for (const reason of ['hidden', 'switch', 'modal', 'detached'] as const) {
      const invalidated = reducePresentation(
        visible,
        PresentationChange.cases.Invalidate.make({ reason }),
      )
      expect(invalidated).toEqual(
        PagePresentation.cases.Hidden.make({ generation: visible.generation + 1 }),
      )
      expect(
        reducePresentation(invalidated, PresentationChange.cases.Reframe.make({ scale: 2 })),
      ).toBe(invalidated)
      const replaced = place(invalidated, second)
      expect(replaced).toEqual(
        PagePresentation.cases.Visible.make({
          generation: invalidated.generation + 1,
          owner: second,
          rectangle,
          scale: 1,
        }),
      )
    }
  })

  it('retains owner, generation and CSS geometry through resize and programmatic zoom', () => {
    const visible = place(hidden, first)
    const resized = reducePresentation(visible, PresentationChange.cases.Reframe.make({ scale: 1 }))
    expect(resized).toEqual(visible)
    const zoomed = reducePresentation(
      resized,
      PresentationChange.cases.Reframe.make({ scale: 1.5 }),
    )
    expect(zoomed).toEqual(
      PagePresentation.cases.Visible.make({
        generation: visible.generation,
        owner: first,
        rectangle,
        scale: 1.5,
      }),
    )
  })

  it('a hidden placement or a rectangle without a selected page grants no input ownership', () => {
    const visible = place(hidden, first)
    for (const change of [
      PresentationChange.cases.Place.make({
        placement: 'hidden',
        owner: ShowingTab.cases.Some.make({ value: first }),
        scale: 1,
      }),
      PresentationChange.cases.Place.make({
        placement: rectangle,
        owner: ShowingTab.cases.None.make({}),
        scale: 1,
      }),
    ])
      expect(reducePresentation(visible, change)).toEqual(
        PagePresentation.cases.Hidden.make({ generation: visible.generation + 1 }),
      )
  })
})
