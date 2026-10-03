import * as NodeFS from 'node:fs'
import * as NodeFSP from 'node:fs/promises'
import * as NodeNet from 'node:net'
import { Effect, Schema } from 'effect'
import { chromium } from 'playwright-core'
import { bootstrap } from './network.mjs'

/** A readiness failure carries no profile contents or third-party connection payload. */
class DesktopNotReady extends Schema.TaggedError()(
  'DesktopNotReady',
  {},
  { title: 'Desktop not ready' },
) {}

/** A filesystem event signals Chromium startup; no arbitrary readiness sleep races its CDP socket. */
const browserReady = Effect.fn('Computer.browser.ready')(function* () {
  const profile = '/tmp/vivid'
  const marker = `${profile}/browser.log`
  const listening = () =>
    NodeFS.existsSync(marker) &&
    NodeFS.readFileSync(marker, 'utf8').includes('DevTools listening on')
  yield* Effect.callback((resume) => {
    // Watch before checking existence so a marker written between the two cannot be missed.
    const watcher = NodeFS.watch(profile, () => {
      if (listening()) {
        watcher.close()
        resume(Effect.void)
      }
    })
    watcher.on('error', () => resume(Effect.fail(new DesktopNotReady())))
    if (listening()) {
      watcher.close()
      resume(Effect.void)
    }
    return Effect.sync(() => watcher.close())
  })
  const browser = yield* Effect.tryPromise({
    try: () => chromium.connectOverCDP('http://127.0.0.1:9222'),
    catch: () => new DesktopNotReady(),
  })
  yield* Effect.tryPromise({ try: () => browser.close(), catch: () => new DesktopNotReady() })
})

/** A successful TCP connection proves the screen listener exists without polling health metadata. */
const screenReady = Effect.fn('Computer.screen.ready')(function* () {
  yield* Effect.callback((resume) => {
    const socket = NodeNet.createConnection({ host: '127.0.0.1', port: 6080 })
    socket.on('connect', () => {
      socket.end()
      resume(Effect.void)
    })
    socket.on('error', () => resume(Effect.fail(new DesktopNotReady())))
    return Effect.sync(() => socket.destroy())
  })
})

/** The provider awaits actual browser and screen readiness before publishing Running facts. */
await Effect.runPromise(
  Effect.gen(function* () {
    if (process.argv[2] === 'network') {
      yield* bootstrap()
      return
    }
    yield* browserReady()
    yield* screenReady()
    yield* Effect.tryPromise({
      try: () => NodeFSP.writeFile('/tmp/vivid/ready', 'ready'),
      catch: () => new DesktopNotReady(),
    })
  }),
)
