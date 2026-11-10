import * as Array from 'effect/Array'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import {
  BrowserState,
  Page,
  Tab,
  ShowingTab,
  UsedTab,
  PageLoadFailure,
  PageFavicon,
} from '../shared/pages.ts'

/** Opener identity is main-owned metadata, never renderer or website authority. */
const OwnedPage = Schema.Struct({ ...Page.fields, opener: ShowingTab })
type OwnedPage = typeof OwnedPage.Type

/** A close descriptor restores the current address and slot, not a Chromium back operation. */
const ClosedPage = Schema.Struct({ page: OwnedPage, index: Schema.Int })

/** Reopen history and opener relations remain internal to main. */
export const PageState = Schema.Struct({
  ...BrowserState.fields,
  tabs: Schema.Array(OwnedPage),
  closed: Schema.Array(ClosedPage),
})
export type PageState = typeof PageState.Type

/** Chromium's background disposition must never steal selection or native input. */
export const PageDisposition = Schema.Literals(['foreground', 'background'])
export type PageDisposition = typeof PageDisposition.Type

/** Guest events and bridge actions share one pure transition vocabulary. */
export const PageChange = Schema.TaggedUnion({
  Opened: { page: Page },
  Popup: { page: Page, opener: Tab, disposition: PageDisposition },
  Duplicated: { tab: Tab, duplicate: Tab },
  Reopened: { tab: Tab },
  Moved: { tab: Tab, to: Schema.Int },
  CloseOthers: { tab: Tab },
  Shown: { tab: Tab },
  Closed: { tab: Tab },
  Changed: { page: Page },
  Favicon: { tab: Tab, favicon: PageFavicon },
  Navigating: { tab: Tab, address: Schema.String },
  Failed: { tab: Tab, address: Schema.String, reason: Schema.String },
  /** Vivid starts or stops acting on a page. */
  Used: { using: UsedTab },
  Reset: {},
})
export type PageChange = typeof PageChange.Type

/** Whether two answers to "which page is Vivid using" name the same page, or both name none. */
function sameUsed(left: typeof UsedTab.Type, right: typeof UsedTab.Type): boolean {
  return UsedTab.match(left, {
    None: () => UsedTab.guards.None(right),
    Some: ({ value }) => UsedTab.guards.Some(right) && right.value === value,
  })
}

/** No page is selected before main creates a guest. */
export const emptyBrowserState = PageState.make({
  revision: 0,
  tabs: [],
  showing: ShowingTab.cases.None.make({}),
  using: UsedTab.cases.None.make({}),
  closed: [],
})

/** Project only renderer data; internal opener relations and close descriptors never cross IPC. */
export function browserSnapshot(state: PageState): BrowserState {
  return BrowserState.make({
    revision: state.revision,
    showing: state.showing,
    using: state.using,
    tabs: state.tabs.map((page) =>
      Page.make({
        tab: page.tab,
        address: page.address,
        title: page.title,
        favicon: page.favicon,
        loading: page.loading,
        canGoBack: page.canGoBack,
        canGoForward: page.canGoForward,
        failed: page.failed,
      }),
    ),
  })
}

/** Update a surviving page only; late guest callbacks cannot resurrect a closed tab. */
function updatePage(state: PageState, tab: Tab, update: (page: OwnedPage) => OwnedPage): PageState {
  if (!state.tabs.some((page) => page.tab === tab)) return state
  return PageState.make({
    ...state,
    revision: state.revision + 1,
    tabs: state.tabs.map((page) => (page.tab === tab ? update(page) : page)),
  })
}

/** Select the right neighbor, then left; retain at most ten descriptors in close order. */
function closePage(state: PageState, tab: Tab): PageState {
  const index = state.tabs.findIndex((page) => page.tab === tab)
  const page = state.tabs[index]
  if (page === undefined) return state
  const tabs = state.tabs.filter((current) => current.tab !== tab)
  const showing =
    ShowingTab.guards.Some(state.showing) && state.showing.value === tab
      ? Option.match(Array.get(tabs, Math.min(index, tabs.length - 1)), {
          onNone: () => ShowingTab.cases.None.make({}),
          onSome: (neighbor) => ShowingTab.cases.Some.make({ value: neighbor.tab }),
        })
      : state.showing
  return PageState.make({
    revision: state.revision + 1,
    tabs,
    showing,
    // A page that closes while Vivid is acting on it is no longer a page Vivid is using.
    using:
      UsedTab.guards.Some(state.using) && state.using.value === tab
        ? UsedTab.cases.None.make({})
        : state.using,
    closed: Array.takeRight([...state.closed, ClosedPage.make({ page, index })], 10),
  })
}

/** Insert by final slot; foreground pages select, background pages preserve the current owner. */
function insertPage(
  state: PageState,
  page: OwnedPage,
  index: number,
  disposition: PageDisposition,
): PageState {
  return PageState.make({
    ...state,
    revision: state.revision + 1,
    tabs: [...state.tabs.slice(0, index), page, ...state.tabs.slice(index)],
    showing:
      disposition === 'foreground'
        ? ShowingTab.cases.Some.make({ value: page.tab })
        : state.showing,
  })
}

/** A new browsing context starts at the saved address with fresh history and failure flags. */
function restoredPage(page: OwnedPage, tab: Tab): OwnedPage {
  return OwnedPage.make({
    ...page,
    tab,
    loading: true,
    canGoBack: false,
    canGoForward: false,
    failed: PageLoadFailure.cases.None.make({}),
  })
}

/** Move changes only ordering; missing handles and out-of-range positions leave state untouched. */
function movePage(state: PageState, tab: Tab, to: number): PageState {
  const page = state.tabs.find((current) => current.tab === tab)
  if (page === undefined || to < 0 || to >= state.tabs.length || state.tabs[to] === page)
    return state
  const tabs = state.tabs.filter((current) => current.tab !== tab)
  return PageState.make({
    ...state,
    revision: state.revision + 1,
    tabs: [...tabs.slice(0, to), page, ...tabs.slice(to)],
  })
}

/** Close in visual order, selecting the survivor; the last removed page becomes the next reopen. */
function closeOthers(state: PageState, tab: Tab): PageState {
  if (!state.tabs.some((page) => page.tab === tab)) return state
  const selected = reducePages(state, PageChange.cases.Shown.make({ tab }))
  return state.tabs.reduce(
    (next, page) => (page.tab === tab ? next : closePage(next, page.tab)),
    selected,
  )
}

/**
 * Ordering, selection and reopen descriptors are independent of Electron. Failure survives loading
 * snapshots; a new navigation clears failure and favicon so the old site's icon cannot linger.
 */
export function reducePages(state: PageState, change: PageChange): PageState {
  return PageChange.match(change, {
    Opened: ({ page }) =>
      insertPage(
        state,
        OwnedPage.make({ ...page, opener: ShowingTab.cases.None.make({}) }),
        state.tabs.length,
        'foreground',
      ),
    Popup: ({ page, opener, disposition }) => {
      const index = state.tabs.findIndex((current) => current.tab === opener)
      if (index < 0) return state
      return insertPage(
        state,
        OwnedPage.make({ ...page, opener: ShowingTab.cases.Some.make({ value: opener }) }),
        index + 1,
        disposition,
      )
    },
    Duplicated: ({ tab, duplicate }) => {
      const index = state.tabs.findIndex((page) => page.tab === tab)
      const page = state.tabs[index]
      if (page === undefined) return state
      return insertPage(state, restoredPage(page, duplicate), index + 1, 'foreground')
    },
    Reopened: ({ tab }) =>
      Option.match(Array.last(state.closed), {
        onNone: () => state,
        onSome: ({ page, index }) =>
          insertPage(
            PageState.make({ ...state, closed: state.closed.slice(0, -1) }),
            restoredPage(page, tab),
            Math.min(index, state.tabs.length),
            'foreground',
          ),
      }),
    Moved: ({ tab, to }) => movePage(state, tab, to),
    CloseOthers: ({ tab }) => closeOthers(state, tab),
    Shown: ({ tab }) => {
      if (!state.tabs.some((page) => page.tab === tab)) return state
      return PageState.make({
        ...state,
        revision: state.revision + 1,
        showing: ShowingTab.cases.Some.make({ value: tab }),
      })
    },
    Closed: ({ tab }) => closePage(state, tab),
    Changed: ({ page }) =>
      updatePage(state, page.tab, (current) =>
        OwnedPage.make({ ...page, opener: current.opener, failed: current.failed }),
      ),
    Favicon: ({ tab, favicon }) =>
      updatePage(state, tab, (page) => OwnedPage.make({ ...page, favicon })),
    Navigating: ({ tab, address }) =>
      updatePage(state, tab, (page) =>
        OwnedPage.make({
          ...page,
          address,
          loading: true,
          failed: PageLoadFailure.cases.None.make({}),
          favicon: PageFavicon.cases.None.make({}),
        }),
      ),
    Failed: ({ tab, address, reason }) =>
      updatePage(state, tab, (page) =>
        OwnedPage.make({
          ...page,
          address,
          loading: false,
          failed: PageLoadFailure.cases.Some.make({ value: reason }),
        }),
      ),
    Used: ({ using }) =>
      sameUsed(state.using, using)
        ? state
        : PageState.make({ ...state, revision: state.revision + 1, using }),
    Reset: () => PageState.make({ ...emptyBrowserState, revision: state.revision + 1 }),
  })
}
