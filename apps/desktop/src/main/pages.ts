import * as Array from 'effect/Array'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import { BrowserState, Page, Tab, ShowingTab, PageLoadFailure } from '../shared/pages.ts'

/** Guest events and bridge actions share one pure transition vocabulary. */
export const PageChange = Schema.TaggedUnion({
  Opened: { page: Page },
  Shown: { tab: Tab },
  Closed: { tab: Tab },
  Changed: { page: Page },
  Navigating: { tab: Tab, address: Schema.String },
  Failed: { tab: Tab, address: Schema.String, reason: Schema.String },
  Reset: {},
})
export type PageChange = typeof PageChange.Type

/** No page is selected before main creates a guest. */
export const emptyBrowserState = BrowserState.make({
  revision: 0,
  tabs: [],
  showing: ShowingTab.cases.None.make({}),
})

/** Update a surviving page only; late guest callbacks cannot resurrect a closed tab. */
function updatePage(state: BrowserState, tab: Tab, update: (page: Page) => Page): BrowserState {
  if (!state.tabs.some((page) => page.tab === tab)) return state
  return BrowserState.make({
    revision: state.revision + 1,
    tabs: state.tabs.map((page) => (page.tab === tab ? update(page) : page)),
    showing: state.showing,
  })
}

/** Select the right neighbor at the old index, then the left neighbor when closing the last tab. */
function closePage(state: BrowserState, tab: Tab): BrowserState {
  const index = state.tabs.findIndex((page) => page.tab === tab)
  if (index < 0) return state
  const tabs = state.tabs.filter((page) => page.tab !== tab)
  const showing =
    ShowingTab.guards.Some(state.showing) && state.showing.value === tab
      ? Option.match(Array.get(tabs, Math.min(index, tabs.length - 1)), {
          onNone: () => ShowingTab.cases.None.make({}),
          onSome: (page) => ShowingTab.cases.Some.make({ value: page.tab }),
        })
      : state.showing
  return BrowserState.make({ revision: state.revision + 1, tabs, showing })
}

/**
 * Keep ordering and selection independent of Electron. Failure survives later loading snapshots;
 * only a new navigation clears it, matching Chromium's did-fail-load/did-stop-loading ordering.
 */
export function reducePages(state: BrowserState, change: PageChange): BrowserState {
  return PageChange.match(change, {
    Opened: ({ page }) =>
      BrowserState.make({
        revision: state.revision + 1,
        tabs: [...state.tabs, page],
        showing: ShowingTab.cases.Some.make({ value: page.tab }),
      }),
    Shown: ({ tab }) => {
      if (!state.tabs.some((page) => page.tab === tab)) return state
      return BrowserState.make({
        ...state,
        revision: state.revision + 1,
        showing: ShowingTab.cases.Some.make({ value: tab }),
      })
    },
    Closed: ({ tab }) => closePage(state, tab),
    Changed: ({ page }) =>
      updatePage(state, page.tab, (current) => Page.make({ ...page, failed: current.failed })),
    Navigating: ({ tab, address }) =>
      updatePage(state, tab, (page) =>
        Page.make({ ...page, address, loading: true, failed: PageLoadFailure.cases.None.make({}) }),
      ),
    Failed: ({ tab, address, reason }) =>
      updatePage(state, tab, (page) =>
        Page.make({
          ...page,
          address,
          loading: false,
          failed: PageLoadFailure.cases.Some.make({ value: reason }),
        }),
      ),
    Reset: () =>
      BrowserState.make({
        revision: state.revision + 1,
        tabs: [],
        showing: ShowingTab.cases.None.make({}),
      }),
  })
}
