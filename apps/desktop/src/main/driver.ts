import * as Effect from 'effect/Effect'
import { webContents, type WebContents } from 'electron'
import * as Option from 'effect/Option'
import { PageUnavailable, type Tab } from '../shared/pages.ts'
import { browserSnapshot, emptyBrowserState } from './pages.ts'
import type { Browser } from './browser.ts'
import {
  PageGone,
  StepFailed,
  type CommandParameters,
  type ControlledBrowser,
  type ControlledPage,
} from './control.ts'

/** The debugger protocol version the reference attaches with (`wc.debugger.attach("1.3")`). */
const PROTOCOL = '1.3'
/**
 * The widest picture taken, in pixels; wider pages are scaled down. The reference's
 * `MAX_SCREENSHOT_WIDTH` (`preview/Manager.ts`).
 */
const WIDEST_PICTURE = 1280
/**
 * How long a loading page is waited for before it is read as it stands. Vivid's own bound: the
 * reference returns from navigation without waiting and leaves waiting to a separate tool, but a
 * `BrowseResult` is the page after the action, so the action waits for the load it started.
 */
const SETTLE = '10 seconds'

/** A closed page and a refused command are different answers to Vivid. */
const failure = (contents: WebContents, step: string) =>
  contents.isDestroyed() ? new PageGone({}) : new StepFailed({ step })

/** One debugger command on one page. Its answer is unknown data until the executor decodes it. */
const command = (contents: WebContents, method: string, parameters: CommandParameters) =>
  Effect.tryPromise({
    try: () => contents.debugger.sendCommand(method, parameters),
    catch: () => failure(contents, method),
  })

/**
 * The pages whose debugger session is Vivid's own: attached here and fully initialised. A page
 * leaves when its debugger detaches for any reason, and with the page itself when it closes.
 */
const owned = new WeakSet<WebContents>()

/** Enables the domains the actions read. A session that cannot be initialised is not kept. */
const initialise = (contents: WebContents) =>
  Effect.all(
    [command(contents, 'Runtime.enable', {}), command(contents, 'Accessibility.enable', {})],
    { concurrency: 'unbounded', discard: true },
  ).pipe(
    Effect.onError(() =>
      Effect.sync(() => {
        if (!contents.isDestroyed() && contents.debugger.isAttached()) contents.debugger.detach()
      }),
    ),
  )

/**
 * Makes sure Vivid's own debugger session is on the page, attaching it the first time Vivid acts
 * there and leaving it attached until the page closes.
 *
 * Ported from the reference's `ensureControlSession` (`preview/Manager.ts`): a session Vivid
 * already owns is reused; a page whose developer tools are open is refused; otherwise attach at
 * protocol 1.3 and enable the domains, and if enabling fails, detach, so the next action starts
 * clean instead of finding an attachment that was never initialised. A debugger that is attached
 * but is not Vivid's is refused too: Electron allows one client, and its session is not ours to
 * use. The page's `detach` event (developer tools opened, the target crashed) ends ownership.
 *
 * What Vivid changes: only `Runtime` and `Accessibility` are enabled. The reference also enables
 * `Network` and `Log` and keeps console and network entries for its own tools; Vivid's answer
 * has no place for them, so nothing is collected.
 */
const attach = Effect.fn('DesktopDriver.attach')(function* (contents: WebContents) {
  if (contents.isDestroyed()) return yield* new PageGone({})
  if (owned.has(contents) && contents.debugger.isAttached()) return undefined
  if (contents.isDevToolsOpened() || contents.debugger.isAttached())
    return yield* new StepFailed({ step: 'debugger' })
  yield* Effect.try({
    try: () => {
      contents.debugger.attach(PROTOCOL)
      contents.debugger.once('detach', () => owned.delete(contents))
    },
    catch: () => failure(contents, 'attach'),
  })
  yield* initialise(contents)
  owned.add(contents)
  return undefined
})

/**
 * Gives the page itself the keyboard and returns how to give it back, as the reference's
 * `performAutomationPress` does: remember which contents had focus, focus the guest (not its
 * window, so nothing comes to the front), and afterwards refocus what had it if it still exists.
 */
const focus = (contents: WebContents) =>
  Effect.try({
    try: () => {
      const previous = webContents.getFocusedWebContents()
      contents.focus()
      return Effect.sync(() => {
        if (previous !== null && previous.id !== contents.id && !previous.isDestroyed())
          previous.focus()
      })
    },
    catch: () => new PageGone({}),
  })

/** A picture of the page as drawn, scaled down when it is wider than the reference allows. */
const capture = (contents: WebContents) =>
  Effect.tryPromise({
    try: () => contents.capturePage(),
    catch: () => failure(contents, 'capture'),
  }).pipe(
    Effect.map((taken) => {
      const image =
        taken.getSize().width > WIDEST_PICTURE ? taken.resize({ width: WIDEST_PICTURE }) : taken
      return { png: image.toPNG().toString('base64'), ...image.getSize() }
    }),
  )

/**
 * Waits for a loading page to stop, on Chromium's own signal. A page that is not loading, or has
 * closed, returns at once; one that never stops is read as it stands after `SETTLE`.
 */
const settle = (contents: WebContents) =>
  Effect.callback<void>((resume) => {
    if (contents.isDestroyed() || !contents.isLoading()) {
      resume(Effect.void)
      return undefined
    }
    const stopped = (): void => resume(Effect.void)
    contents.once('did-stop-loading', stopped)
    contents.once('destroyed', stopped)
    return Effect.sync(() => {
      contents.removeListener('did-stop-loading', stopped)
      contents.removeListener('destroyed', stopped)
    })
  }).pipe(Effect.timeoutOption(SETTLE), Effect.asVoid)

/** One page of the Browser, attached and ready to be acted on. */
const controlledPage = Effect.fn('DesktopDriver.page')(function* (browser: Browser, tab: Tab) {
  const contents = yield* browser
    .contents(tab)
    .pipe(Effect.catchTag('PageMissing', () => Effect.fail(new PageGone({}))))
  yield* attach(contents)
  return {
    tab,
    send: (method, parameters) => command(contents, method, parameters),
    focus: focus(contents),
    capture: capture(contents),
    settle: settle(contents),
  } satisfies ControlledPage
})

/**
 * The app's own Browser as the executor drives it: Chromium's debugger on each page, and the same
 * page operations the Person's tab row uses for everything that is not input.
 *
 * The mechanism is the reference desktop's control session (`preview/Manager.ts`,
 * `withControlSession` and `ensureControlSession`): `webContents.debugger`, commands sent one at
 * a time. The reference's other half, stopping when the person touches the page, is deliberately
 * not ported (see `executor` in `control.ts`).
 */
export const controlledBrowser = (
  // The Browser belongs to the app window and is gone while no window is open; an action that
  // arrives then finds no page, which is the truth.
  browser: () => Option.Option<Browser>,
): ControlledBrowser => ({
  state: () =>
    Option.match(browser(), {
      onNone: () => browserSnapshot(emptyBrowserState),
      onSome: (open) => open.current(),
    }),
  page: (tab) =>
    Option.match(browser(), {
      onNone: () => Effect.fail(new PageGone({})),
      onSome: (open) => controlledPage(open, tab),
    }),
  request: (request) =>
    Option.match(browser(), {
      onNone: () => Effect.fail(new PageUnavailable({})),
      onSome: (open) => open.handle(request),
    }),
  visit: (tab, address) =>
    Option.match(browser(), {
      onNone: () => Effect.fail(new PageUnavailable({})),
      onSome: (open) => open.visit(tab, address),
    }),
  refused: (tab) => Option.exists(browser(), (open) => open.refused(tab)),
})
