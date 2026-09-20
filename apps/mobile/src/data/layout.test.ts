import { expect, it } from 'vitest'
import {
  deriveCenteredContentHorizontalPadding,
  deriveLayout,
  deriveWorkspacePaneLayout,
} from './layout.ts'
import { resolveThreadSelectionNavigationAction } from './navigation.ts'

it('phone rotation keeps the conversation on a compact back stack', () => {
  for (const dimensions of [
    { width: 390, height: 844 },
    { width: 844, height: 390 },
  ]) {
    const layout = deriveLayout(dimensions)
    expect(layout.usesSplitView).toBe(false)
    expect(
      resolveThreadSelectionNavigationAction({
        usesSplitView: layout.usesSplitView,
        pathname: '/threads/vivid/one',
      }),
    ).toBe('push')
  }
})

it('tablet selects peer conversations without growing history', () => {
  const layout = deriveLayout({ width: 1024, height: 768 })
  expect(layout.usesSplitView).toBe(true)
  expect(layout.listPaneWidth).toBe(328)
  expect(
    resolveThreadSelectionNavigationAction({
      usesSplitView: true,
      pathname: '/',
    }),
  ).toBe('push')
  expect(
    resolveThreadSelectionNavigationAction({
      usesSplitView: true,
      pathname: '/threads/vivid/one',
    }),
  ).toBe('set-params')
  expect(
    resolveThreadSelectionNavigationAction({
      usesSplitView: true,
      pathname: '/Library',
    }),
  ).toBe('replace')
})

it('inspector cannot squeeze the main thread below its usable width', () => {
  const panes = deriveWorkspacePaneLayout({
    layout: deriveLayout({ width: 900, height: 700 }),
    viewportWidth: 900,
    primarySidebarPreferredVisible: true,
    auxiliaryPanePreferredVisible: true,
    auxiliaryPaneRole: 'inspector',
  })

  expect(panes.primarySidebarSuppressedByAuxiliary).toBe(true)
  expect(panes.contentPaneWidth - (panes.auxiliaryPaneWidth ?? 0)).toBeGreaterThanOrEqual(560)
})

it('phone content padding does not go negative', () => {
  expect(
    deriveCenteredContentHorizontalPadding({
      viewportWidth: 320,
      maxContentWidth: 760,
      minimumPadding: 20,
    }),
  ).toBe(20)
})
