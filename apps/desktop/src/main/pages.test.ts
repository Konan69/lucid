import { describe, expect, it } from '@effect/vitest'
import { Page, Tab, ShowingTab, PageLoadFailure, PageFavicon } from '../shared/pages.ts'
import {
  PageChange,
  emptyBrowserState,
  reducePages,
  OwnedPage,
  type PageState,
  browserSnapshot,
} from './pages.ts'

const first = Tab.make('f198da28-8b59-4b86-8d14-f81f441954e1')
const second = Tab.make('4134ce7b-785f-4170-bc54-7e03f16320a0')
const third = Tab.make('b682a1a8-7d77-471f-a583-0e83ef6488d3')

/** Build realistic initial page state without minting identities or booting Electron. */
function page(tab: Tab): OwnedPage {
  return OwnedPage.make({
    opener: ShowingTab.cases.None.make({}),
    tab,
    address: 'https://example.com/',
    title: '',
    favicon: PageFavicon.cases.None.make({}),
    loading: true,
    canGoBack: false,
    canGoForward: false,
    failed: PageLoadFailure.cases.None.make({}),
  })
}

/** Tests drive the same open transition used after the native view is created. */
function open(state: PageState, tab: Tab): PageState {
  return reducePages(state, PageChange.cases.Opened.make({ page: page(tab) }))
}

describe('Browser state transitions', () => {
  it('opens in order and shows an existing tab without reordering it', () => {
    const state = open(open(emptyBrowserState, first), second)
    expect(state.tabs.map((current) => current.tab)).toEqual([first, second])
    expect(state.showing).toEqual(ShowingTab.cases.Some.make({ value: second }))
    const shown = reducePages(state, PageChange.cases.Shown.make({ tab: first }))
    expect(shown.tabs).toEqual(state.tabs)
    expect(shown.showing).toEqual(ShowingTab.cases.Some.make({ value: first }))
    expect(shown.revision).toBeGreaterThan(state.revision)
    expect(reducePages(shown, PageChange.cases.Shown.make({ tab: third }))).toBe(shown)
  })

  it('selects the nearest survivor when closing the selected first, middle or last tab', () => {
    const opened = open(open(open(emptyBrowserState, first), second), third)
    for (const [closed, selected] of [
      [first, second],
      [second, third],
      [third, second],
    ] as const) {
      const shown = reducePages(opened, PageChange.cases.Shown.make({ tab: closed }))
      const state = reducePages(shown, PageChange.cases.Closed.make({ tab: closed }))
      expect(state.showing).toEqual(ShowingTab.cases.Some.make({ value: selected }))
      expect(state.tabs.map((current) => current.tab)).toEqual(
        [first, second, third].filter((tab) => tab !== closed),
      )
    }
  })

  it('preserves selection when a background tab closes and clears it after the final close', () => {
    const opened = open(open(emptyBrowserState, first), second)
    const remaining = reducePages(opened, PageChange.cases.Closed.make({ tab: first }))
    expect(remaining.showing).toEqual(ShowingTab.cases.Some.make({ value: second }))
    const empty = reducePages(remaining, PageChange.cases.Closed.make({ tab: second }))
    expect(empty.tabs).toEqual([])
    expect(empty.showing).toEqual(ShowingTab.cases.None.make({}))
    expect(reducePages(empty, PageChange.cases.Closed.make({ tab: first }))).toBe(empty)
  })

  it('keeps Chromium failure after loading stops, then clears it when a new load starts', () => {
    const opened = open(emptyBrowserState, first)
    const failed = reducePages(
      opened,
      PageChange.cases.Failed.make({
        tab: first,
        address: 'https://missing.example/',
        reason: 'ERR_NAME_NOT_RESOLVED',
      }),
    )
    const stopped = reducePages(
      failed,
      PageChange.cases.Changed.make({
        page: Page.make({
          ...page(first),
          address: 'https://missing.example/',
          loading: false,
          canGoBack: true,
        }),
      }),
    )
    expect(stopped.tabs).toEqual([
      OwnedPage.make({
        ...page(first),
        address: 'https://missing.example/',
        loading: false,
        canGoBack: true,
        failed: PageLoadFailure.cases.Some.make({ value: 'ERR_NAME_NOT_RESOLVED' }),
      }),
    ])
    const retrying = reducePages(
      stopped,
      PageChange.cases.Navigating.make({
        tab: first,
        address: 'https://example.com/retry',
      }),
    )
    expect(retrying.tabs).toEqual([
      OwnedPage.make({
        ...page(first),
        address: 'https://example.com/retry',
        canGoBack: true,
      }),
    ])
  })

  it('sign-out resets every tab and ignores late native callbacks from destroyed guests', () => {
    const opened = open(open(emptyBrowserState, first), second)
    const reset = reducePages(opened, PageChange.cases.Reset.make({}))
    expect(reset.tabs).toEqual([])
    expect(reset.showing).toEqual(ShowingTab.cases.None.make({}))
    expect(reset.revision).toBeGreaterThan(opened.revision)
    expect(
      reducePages(
        reset,
        PageChange.cases.Failed.make({
          tab: first,
          address: 'https://example.com/',
          reason: 'ERR_ABORTED',
        }),
      ),
    ).toBe(reset)
    expect(reducePages(reset, PageChange.cases.Changed.make({ page: page(second) }))).toBe(reset)
  })

  it('moves both directions using a final index, without changing selection or guest data', () => {
    const opened = open(open(open(emptyBrowserState, first), second), third)
    const left = reducePages(opened, PageChange.cases.Moved.make({ tab: third, to: 0 }))
    expect(left.tabs.map((current) => current.tab)).toEqual([third, first, second])
    expect(left.showing).toEqual(opened.showing)
    const right = reducePages(left, PageChange.cases.Moved.make({ tab: third, to: 2 }))
    expect(right.tabs).toEqual(opened.tabs)
    for (const [tab, to] of [
      [third, 2],
      [third, 3],
      [third, -1],
    ] as const)
      expect(reducePages(right, PageChange.cases.Moved.make({ tab, to }))).toBe(right)
    const single = open(emptyBrowserState, first)
    expect(reducePages(single, PageChange.cases.Moved.make({ tab: second, to: 0 }))).toBe(single)
  })

  it('duplicates the current URL next to its source into fresh navigation history', () => {
    const opened = open(open(emptyBrowserState, first), second)
    const visited = reducePages(
      opened,
      PageChange.cases.Changed.make({
        page: Page.make({
          ...page(first),
          address: 'https://example.com/current',
          title: 'Current',
          canGoBack: true,
        }),
      }),
    )
    const duplicated = reducePages(
      visited,
      PageChange.cases.Duplicated.make({ tab: first, duplicate: third }),
    )
    expect(duplicated.tabs.map((current) => current.tab)).toEqual([first, third, second])
    expect(duplicated.tabs[1]).toEqual(
      OwnedPage.make({ ...page(third), address: 'https://example.com/current', title: 'Current' }),
    )
    expect(duplicated.showing).toEqual(ShowingTab.cases.Some.make({ value: third }))
    expect(duplicated.closed).toEqual([])
    expect(
      reducePages(
        open(emptyBrowserState, first),
        PageChange.cases.Duplicated.make({ tab: second, duplicate: third }),
      ).tabs,
    ).toHaveLength(1)
  })

  it('reopens the last closed address at its old slot with a new handle, then consumes the descriptor', () => {
    const opened = open(open(open(emptyBrowserState, first), second), third)
    const visited = reducePages(
      opened,
      PageChange.cases.Changed.make({
        page: Page.make({
          ...page(second),
          address: 'https://example.com/current',
          canGoBack: true,
        }),
      }),
    )
    const closed = reducePages(visited, PageChange.cases.Closed.make({ tab: second }))
    const replacement = Tab.make('58c9130f-17d1-45fd-8ba0-bd948a81308d')
    const reopened = reducePages(closed, PageChange.cases.Reopened.make({ tab: replacement }))
    expect(reopened.tabs.map((current) => current.tab)).toEqual([first, replacement, third])
    expect(reopened.tabs[1]).toEqual(
      OwnedPage.make({ ...page(replacement), address: 'https://example.com/current' }),
    )
    expect(reopened.showing).toEqual(ShowingTab.cases.Some.make({ value: replacement }))
    expect(reopened.closed).toEqual([])
    expect(reducePages(reopened, PageChange.cases.Reopened.make({ tab: second }))).toBe(reopened)
  })

  it('bounds close history at ten, reopens in reverse close order, and clears it on reset', () => {
    const handles = Array.from({ length: 12 }, (_, index) =>
      Tab.make(`00000000-0000-4000-8000-${String(index).padStart(12, '0')}`),
    )
    const opened = handles.reduce(open, emptyBrowserState)
    let state = handles.reduce(
      (next, tab) => reducePages(next, PageChange.cases.Closed.make({ tab })),
      opened,
    )
    expect(state.closed.map(({ page: current }) => current.tab)).toEqual(handles.slice(2))
    for (let index = 11; index >= 2; index--) {
      const descriptor = state.closed.at(-1)
      expect(descriptor).toHaveProperty('page.tab', handles[index])
      const tab = Tab.make(`00000000-0000-4000-8000-${String(index + 100).padStart(12, '0')}`)
      state = reducePages(state, PageChange.cases.Reopened.make({ tab }))
    }
    expect(state.closed).toEqual([])
    const current = state.tabs[0]
    if (current === undefined) throw new Error('Expected a reopened page')
    const closed = reducePages(state, PageChange.cases.Closed.make({ tab: current.tab }))
    expect(reducePages(closed, PageChange.cases.Reset.make({})).closed).toEqual([])
  })

  it('closes every other view in visual order and preserves only the named survivor', () => {
    const opened = open(open(open(emptyBrowserState, first), second), third)
    const remaining = reducePages(opened, PageChange.cases.CloseOthers.make({ tab: first }))
    expect(remaining.tabs).toEqual([page(first)])
    expect(remaining.showing).toEqual(ShowingTab.cases.Some.make({ value: first }))
    expect(remaining.closed.map(({ page: current }) => current.tab)).toEqual([second, third])
    expect(reducePages(remaining, PageChange.cases.CloseOthers.make({ tab: second }))).toBe(
      remaining,
    )
  })

  it('inserts popups immediately after their opener and honors foreground/background selection', () => {
    const opened = open(open(emptyBrowserState, first), second)
    for (const disposition of ['foreground', 'background'] as const) {
      const popup = reducePages(
        opened,
        PageChange.cases.Popup.make({ page: page(third), opener: first, disposition }),
      )
      expect(popup.tabs.map((current) => current.tab)).toEqual([first, third, second])
      expect(popup.showing).toEqual(
        ShowingTab.cases.Some.make({ value: disposition === 'background' ? second : third }),
      )
      expect(popup.tabs[1]).toHaveProperty('opener', ShowingTab.cases.Some.make({ value: first }))
      const snapshot = browserSnapshot(popup)
      expect(snapshot.tabs[1]).not.toHaveProperty('opener')
      expect(snapshot).not.toHaveProperty('closed')
    }
    expect(
      reducePages(
        open(emptyBrowserState, first),
        PageChange.cases.Popup.make({
          page: page(third),
          opener: second,
          disposition: 'foreground',
        }),
      ).tabs,
    ).toHaveLength(1)
  })

  it('publishes favicon updates, clears them on new navigation and ignores late closed-page icons', () => {
    const opened = open(emptyBrowserState, first)
    const favicon = PageFavicon.cases.Some.make({ value: 'https://example.com/favicon.ico' })
    const changed = reducePages(opened, PageChange.cases.Favicon.make({ tab: first, favicon }))
    expect(browserSnapshot(changed).tabs[0]).toHaveProperty('favicon', favicon)
    const navigated = reducePages(
      changed,
      PageChange.cases.Navigating.make({ tab: first, address: 'https://another.example/' }),
    )
    expect(navigated.tabs[0]).toHaveProperty('favicon', PageFavicon.cases.None.make({}))
    const closed = reducePages(changed, PageChange.cases.Closed.make({ tab: first }))
    expect(reducePages(closed, PageChange.cases.Favicon.make({ tab: first, favicon }))).toBe(closed)
  })
})
