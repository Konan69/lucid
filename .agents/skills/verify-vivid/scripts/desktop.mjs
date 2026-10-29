import * as NodeFSP from 'node:fs/promises'
import * as NodeAssert from 'node:assert/strict'
import * as NodeEvents from 'node:events'
import { doctor } from './doctor.mjs'
import { json, alive } from './process.mjs'
import { buildDesktop } from './desktopbuild.mjs'
import { start, environment } from './desktopprocess.mjs'
import { desktopCleanup } from './desktopcleanup.mjs'
import { connect, renderer } from './cdp.mjs'
import { signIn, linked, browse, DesktopModelUnavailable } from './desktopjourney.mjs'
import { deviceState } from './devices.mjs'
import { rpc } from './wire.mjs'

/** NetLog stays private. Retain only egress URL source ids and handshake status, never raw headers. */
async function egress(state, directory) {
  const log = JSON.parse(await NodeFSP.readFile(state.scratch + '/desktop-netlog.json', 'utf8'))
  const types = Object.fromEntries(
    Object.entries(log.constants.logEventTypes).map(([k, v]) => [v, k]),
  )
  const events = log.events.filter(
    (event) =>
      Object.hasOwn(event, 'params') &&
      event.params.url === state.web.replace(/^http/u, 'ws') + '/api/computer/egress',
  )
  const sources = new Set(events.map((event) => event.source.id))
  const replies = log.events.filter(
    (event) =>
      sources.has(event.source.id) &&
      types[event.type] === 'HTTP_TRANSACTION_READ_RESPONSE_HEADERS',
  )
  const statuses = replies.flatMap((event) =>
    event.params.headers.filter((header) => header.startsWith('HTTP/')),
  )
  await json(directory + '/egress-socket.json', {
    events: events.map((event) => ({ type: types[event.type], source: event.source })),
    statuses,
    routing: 'blocked: no recipe drives the Computer browser through this egress yet',
  })
  NodeAssert.ok(
    statuses.includes('HTTP/1.1 101 Switching Protocols'),
    'Native egress socket did not upgrade',
  )
}

/** This serial recipe owns one built app, profile, X display and default browser per server run. */
export async function desktop(state) {
  await doctor(state)
  if (process.exitCode) throw new Error('Doctor refused desktop drive')
  const directory = state.evidence + '/desktop'
  await NodeFSP.mkdir(directory, { recursive: true })
  await NodeAssert.rejects(NodeFSP.access(state.scratch + '/desktop.json'), { code: 'ENOENT' })
  const receipt = { scratch: state.scratch, processes: [] }
  const base = {
    feature: '.agents/skills/verify-vivid/features/desktop.md',
    head: state.head,
    dirty: state.dirty,
    diffHash: state.diffHash,
    tree: state.tree,
    model: state.model,
    modelKind: state.modelKind,
    host: state.hostname,
    devbox: state.devbox,
    sandbox: state.sandbox,
    hostBoot: state.hostBoot,
  }
  await json(directory + '/context.json', base)
  let browser
  let launched
  let device
  let verdict
  try {
    const built = await buildDesktop(state)
    const env = await environment(state)
    const display = await start(state, receipt, {
      argv: ['Xvfb', '-displayfd', '1', '-screen', '0', '1440x1000x24', '-nolisten', 'tcp'],
      env,
      pattern: /^(\d+)\s*$/mu,
      name: 'xvfb',
    })
    const number = await display.ready
    launched = await start(state, receipt, {
      argv: [
        built.electron,
        '--no-sandbox',
        '--disable-gpu',
        '--remote-debugging-port=0',
        '--remote-debugging-address=127.0.0.1',
        '--user-data-dir=' + state.scratch + '/desktop-profile',
        '--log-net-log=' + state.scratch + '/desktop-netlog.json',
        built.app,
      ],
      env: { ...env, DISPLAY: ':' + number },
      pattern: /DevTools listening on (ws:\/\/[^\s]+)/u,
      name: 'electron',
    })
    browser = await connect(await launched.ready)
    const page = await renderer(browser)
    await signIn(state, page, directory)
    device = await linked(state, page, directory)
    await browse(state, page, directory)
    await rpc(state, 'RevokeDevice', { id: device.id }, directory, 'native-revoked')
    await deviceState(state, directory, 'native-offline', (list) =>
      list.devices.some((d) => d.id === device.id && d.presence._tag === 'Offline'),
    )
    verdict = {
      ...base,
      verdict: 'proved',
      scope:
        'Linux native email sign-in, outbound Google handoff/Cancel, device link/Allow/revoke, model browse in Electron',
      unsupported: [
        'Google grant/session trade',
        'Person Computer egress routing',
        'Windows native apps/cookie copy',
        'macOS native behavior',
        'packaged installers and OS activation',
      ],
    }
  } catch (error) {
    verdict = {
      ...base,
      verdict: error instanceof DesktopModelUnavailable ? 'blocked' : 'failed',
      reason: error.message,
    }
    process.exitCode = 1
  } finally {
    try {
      if (browser && launched && (await alive(launched.owned))) {
        const exited = NodeEvents.once(launched.child, 'close', {
          signal: AbortSignal.timeout(20_000),
        })
        void exited.catch(() => {})
        await browser.send('Browser.close')
        await exited
        await egress(state, directory)
      }
    } catch (error) {
      verdict = { ...verdict, verdict: 'failed', observationFailure: error.message }
      process.exitCode = 1
    } finally {
      if (browser) browser.close()
    }
    try {
      await desktopCleanup(state)
    } catch (error) {
      verdict = { ...verdict, verdict: 'failed', cleanupFailure: error.message }
      process.exitCode = 1
    }
    await json(directory + '/verdict.json', verdict)
  }
  console.log(JSON.stringify(verdict))
}

await desktop(JSON.parse(await NodeFSP.readFile(process.argv[2], 'utf8')))
