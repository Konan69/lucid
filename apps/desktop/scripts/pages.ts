import * as NodeAssert from 'node:assert/strict'
import * as NodeProcess from 'node:process'
import { app, BrowserWindow, session, webContents } from 'electron'
import { Effect } from 'effect'
import { Browser } from '../src/main/browser.ts'
import { zoomPage } from '../src/main/menu.ts'
import { PagesRequest, PagesResponse } from '../src/shared/pages.ts'

/** Native popup callbacks re-enter the standalone test runtime, exactly as main's Electron adapter does. */
function runPopup(program: Effect.Effect<void>): void {
  // oxlint-disable-next-line vivid/no-runpromise-in-library -- Standalone Electron test event adapter.
  void Effect.runPromise(program)
}

/** A real transient Chromium session exercises native admission, capture denial and viewport zoom. */
const proof = Effect.scoped(
  Effect.gen(function* () {
    yield* Effect.promise(() => app.whenReady())
    const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true } })
    yield* Effect.addFinalizer(() => Effect.sync(() => window.destroy()))
    yield* Effect.promise(() => window.loadURL('data:text/html,<title>Vivid test</title>'))
    const guests = session.fromPartition(`vivid-test-${crypto.randomUUID()}`)
    guests.protocol.handle('https', () => new Response('<title>Fixture</title>'))
    const browser = new Browser({
      window,
      session: guests,
      publish: () => {},
      downloadRefused: () => {},
      // The browser owns popup admission; the fixture awaits the published native receipts below.
      run: runPopup,
    })
    const start = webContents.getAllWebContents().length
    for (let index = 0; index < 12; index++)
      yield* browser.handle(PagesRequest.cases.Open.make({ address: 'https://fixture.example/' }))
    // Suite setup owns native startup. The test starts only after all twelve guests are allocated.
    yield* Effect.callback<void>((resume) => {
      NodeProcess.stdin.once('data', () => resume(Effect.void))
      console.log('Vivid native pages ready')
    })
    const refusal = yield* browser
      .handle(PagesRequest.cases.Open.make({ address: 'https://fixture.example/' }))
      .pipe(Effect.flip)
    NodeAssert.equal(refusal._tag, 'PageLimitReached')
    NodeAssert.equal(webContents.getAllWebContents().length - start, 12)
    const state = yield* browser.handle(PagesRequest.cases.Get.make({}))
    if (!PagesResponse.guards.State(state)) return yield* Effect.die('Expected pages state')
    const first = state.value.tabs[0]
    if (first === undefined) return yield* Effect.die('Expected first tab')
    const views = window.contentView.children
    yield* browser.handle(PagesRequest.cases.Show.make({ tab: first.tab }))
    yield* browser.handle(
      PagesRequest.cases.Place.make({ placement: { x: 10, y: 20, width: 100, height: 200 } }),
    )
    const visible = window.contentView.children.find((view) => !views.includes(view))
    if (visible === undefined) return yield* Effect.die('Expected attached guest')
    zoomPage(window, 'in')
    const zoom = window.webContents.getZoomFactor()
    NodeAssert.deepEqual(visible.getBounds(), {
      x: Math.round(10 * zoom),
      y: Math.round(20 * zoom),
      width: Math.round(100 * zoom),
      height: Math.round(200 * zoom),
    })
    // Guest navigation has committed before asking Chromium for permission or opening popups.
    const guest = webContents.getAllWebContents().find((contents) => contents.session === guests)
    if (guest === undefined) return yield* Effect.die('Expected Chromium guest')
    if (guest.isLoading())
      yield* Effect.callback<void>((resume) => {
        guest.once('did-stop-loading', () => resume(Effect.void))
      })
    const capture = yield* Effect.promise(() =>
      guest.executeJavaScript(
        'navigator.mediaDevices.getDisplayMedia({video:true}).then(() => "allowed", error => error.name)',
        true,
      ),
    )
    NodeAssert.equal(capture, 'NotAllowedError')
    yield* Effect.promise(() =>
      guest.executeJavaScript(
        'for(let i=0;i<20;i++) window.open("https://fixture.example/"); true;',
      ),
    )
    NodeAssert.equal(webContents.getAllWebContents().length - start, 12)
    yield* browser.handle(PagesRequest.cases.Close.make({ tab: first.tab }))
    yield* browser.handle(PagesRequest.cases.Open.make({ address: 'https://fixture.example/' }))
    console.log('Vivid native pages proof passed')
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
// Keep Electron's tests independent of a developer's persisted profile and service endpoints.
const profile = NodeProcess.argv[2]
if (profile === undefined) throw new Error('An isolated profile is required')
app.setPath('userData', profile)
