import { describe, expect, it } from '@effect/vitest'
import { Page, Tab, ShowingTab, PageLoadFailure, type BrowserState } from '../shared/pages.ts'
import { PageChange, emptyBrowserState, reducePages } from './pages.ts'

const first = Tab.make('f198da28-8b59-4b86-8d14-f81f441954e1')
const second = Tab.make('4134ce7b-785f-4170-bc54-7e03f16320a0')
const third = Tab.make('b682a1a8-7d77-471f-a583-0e83ef6488d3')

/** Build realistic initial page state without minting identities or booting Electron. */
function page(tab: Tab): Page {
  return Page.make({
    tab,
    address: 'https://example.com/',
    title: '',
    loading: true,
    canGoBack: false,
    canGoForward: false,
    failed: PageLoadFailure.cases.None.make({}),
  })
}

/** Tests drive the same open transition used after the native view is created. */
function open(state: BrowserState, tab: Tab): BrowserState {
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
      Page.make({
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
      Page.make({
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
})
