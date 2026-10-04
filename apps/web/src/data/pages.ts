import {
  PageFavicon,
  ShowingTab,
  UsedTab,
  type BrowserState,
  type Page,
  type PagePlacement,
  type Tab,
  type VividAppBridge,
} from '@vivid/desktop/bridge'
import { Option, Schema } from 'effect'
import { panel } from './panel'
import { say } from './said'

/**
 * Pages opened inside Vivid, beside the Thread. They exist only in the desktop app, where each one
 * is a real browser view the app owns, kept apart from Vivid's own session. In a browser tab there
 * is no such thing, and everything here says so by being absent: `available` is false, and a link
 * opens the way links do.
 *
 * The desktop app keeps the pages; this module mirrors what it reports (the tabs in order and
 * which one is showing) and adds the one thing only the panel knows: whether the Person is looking
 * at the pages or at Vivid's computer.
 */

declare global {
  /** Put on the window by the desktop app's preload. Absent everywhere else. */
  var vivid: VividAppBridge
}

const bridge = 'vivid' in globalThis ? Option.some(globalThis.vivid.pages) : Option.none()

/** What the panel has in front: Vivid's computer, an open page, or a page not opened yet. */
export type Front = 'computer' | 'page' | 'new'

const NO_PAGES: BrowserState = {
  revision: 0,
  tabs: [],
  showing: ShowingTab.cases.None.make({}),
  using: UsedTab.cases.None.make({}),
}

const listeners = new Set<() => void>()
let state = NO_PAGES
let front: Front = 'computer'

const tell = () => {
  for (const listener of listeners) listener()
}

const bring = (next: Front) => {
  if (next === front) return
  front = next
  tell()
}

if (Option.isSome(bridge)) {
  bridge.value.watch((next) => {
    // Vivid has started using a page: bring that page and the panel forward, so the Person sees
    // what Vivid is doing and has the Stop button in front of them. Only on the change, so a
    // Person who then looks elsewhere is not pulled back for the rest of the action.
    const started = UsedTab.guards.None(state.using) && UsedTab.guards.Some(next.using)
    state = next
    if (started) {
      front = 'page'
      panel.show()
    }
    // The last page closing leaves nothing to show, so the panel goes back to the computer.
    if (next.tabs.length === 0 && front === 'page') front = 'computer'
    tell()
  })
  bridge.value.watchDownloads((refused) =>
    say(`“${refused.filename}” was not downloaded. Vivid’s pages do not keep files yet.`),
  )
}

/** Runs one thing on the pages, and says so in plain words when the desktop app refuses it. */
const ask = (act: (pages: VividAppBridge['pages']) => Promise<void | Tab>, refused: string) => {
  if (Option.isNone(bridge)) return
  void act(bridge.value).catch((failure: Parameters<typeof tooMany>[0]) =>
    // One refusal has its own sentence: there is a limit on open pages, and "could not be opened"
    // would leave the Person trying again instead of closing one.
    say(tooMany(failure) ? 'Too many pages are open. Close one and try again.' : refused),
  )
}

/** Whether the desktop app refused because the limit on open pages was reached. */
const tooMany = Schema.is(Schema.Struct({ _tag: Schema.Literal('PageLimitReached') }))

/** The page that is showing, when there is one. */
const showing = (browser: BrowserState): Option.Option<Page> =>
  ShowingTab.match(browser.showing, {
    None: () => Option.none(),
    Some: ({ value }) => Option.fromUndefinedOr(browser.tabs.find((page) => page.tab === value)),
  })

export const pages = {
  /** Whether this is the desktop app, the only place a page can be opened inside Vivid. */
  available: Option.isSome(bridge),
  subscribe: (listener: () => void) => {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  },
  current: () => state,
  front: () => front,
  showing,
  /** Whether Vivid is acting on this page right now. The page says so while it is. */
  usedByVivid: (browser: BrowserState, page: Page) =>
    UsedTab.guards.Some(browser.using) && browser.using.value === page.tab,
  /** The page's own icon, when the document has declared one; otherwise the tab draws a globe. */
  favicon: (page: Page) =>
    PageFavicon.match(page.favicon, {
      None: () => Option.none<string>(),
      Some: ({ value }) => Option.some(value),
    }),
  /** Puts Vivid's computer in front. The pages stay open behind it. */
  toComputer: () => bring('computer'),
  /** A page that has not been opened yet: the address field, waiting for somewhere to go. */
  toNew: () => bring('new'),
  /** Opens an address, or a search for words that are not one, in a new page beside the Thread. */
  open: (address: string) => {
    bring('page')
    panel.show()
    ask((browser) => browser.open({ address }), 'That page could not be opened.')
  },
  show: (tab: Tab) => {
    bring('page')
    ask((browser) => browser.show(tab), 'That page is no longer open.')
  },
  close: (tab: Tab) => ask((browser) => browser.close(tab), 'That page could not be closed.'),
  /** Main closes the others in one step, so it keeps its own selection and reopen history. */
  closeOthers: (keep: Tab) =>
    ask((browser) => browser.closeOthers(keep), 'The other pages could not be closed.'),
  /** Main owns the order and reports it back through the same subscription; nothing is guessed here. */
  reorder: (tab: Tab, to: number) =>
    ask((browser) => browser.move({ tab, to }), 'The page could not be moved.'),
  /** A duplicate is a new page with its own history, not a second view of the first. */
  duplicate: (tab: Tab) => {
    bring('page')
    ask((browser) => browser.duplicate(tab), 'The page could not be duplicated.')
  },
  /** Main restores the page it kept when it was closed; the address is never guessed here. */
  reopen: () => {
    bring('page')
    ask((browser) => browser.reopen(), 'There is no closed page to reopen.')
  },
  go: (tab: Tab, address: string) =>
    ask((browser) => browser.go({ tab, address }), 'That page could not be opened.'),
  back: (tab: Tab) => ask((browser) => browser.back(tab), 'There is nowhere to go back to.'),
  forward: (tab: Tab) =>
    ask((browser) => browser.forward(tab), 'There is nowhere to go forward to.'),
  reload: (tab: Tab) =>
    ask((browser) => browser.reload(tab), 'That page could not be loaded again.'),
  stop: (tab: Tab) => ask((browser) => browser.stop(tab), 'That page could not be stopped.'),
  /** Stops what Vivid is doing on this page, at once. Vivid is told the Person stopped it. */
  stopVivid: (tab: Tab) =>
    ask((browser) => browser.stopVivid(tab), 'Vivid could not be stopped. Try again.'),
  /** Where on the window the showing page is drawn, or that it is not drawn at all. */
  place: (placement: PagePlacement) => ask((browser) => browser.place(placement), ''),
  /** Closes every page, as part of signing out. What the pages remembered is kept. */
  reset: () => ask((browser) => browser.reset(), ''),
}
