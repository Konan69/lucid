import * as Effect from 'effect/Effect'
import type { WebContents } from 'electron'
import { BrowserPicture } from '@vivid/contracts'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
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
const decodePicture = Schema.decodeUnknownEffect(BrowserPicture)

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
/** Pages whose navigation requests are already being listened to; listening is set up once. */
const followed = new WeakSet<WebContents>()

/** Enables the domains the actions read. A session that cannot be initialised is not kept. */
const initialise = (contents: WebContents) =>
  Effect.all(
    [
      command(contents, 'Runtime.enable', {}),
      command(contents, 'Accessibility.enable', {}),
      command(contents, 'Page.enable', {}),
    ],
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
 * already owns is reused; a page whose developer tools are open is refused (here on every
 * action, where the reference checks only before attaching); otherwise attach at
 * protocol 1.3 and enable the domains, and if enabling fails, detach, so the next action starts
 * clean instead of finding an attachment that was never initialised. A debugger that is attached
 * but is not Vivid's is refused too: Electron allows one client, and its session is not ours to
 * use. The page's `detach` event (developer tools opened, the target crashed) ends ownership.
 *
 * What Vivid changes: only `Runtime`, `Accessibility` and `Page` are enabled (`Page` for the
 * navigation signal `settle` waits on). The reference also enables
 * `Network` and `Log` and keeps console and network entries for its own tools; Vivid's answer
 * has no place for them, so nothing is collected.
 */
const attach = Effect.fn('DesktopDriver.attach')(function* (contents: WebContents) {
  if (contents.isDestroyed()) return yield* new PageGone({})
  // Checked before anything else, on every action: in Electron 44.4.3 developer tools opened on
  // a page do not detach a debugger that is already attached (run against the pinned Electron),
  // so an owned session alone does not mean nobody else is inspecting the page.
  if (contents.isDevToolsOpened()) return yield* new StepFailed({ step: 'devtools' })
  if (owned.has(contents) && contents.debugger.isAttached()) return undefined
  if (contents.debugger.isAttached()) return yield* new StepFailed({ step: 'debugger' })
  yield* Effect.try({
    try: () => {
      contents.debugger.attach(PROTOCOL)
      contents.debugger.once('detach', () => owned.delete(contents))
    },
    catch: () => failure(contents, 'attach'),
  })
  yield* initialise(contents)
  if (!followed.has(contents)) {
    followed.add(contents)
    follow(contents)
  }
  owned.add(contents)
  return undefined
})

/** Two rendered frames confirm the placed page is drawing; cancellation removes both callbacks. */
const DRAWING = `new Promise((resolve) => {
  const key = Symbol.for("vivid.drawing")
  let frame = requestAnimationFrame(() => {
    frame = requestAnimationFrame(() => { delete window[key]; resolve("drawing") })
  })
  window[key] = () => { cancelAnimationFrame(frame); delete window[key]; resolve("cancelled") }
})`
const decodeDrawing = Schema.decodeUnknownEffect(
  Schema.Struct({ result: Schema.Struct({ value: Schema.Literal('drawing') }) }),
)

/**
 * Gives the page the keyboard, once it is drawn on the window.
 *
 * Found by running against real pages: Chromium does not deliver keys reliably to a page that is
 * not being drawn. Some arrived, some were dropped, and some arrived after the action had been
 * answered as failed, whatever was tried to make the page look shown. A key that may or may not
 * arrive cannot be reported honestly, so a key is pressed only on a page the Person can see.
 * The renderer shows the page Vivid is using (so the Person can see it and stop it); this waits
 * for placement and drawing, until the action is cancelled or the page closes.
 */
const keyboard = Effect.fn('DesktopDriver.keyboard')(function* (
  browser: Browser,
  tab: Tab,
  contents: WebContents,
) {
  yield* Effect.callback<void, PageGone>((resume) => {
    const gone = () => resume(Effect.fail(new PageGone({})))
    contents.once('destroyed', gone)
    const stop = browser.whenDrawn(tab, () => resume(Effect.void))
    return Effect.sync(() => {
      stop()
      contents.removeListener('destroyed', gone)
    })
  })
  // Placed is not yet drawing: a page takes a moment to draw after it is put on the window, and a
  // key sent in that moment was dropped. Its own animation frames are the signal that it draws.
  yield* command(contents, 'Runtime.evaluate', {
    expression: DRAWING,
    awaitPromise: true,
    returnByValue: true,
  }).pipe(
    Effect.flatMap(decodeDrawing),
    Effect.mapError(() => failure(contents, 'drawing')),
    Effect.ensuring(
      command(contents, 'Runtime.evaluate', {
        expression:
          '(() => { const cancel = window[Symbol.for("vivid.drawing")]; if (cancel) cancel() })()',
      }).pipe(Effect.ignore),
    ),
  )
  return yield* browser
    .keyboard(tab)
    .pipe(Effect.catchTag('PageMissing', () => Effect.fail(new PageGone({}))))
})

/** A picture of the page as drawn, scaled down when it is wider than the reference allows. */
const capture = (contents: WebContents) =>
  Effect.tryPromise({
    try: () => contents.capturePage(),
    catch: () => failure(contents, 'capture'),
  }).pipe(
    Effect.flatMap((taken) => {
      const image =
        taken.getSize().width > WIDEST_PICTURE ? taken.resize({ width: WIDEST_PICTURE }) : taken
      // An empty capture, or one too large for an answer, is a failed step: the contract's
      // picture is a real PNG within its size limit or it is not sent.
      return decodePicture(image.toPNG().toString('base64')).pipe(
        Effect.mapError(() => new StepFailed({ step: 'picture' })),
        Effect.map((png) => ({ png, ...image.getSize() })),
      )
    }),
  )

/**
 * Pages that have asked to go somewhere and have not arrived yet. Clicking a link or pressing
 * Enter in a form does not navigate at once: the page asks, and the load starts a moment later.
 * Chromium says so on the debugger (`Page.frameRequestedNavigation`), from the page's own
 * process and so in order with the answers to commands sent to it. Found by running the executor
 * against a real page: without this, a click on a link was answered with the page it had left.
 */
const leaving = new WeakSet<WebContents>()

/** Hears a page ask to navigate, and hears it arrive, fail or turn out to stay in the document. */
function follow(contents: WebContents): void {
  contents.debugger.on('message', (_event, method) => {
    if (method === 'Page.frameRequestedNavigation') leaving.add(contents)
  })
  const arrived = (): void => {
    leaving.delete(contents)
  }
  contents.on('did-stop-loading', arrived)
  contents.on('did-navigate-in-page', arrived)
}

/** Resolves when the page stops loading or closes. */
const stopped = (contents: WebContents) =>
  Effect.callback<void>((resume) => {
    const done = (): void => resume(Effect.void)
    contents.once('did-stop-loading', done)
    contents.once('did-navigate-in-page', done)
    contents.once('destroyed', done)
    if (contents.isDestroyed() || (!leaving.has(contents) && !contents.isLoading())) done()
    return Effect.sync(() => {
      contents.removeListener('did-stop-loading', done)
      contents.removeListener('did-navigate-in-page', done)
      contents.removeListener('destroyed', done)
    })
  })

/**
 * Lets what an action set off finish, on Chromium's own signals.
 *
 * One command is sent to the page first and its answer awaited: by then the page has handled the
 * input before it, and has said so if that input made it ask to navigate. A page that asked, or
 * is loading, is waited for until it stops or its owner cancels. A page doing neither returns at
 * once. A page in the middle of leaving may refuse the command; that is the same news, so the refusal is not a failure.
 */
const settle = Effect.fn('DesktopDriver.settle')(function* (contents: WebContents) {
  if (contents.isDestroyed()) return undefined
  yield* command(contents, 'Runtime.evaluate', { expression: '0' }).pipe(Effect.ignore)
  // One stop is not always the end: found by running a real redirect right after a refused
  // one, where the earlier load's late stop was taken for the new load's, and the page was
  // described mid-flight. So it waits until the page is neither leaving nor loading.
  const arrived = Effect.fn('DesktopDriver.arrived')(function* () {
    while (!contents.isDestroyed() && (leaving.has(contents) || contents.isLoading()))
      yield* stopped(contents)
  })
  yield* arrived()
  return undefined
})

/** One page of the Browser, attached and ready to be acted on. */
const controlledPage = Effect.fn('DesktopDriver.page')(function* (browser: Browser, tab: Tab) {
  const contents = yield* browser
    .contents(tab)
    .pipe(Effect.catchTag('PageMissing', () => Effect.fail(new PageGone({}))))
  yield* attach(contents)
  return {
    tab,
    send: (method, parameters) => command(contents, method, parameters),
    focus: keyboard(browser, tab, contents),
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
