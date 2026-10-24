import * as NodeAssert from 'node:assert/strict'
import * as NodeCrypto from 'node:crypto'
import * as NodeHttp from 'node:http'
import * as NodeProcess from 'node:process'
import type * as NodeStream from 'node:stream'
import { BrowserAction, DeviceAnswer, type BrowseResult } from '@vivid/contracts'
import { Deferred, Effect, Fiber, Option, Result, Schema } from 'effect'
import * as TestClock from 'effect/testing/TestClock'
import { BrowserWindow, app, nativeImage, net, session, type WebContents } from 'electron'
import { Browser } from '../src/main/browser.ts'
import { executor } from '../src/main/control.ts'
import { liveAddress } from '../src/main/device.ts'
import { controlledBrowser } from '../src/main/driver.ts'
import { vividMayOpen } from '../src/main/reach.ts'
import { PagesRequest, ShowingTab, UsedTab, type Tab } from '../src/shared/pages.ts'

/**
 * The real executor, inside real Electron, against real pages. Nothing here is scripted: every
 * assertion is on what the page, the Browser or the network actually did. Run by
 * `src/main/driver.live.test.ts` under `xvfb-run`, in a disposable profile.
 *
 * It needs the public internet: `https://example.com` for the pages, and
 * `https://httpbin.org/redirect-to` for a public address that redirects to this computer.
 */

const profile = NodeProcess.argv[2]
if (profile === undefined) throw new Error('An isolated profile is required')
app.setPath('userData', profile)

/** Native callbacks use the standalone test runtime, exactly like main's Electron adapter. */
function run(program: Effect.Effect<void>): void {
  // oxlint-disable-next-line vivid/no-runpromise-in-library -- Standalone Electron test event adapter.
  void Effect.runPromise(program)
}

/** Says each proved item on stdout, so a failed run shows how far it got. */
const proved = (item: string) => Effect.sync(() => console.log(`proved: ${item}`))

/** Runs a script in the page and returns what it evaluated to. */
const inPage = <Value>(contents: WebContents, script: string) =>
  Effect.promise((): Promise<Value> => contents.executeJavaScript(script, true))

const decodeAddress = Schema.decodeUnknownResult(Schema.Struct({ port: Schema.Int }))
/**
 * The port a listening server was given. A server with no port is not listening, which this
 * proof cannot go on from: the schema's own error ends it, as its other broken premises do.
 */
const portOf = (server: NodeHttp.Server) => Result.getOrThrow(decodeAddress(server.address())).port

/** Starts a server on a free loopback port, and closes it with the proof. */
const listening = (server: NodeHttp.Server) =>
  Effect.acquireRelease(
    Effect.callback<NodeHttp.Server>((resume) => {
      server.listen(0, '127.0.0.1', () => resume(Effect.succeed(server)))
    }),
    (started) =>
      Effect.sync(() => {
        started.closeAllConnections()
        started.close()
      }),
  )

/** What every step of the proof works with. */
interface Stage {
  readonly browser: Browser
  /** One action through the real executor, with a real deadline. */
  readonly act: (action: BrowserAction) => Effect.Effect<Option.Option<DeviceAnswer>>
  /** The result of an action that must have been carried out. */
  readonly done: (action: BrowserAction) => Effect.Effect<BrowseResult>
  readonly stop: (tab: Tab) => void
  /** Hears the next time the Browser says which page Vivid is using. */
  readonly onUsing: (listener: (using: typeof UsedTab.Type) => void) => void
}

const refused = (reason: 'Stopped' | 'PageGone' | 'NotAllowed' | 'Unsupported') =>
  Option.some(DeviceAnswer.cases.Refused.make({ reason }))
const failed = Option.some(DeviceAnswer.cases.Failed.make({}))

/** The page in front, as the Browser has it. */
const frontTab = (browser: Browser): Tab => {
  const state = browser.current()
  if (!ShowingTab.guards.Some(state.showing)) throw new Error('No page is in front')
  return state.showing.value
}

/** What the page has counted since the form was written into it. */
const seen = (guest: WebContents) => inPage<Record<string, number>>(guest, 'window.seen')

/** Items 1 to 4: open a public page, read it, click its link by name, come back. */
const navigation = Effect.fn('Proof.navigation')(function* ({ done }: Stage) {
  const opened = yield* done(BrowserAction.cases.Open.make({ address: 'https://example.com' }))
  NodeAssert.equal(opened.address, 'https://example.com/')
  NodeAssert.equal(opened.title, 'Example Domain')
  NodeAssert.deepEqual(opened.tabs, [
    { title: 'Example Domain', address: 'https://example.com/', showing: true },
  ])
  yield* proved('1 open')

  // The page has no heading today; its title is "Example Domain" (asserted above) and its body
  // is this sentence and one link.
  const read = yield* done(BrowserAction.cases.Read.make({}))
  NodeAssert.match(read.outline, /text "This domain is for use in documentation examples/u)
  NodeAssert.match(read.outline, /link "Learn more"/u)
  yield* proved('2 read')

  // The page has never been placed on the window: this is a click on a page that is not drawn.
  const clicked = yield* done(BrowserAction.cases.Click.make({ target: 'Learn more' }))
  NodeAssert.notEqual(new URL(clicked.address).hostname, 'example.com')
  yield* proved(`3 click (went to ${new URL(clicked.address).hostname})`)

  const back = yield* done(BrowserAction.cases.Back.make({}))
  NodeAssert.equal(back.address, 'https://example.com/')
  yield* proved('4 back')
})

/**
 * Item 5: Type and Press on real inputs. The page is the real example.com; the proof writes a
 * form into its document and counts every key and button the page sees go down and up.
 */
const input = Effect.fn('Proof.input')(function* (
  { browser, act, done, onUsing }: Stage,
  guest: WebContents,
) {
  yield* inPage(
    guest,
    `(() => {
      document.body.innerHTML =
        '<form id="f"><label>Name <input id="name"></label>' +
        '<label>Password <input id="secret" type="password" value="hunter2"></label>' +
        '<button id="go" type="button">Count</button><input type="submit" value="Send"></form>'
      window.seen = { keydown: 0, keyup: 0, mousedown: 0, mouseup: 0, submitted: 0, clicks: 0 }
      for (const type of ['keydown', 'keyup', 'mousedown', 'mouseup'])
        window.addEventListener(type, () => { window.seen[type] += 1 }, true)
      document.getElementById('f').addEventListener('submit', (event) => {
        event.preventDefault()
        window.seen.submitted += 1
      })
      document.getElementById('go').addEventListener('click', () => { window.seen.clicks += 1 })
      return true
    })()`,
  )
  const before = yield* done(BrowserAction.cases.Read.make({}))
  NodeAssert.match(before.outline, /"Password" = "\(hidden\)"/u)
  NodeAssert.doesNotMatch(before.outline, /hunter2/u)
  const typed = yield* done(BrowserAction.cases.Type.make({ target: 'Name', text: 'Ada Lovelace' }))
  NodeAssert.match(typed.outline, /textbox "Name" = "Ada Lovelace"/u)
  NodeAssert.equal(
    yield* inPage<string>(guest, 'document.getElementById("name").value'),
    'Ada Lovelace',
  )
  const secret = yield* done(
    BrowserAction.cases.Type.make({ target: 'Password', text: 'correct horse' }),
  )
  NodeAssert.equal(
    yield* inPage<string>(guest, 'document.getElementById("secret").value'),
    'correct horse',
  )
  NodeAssert.match(secret.outline, /"Password" = "\(hidden\)"/u)
  NodeAssert.doesNotMatch(secret.outline, /correct horse/u)

  // Placement can be delayed by the renderer. Advancing controlled time past the old cutoff
  // must send no input and leave the action waiting for the actual placement receipt.
  yield* Effect.gen(function* () {
    const using = yield* Deferred.make<void>()
    onUsing((now) => {
      if (UsedTab.guards.Some(now)) Deferred.doneUnsafe(using, Effect.void)
    })
    const pressing = yield* act(BrowserAction.cases.Press.make({ key: 'Enter' })).pipe(
      Effect.forkChild,
    )
    yield* Deferred.await(using)
    onUsing(() => {})
    // Chromium answers this after the input-enable command ahead of it. The action can then
    // reach its placement wait before controlled time advances.
    yield* Effect.promise(() => guest.debugger.sendCommand('Runtime.evaluate', { expression: '0' }))
    yield* TestClock.adjust('4 seconds')
    NodeAssert.equal(pressing.pollUnsafe(), undefined)
    const undrawn = yield* seen(guest)
    NodeAssert.equal(undrawn['keydown'], 0)
    NodeAssert.equal(undrawn['keyup'], 0)
    yield* browser.handle(
      PagesRequest.cases.Place.make({ placement: { x: 0, y: 0, width: 800, height: 600 } }),
    )
    const answer = yield* Fiber.join(pressing)
    NodeAssert.equal(Option.exists(answer, DeviceAnswer.guards.Done), true)
  }).pipe(Effect.provide(TestClock.layer()))
  const pressed = yield* seen(guest)
  NodeAssert.equal(pressed['submitted'], 1)
  NodeAssert.equal(pressed['keydown'], 1)
  NodeAssert.equal(pressed['keyup'], 1)
  yield* browser.handle(PagesRequest.cases.Place.make({ placement: 'hidden' }))

  yield* done(BrowserAction.cases.Click.make({ target: 'Count' }))
  const clicked = yield* seen(guest)
  NodeAssert.equal(clicked['clicks'], 1)
  NodeAssert.equal(clicked['mousedown'], 1)
  NodeAssert.equal(clicked['mouseup'], 1)
  yield* proved(
    '5 type, press (drawn), click, password hidden; delayed placement: no early input and no elapsed-time failure',
  )
})

/** The size of the picture in an answer, which must be a real PNG of a sane size. */
const pictureOf = (result: BrowseResult) => {
  if (result.picture === undefined) throw new Error('The answer has no picture')
  const bytes = Buffer.from(result.picture, 'base64')
  NodeAssert.equal(bytes.subarray(1, 4).toString('latin1'), 'PNG')
  const size = nativeImage.createFromBuffer(bytes).getSize()
  NodeAssert.ok(size.width > 100 && size.width <= 1280, `width ${size.width}`)
  NodeAssert.ok(size.height > 100, `height ${size.height}`)
  return size
}

/** Item 6: a picture of a page that is not drawn, and of the same page drawn. */
const pictures = Effect.fn('Proof.pictures')(function* ({ browser, done }: Stage) {
  const hidden = pictureOf(yield* done(BrowserAction.cases.Screenshot.make({})))
  yield* browser.handle(
    PagesRequest.cases.Place.make({ placement: { x: 0, y: 0, width: 800, height: 600 } }),
  )
  const drawn = pictureOf(yield* done(BrowserAction.cases.Screenshot.make({})))
  NodeAssert.equal((yield* done(BrowserAction.cases.Read.make({}))).picture, undefined)
  yield* proved(
    `6 screenshot (not drawn ${hidden.width}x${hidden.height}, drawn ${drawn.width}x${drawn.height})`,
  )
})

/**
 * Item 7: Stop. A wait is running on the page and the page says so; Stop ends it at once. Then
 * Stop in the middle of a click: the moment the page sees the button go down, the Person stops
 * Vivid, and the button must still come back up.
 */
const stopping = Effect.fn('Proof.stopping')(function* (
  { browser, act, stop, onUsing }: Stage,
  guest: WebContents,
  tab: Tab,
) {
  const using = yield* Deferred.make<void>()
  onUsing((now) => {
    if (UsedTab.guards.Some(now)) Deferred.doneUnsafe(using, Effect.void)
  })
  const waiting = yield* Effect.forkChild(act(BrowserAction.cases.Wait.make({ seconds: 10 })))
  yield* Deferred.await(using)
  onUsing(() => {})
  const started = Date.now()
  stop(tab)
  NodeAssert.deepEqual(yield* Fiber.join(waiting), refused('Stopped'))
  const elapsed = Date.now() - started
  NodeAssert.ok(elapsed < 1_000, `Stop took ${elapsed} ms`)
  NodeAssert.deepEqual(browser.current().using, UsedTab.cases.None.make({}))

  const before = yield* seen(guest)
  const pressed = (_event: Electron.Event, _level: number, message: string): void => {
    if (message === 'vivid-proof-down') stop(tab)
  }
  guest.on('console-message', pressed)
  yield* inPage(
    guest,
    `window.addEventListener('mousedown', () => console.log('vivid-proof-down'), true); true`,
  )
  const midClick = yield* act(BrowserAction.cases.Click.make({ target: 'Count' }))
  guest.removeListener('console-message', pressed)
  const after = yield* seen(guest)
  NodeAssert.notEqual(after['mousedown'], before['mousedown'])
  NodeAssert.equal(after['mouseup'], after['mousedown'])
  NodeAssert.equal(after['keydown'], after['keyup'])
  const how = Option.exists(midClick, DeviceAnswer.guards.Done) ? 'click finished first' : 'stopped'
  yield* proved(`7 stop (${elapsed} ms; mid-click: ${how}; nothing left held)`)
})

/** Item 8: Vivid stays off this computer and its network, first hop and redirect alike. */
const refusals = Effect.fn('Proof.refusals')(function* ({ act }: Stage, guest: WebContents) {
  let hits = 0
  const local = yield* listening(
    NodeHttp.createServer((_request, response) => {
      hits += 1
      response.end('<title>Local</title>')
    }),
  )
  const loopback = `http://127.0.0.1:${portOf(local)}/`
  const redirectTo = (address: string) =>
    `https://httpbin.org/redirect-to?url=${encodeURIComponent(address)}`
  for (const address of [
    loopback,
    'http://192.168.1.1/',
    redirectTo(loopback),
    redirectTo('http://192.168.1.1/'),
  ]) {
    NodeAssert.deepEqual(
      yield* act(BrowserAction.cases.Open.make({ address })),
      refused('NotAllowed'),
      address,
    )
    NodeAssert.equal(hits, 0, address)
    // The document in the page is not one from this computer or its network.
    NodeAssert.doesNotMatch(
      yield* inPage<string>(guest, 'location.href'),
      /127\.0\.0\.1|192\.168\./u,
      address,
    )
  }
  yield* proved('8 refusals: loopback, private, public redirects to loopback and to private')
})

/**
 * Item 9: a page somebody else is inspecting. Electron gives a page one debugger client, and
 * Vivid acts only through a session it attached itself (`src/main/driver.ts` `attach`).
 *
 * The refusal that is reached: the proof takes the page's debugger for itself, the way an
 * outside inspector holds it, and Vivid's next action must answer `Failed` and leave the page
 * where it was; once the proof lets go, Vivid attaches again and reads the same page.
 *
 * The refusal that is not reached: `attach` also refuses a page whose developer tools are open.
 * The pages session admits only web addresses, so the tools' own document is cancelled and they
 * never open on a page. What is shown for them is that asking opens nothing: the page never
 * says they opened, by its event or by its own reading, across a whole navigation of Vivid's,
 * which `attach` would have failed had they been open.
 */
const inspection = Effect.fn('Proof.inspection')(function* (
  { act, done }: Stage,
  guest: WebContents,
) {
  const opened = yield* done(BrowserAction.cases.Open.make({ address: 'https://example.com' }))
  NodeAssert.equal(opened.address, 'https://example.com/')
  // Vivid's own session is on the page after its action. Letting go of it and taking the
  // debugger from here leaves the page held by a client that is not Vivid's.
  NodeAssert.equal(guest.debugger.isAttached(), true)
  guest.debugger.detach()
  guest.debugger.attach('1.3')
  NodeAssert.deepEqual(yield* act(BrowserAction.cases.Read.make({})), failed)
  // The refused action took nothing over: the page is where it was, still held from here.
  NodeAssert.equal(yield* inPage<string>(guest, 'location.href'), 'https://example.com/')
  NodeAssert.equal(guest.debugger.isAttached(), true)
  guest.debugger.detach()
  const read = yield* done(BrowserAction.cases.Read.make({}))
  NodeAssert.equal(read.address, 'https://example.com/')
  NodeAssert.match(read.outline, /link "Learn more"/u)
  yield* proved('9 a page held by another debugger is refused, and taken up again when it lets go')

  let toolsOpened = false
  guest.once('devtools-opened', () => {
    toolsOpened = true
  })
  guest.openDevTools({ mode: 'detach' })
  const again = yield* done(BrowserAction.cases.Open.make({ address: 'https://example.com' }))
  NodeAssert.equal(again.address, 'https://example.com/')
  NodeAssert.equal(toolsOpened, false)
  NodeAssert.equal(guest.isDevToolsOpened(), false)
  yield* proved('9 developer tools asked for on a page do not open (their refusal is not reached)')
})

/**
 * Item 10: the link's transport. Electron's `net.WebSocket`, in a session, sends that session's
 * cookie on the upgrade. (The class is on `net` at run time; `electron` itself does not export
 * it, whatever its type declarations say. This proof is what found that.) The server completes
 * the handshake of RFC 6455 and records the upgrade's headers; no frames are exchanged.
 */
const transport = Effect.fn('Proof.transport')(function* () {
  const upgraded = yield* Deferred.make<NodeHttp.IncomingHttpHeaders>()
  const sockets: Array<NodeStream.Duplex> = []
  const server = NodeHttp.createServer()
  server.on('upgrade', (request, socket) => {
    sockets.push(socket)
    const accept = NodeCrypto.createHash('sha1')
      .update(`${request.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64')
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    )
    Deferred.doneUnsafe(upgraded, Effect.succeed(request.headers))
  })
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      for (const socket of sockets) socket.destroy()
    }),
  )
  const origin = `http://127.0.0.1:${portOf(yield* listening(server))}`
  const appSession = session.fromPartition(`vivid-app-${NodeCrypto.randomUUID()}`)
  yield* Effect.promise(() =>
    appSession.cookies.set({ url: origin, name: 'vivid.session_token', value: 'proof-token' }),
  )
  // Opened exactly as `main.ts` opens the link's socket.
  const socket = new net.WebSocket(liveAddress(origin), {
    session: appSession,
    useSessionCookies: true,
    origin,
  })
  const headers = yield* Deferred.await(upgraded)
  NodeAssert.equal(headers['cookie'], 'vivid.session_token=proof-token')
  NodeAssert.equal(headers['origin'], origin)
  NodeAssert.equal(headers['upgrade'], 'websocket')
  socket.close()
  yield* proved('10 socket carries the session cookie')
})

/** The real Browser and the real executor, wired as `main.ts` wires them. */
const stage = Effect.fn('Proof.stage')(function* () {
  const window = new BrowserWindow({
    show: false,
    width: 1000,
    height: 800,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  })
  let stop: (tab: Tab) => void = () => {}
  let usingChanged: (using: typeof UsedTab.Type) => void = () => {}
  const browser = new Browser({
    window,
    session: session.fromPartition(`vivid-control-${NodeCrypto.randomUUID()}`),
    stopVivid: (tab) => stop(tab),
    mayOpen: vividMayOpen,
    publish: (state) => usingChanged(state.using),
    downloadRefused: () => {},
    run,
  })
  const control = yield* executor({
    browser: controlledBrowser(() => Option.some(browser)),
    mac: NodeProcess.platform === 'darwin',
    mayOpen: vividMayOpen,
    using: (tab) => browser.used(tab),
  })
  stop = control.stop
  yield* Effect.promise(() => window.loadURL('data:text/html,<title>Vivid test</title>'))
  window.show()
  // The executor takes one step in a page and when its authority ends (`PageWork`), which is what
  // `main.ts` hands it from the `Page` work of a server request. The request's own identifier,
  // Thread and Run stay with the link (`device.ts`) and never reach the executor.
  const act = (action: BrowserAction) => control.execute({ action, expiresAt: Date.now() + 30_000 })
  return {
    browser,
    act,
    done: (action) =>
      Effect.map(act(action), (answer) => {
        if (Option.isNone(answer) || !DeviceAnswer.guards.Done(answer.value))
          throw new Error(`Expected Done for ${action._tag}: ${JSON.stringify(answer)}`)
        return answer.value.result
      }),
    stop: control.stop,
    onUsing: (listener) => {
      usingChanged = listener
    },
  } satisfies Stage
})

/**
 * A transient profile exercises the executor end to end. The standalone Electron process owns the
 * window: both terminal callbacks call app.exit, before the parent removes its profile.
 */
const proof = Effect.scoped(
  Effect.gen(function* () {
    yield* Effect.promise(() => app.whenReady())
    const staged = yield* stage()
    yield* Effect.callback<void>((resume) => {
      NodeProcess.stdin.once('data', () => resume(Effect.void))
      console.log('Vivid native control ready')
    })
    yield* navigation(staged)
    const tab = frontTab(staged.browser)
    const guest = yield* staged.browser.contents(tab)
    yield* input(staged, guest)
    yield* pictures(staged)
    yield* stopping(staged, guest, tab)
    yield* refusals(staged, guest)
    yield* inspection(staged, guest)
    yield* transport()
    console.log('Vivid native control proof passed')
  }),
)

// Standalone Electron test executable: this runtime never enters application server/library code.
// oxlint-disable-next-line vivid/no-runpromise-in-library -- Standalone Electron test executable entry.
void Effect.runPromise(proof).then(
  () => app.exit(0),
  (cause) => {
    console.error(cause)
    app.exit(1)
  },
)
