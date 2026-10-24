import * as NodeFSP from 'node:fs/promises'
import * as NodeAssert from 'node:assert/strict'
import * as NodeNet from 'node:net'
import { RunState } from '@vivid/contracts'
import { button, click, fill, wait } from './cdp.mjs'
import { deviceState } from './devices.mjs'
import { rpc, settled, history, json } from './wire.mjs'

/** Missing model authority blocks the journey without misreporting a native action failure. */
export class DesktopModelUnavailable extends Error {}

/** Screens and semantic DOM are retained together; passwords never enter the retained DOM text. */
export async function capture(page, directory, name) {
  const { data } = await page.send('Page.captureScreenshot', { format: 'png' })
  await NodeFSP.writeFile(directory + '/' + name + '.png', Buffer.from(data, 'base64'))
  await NodeFSP.writeFile(
    directory + '/' + name + '.txt',
    await page.evaluate('document.body.innerText'),
  )
}

/** Observe the private opener receipt before pressing Google; the URL never becomes evidence. */
async function opened(state, action) {
  const abort = new AbortController()
  const watcher = NodeFSP.watch(state.scratch, {
    signal: AbortSignal.any([abort.signal, AbortSignal.timeout(90_000)]),
  })
  const receipt = (async () => {
    for await (const event of watcher)
      if (event.filename === 'desktop-external.json')
        return JSON.parse(await NodeFSP.readFile(state.scratch + '/desktop-external.json', 'utf8'))
    throw new Error('Default browser did not open')
  })()
  void receipt.catch(() => {})
  try {
    await action()
    return await receipt
  } finally {
    abort.abort()
    await watcher.return()
  }
}

/** A refused connection, rather than a changed screen, proves Cancel closed the loopback listener. */
async function closed(port) {
  return new Promise((resolve, reject) => {
    const socket = NodeNet.connect({ host: '127.0.0.1', port })
    socket.once('connect', () => {
      socket.destroy()
      reject(new Error('Sign-in port survived Cancel'))
    })
    socket.once('error', (error) => {
      if (error.code === 'ECONNREFUSED') resolve()
      else reject(error)
    })
  })
}

/** Drive the outbound system-browser handoff and cancellation, without fabricating a Google grant. */
export async function signIn(state, page, directory) {
  await capture(page, directory, 'chooser')
  await fill(page, '#address', state.web)
  await page.navigate(() => click(page, button('Connect')))
  await wait(page, button('Continue with Google'))
  await capture(page, directory, 'signed-out')
  const external = await opened(state, () => click(page, button('Continue with Google')))
  await wait(page, button('Cancel'))
  const start = new URL(external.address)
  NodeAssert.equal(start.origin, state.web)
  NodeAssert.equal(start.pathname, '/api/auth/desktop/google')
  const port = Number(start.searchParams.get('port'))
  NodeAssert.ok(Number.isInteger(port) && port > 0)
  const wrong = await fetch(`http://127.0.0.1:${port}/?state=wrong&error=failed`)
  NodeAssert.equal(wrong.status, 404)
  const redirect = await fetch(start, { redirect: 'manual' })
  NodeAssert.equal(redirect.status, 302)
  const google = new URL(redirect.headers.get('location'))
  NodeAssert.equal(google.hostname, 'accounts.google.com')
  await json(directory + '/signin-handoff.json', {
    opener: 'xdg-open with private Chrome profile on Xvfb',
    path: start.pathname,
    port,
    challengePresent: start.searchParams.has('challenge'),
    wrongAttempt: wrong.status,
    serverRedirect: redirect.status,
    destination: google.origin,
    grant: 'blocked: disposable Google client is rehearsal; no real OAuth authority',
  })
  await capture(page, directory, 'handoff-waiting')
  await click(page, button('Cancel'))
  await wait(page, 'document.querySelector("input[type=email]")')
  await closed(port)
  await json(directory + '/signin-cleanup.json', { port, closed: true })
  await click(page, button('I already have an account'))
  const account = JSON.parse(await NodeFSP.readFile(state.scratch + '/account.json', 'utf8'))
  await fill(page, 'input[type=email]', account.email)
  await fill(page, 'input[type=password]', account.password)
  await page.navigate(() => click(page, button('Sign in')))
  await wait(page, `document.querySelector('[aria-label="Message Vivid"]')`)
  await capture(page, directory, 'signed-in')
}

/** Allow the real enrolled installation through the visible card, then require native stream presence. */
export async function linked(state, page, directory) {
  const pending = await deviceState(state, directory, 'native-pending', (list) =>
    list.devices.some((d) => d.access._tag === 'Pending'),
  )
  const device = pending.devices.find((d) => d.access._tag === 'Pending')
  await capture(page, directory, 'device-pending')
  await click(page, button('Allow'))
  await deviceState(state, directory, 'native-connected', (list) =>
    list.devices.some((d) => d.id === device.id && d.presence._tag === 'Connected'),
  )
  await capture(page, directory, 'device-connected')
  await rpc(state, 'GetEgress', undefined, directory, 'egress-status')
  return device
}

/** Only the model's production browse tool can open this guest; the harness reads its public state. */
export async function browse(state, page, directory) {
  NodeAssert.equal(state.modelKind, 'real', 'Desktop browser-control proof needs a real model')
  const id = crypto.randomUUID()
  await rpc(
    state,
    'CreateThread',
    { id, title: 'Verify desktop browser', projectId: null },
    directory,
  )
  await page.navigate(() => page.send('Page.navigate', { url: state.web + '/t/' + id }))
  const prompt =
    'Use the browse tool on my computer (computer="person"). Open https://example.com then read that page. Do not use your own Computer, shell, web search, or fetch. Report the page title and stop.'
  await fill(page, '[aria-label="Message Vivid"]', prompt)
  await capture(page, directory, 'before-browser-action')
  await click(page, 'document.querySelector("button[aria-label=Send]")')
  try {
    await settled(state, id, 1, 'Completed', directory)
  } catch (error) {
    const detail = await rpc(state, 'GetThread', { id }, directory, 'browser-failure')
    await capture(page, directory, 'browser-failed')
    if (
      detail.runs.some(
        (run) => RunState.guards.Failed(run.state) && run.state.reason === 'ModelUnavailable',
      )
    ) {
      throw new DesktopModelUnavailable(
        'Model unavailable; native browser-control action remains unverified. Inspect runtime.log for the provider refusal.',
      )
    }
    throw error
  }
  const saved = await history(state, id, directory)
  const pages = await page.evaluate(`new Promise(resolve => {
    let stop = () => {}; stop = window.vivid.pages.watch(state => { stop(); resolve(state) })
  })`)
  await json(directory + '/native-pages.json', pages)
  NodeAssert.match(JSON.stringify(pages), /https:\/\/example\.com\//u)
  NodeAssert.match(JSON.stringify(pages), /Example Domain/u)
  const steps = saved.messages
    .filter((message) => message.role === 'assistant')
    .flatMap((message) => message.parts)
    .filter(
      (part) =>
        part.type === 'dynamic-tool' &&
        part.toolName === 'browse' &&
        part.state === 'output-available',
    )
  NodeAssert.ok(
    steps.some((step) => step.output.ok === true),
    'No successful browse tool receipt',
  )
  await json(directory + '/browse-receipts.json', steps)
  await capture(page, directory, 'after-browser-action')
  await json(directory + '/browser-action.json', {
    thread: id,
    prompt,
    page: 'https://example.com/',
  })
}
