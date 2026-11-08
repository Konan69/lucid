import * as NodeAssert from 'node:assert/strict'
import * as NodeFSP from 'node:fs/promises'
import { parseEnv } from 'node:util'
import { VividRpc } from '@vivid/contracts/rpc'
import { command, json } from './process.mjs'
import { rpc } from './wire.mjs'

/** Exercise a real product dependency failure, restoring only this launch's own disposable database. */
export async function monitoring(state, _thread, directory) {
  const supplied = process.env.VIVID_VERIFY_SENTRY_KEY_FILE
  if (!supplied) throw new Error('VIVID_VERIFY_SENTRY_KEY_FILE must explicitly supply SENTRY_AUTH_TOKEN')
  const credentials = parseEnv(await NodeFSP.readFile(supplied, 'utf8'))
  if (!credentials.SENTRY_AUTH_TOKEN) throw new Error('Sentry read authority is missing')
  const begin = new Date().toISOString()
  const traceId = crypto.randomUUID().replaceAll('-', '')
  const spanId = crypto.randomUUID().replaceAll('-', '').slice(0, 16)
  const account = JSON.parse(await NodeFSP.readFile(state.scratch + '/account.json', 'utf8'))
  await json(directory + '/coverage.json', {
    operations: Array.from(VividRpc.requests.keys()).toSorted(),
    boundary: 'Both RPC transports install the same Effect reporter; this journey exercises HTTP RPC through the real entry point.',
    limits: ['Native mobile capture, symbolication and notification delivery require separate receipts.'],
  })
  await rpc(state, 'Me', undefined, directory, 'before')
  let failed = false
  try {
    await command(['docker', 'stop', '--time', '1', state.container])
    const response = await fetch(state.web + '/api/rpc', {
      method: 'POST',
      headers: { cookie: account.cookie, origin: state.web, 'content-type': 'application/ndjson' },
      body: JSON.stringify({ _tag: 'Request', id: '1', tag: 'Me', payload: null, headers: [], traceId, spanId, sampled: true }) + '\n',
    })
    const body = await response.text()
    failed = /DatabaseUnavailable|DatabaseFailure|Invalid session/.test(body)
    await json(directory + '/failure.json', { failed, status: response.status, body, traceId, spanId, begin })
  } catch (error) {
    failed = false
    await json(directory + '/failure.json', { failed, diagnosis: error.message })
  } finally {
    await command(['docker', 'start', state.container])
  }
  NodeAssert.ok(failed, 'A real database failure must reach the public RPC failure boundary')
  const query = new URLSearchParams({
    dataset: 'errors', field: 'id', query: 'project:vivid-server environment:verification trace:' + traceId,
    start: begin, end: new Date().toISOString(), per_page: '20',
  })
  const response = await fetch('https://us.sentry.io/api/0/organizations/vivid-7t/events/?' + query, {
    headers: { authorization: 'Bearer ' + credentials.SENTRY_AUTH_TOKEN },
  })
  if (!response.ok) throw new Error('Sentry receipt lookup refused with HTTP ' + response.status)
  const receipt = await response.json()
  await json(directory + '/sentry.json', { checkedAt: new Date().toISOString(), receipt })
  NodeAssert.ok(receipt.data.length > 0, 'Sentry has not indexed the actual failure yet; no coverage claim follows')
}

/** Browse drives the user's chosen Helium profile; the caller supplies an isolated session. */
export async function browserMonitoring(state) {
  const cli = process.env.VIVID_VERIFY_BROWSE
  const session = process.env.VIVID_VERIFY_BROWSE_SESSION
  if (!cli || !session) throw new Error('Supply VIVID_VERIFY_BROWSE and VIVID_VERIFY_BROWSE_SESSION for Helium')
  const account = JSON.parse(await NodeFSP.readFile(state.scratch + '/account.json', 'utf8'))
  const directory = state.evidence + '/browser/monitoring'
  await NodeFSP.mkdir(directory, { recursive: true })
  const code = `
    await page.goto(${JSON.stringify(state.web)});
    await page.getByText('I already have an account', {exact:true}).click();
    await page.getByLabel('Email', {exact:true}).fill(${JSON.stringify(account.email)});
    await page.getByLabel('Password', {exact:true}).fill(${JSON.stringify(account.password)});
    await page.getByRole('button', {name:'Sign in', exact:true}).click();
    await page.getByLabel('Message Vivid', {exact:true}).waitFor();
    await page.goto(${JSON.stringify(state.web + '/?settings=memory')});
    await page.getByRole('dialog').waitFor();
    const screenshot = files.path(${JSON.stringify(state.run + '-monitoring.png')});
    await page.screenshot({path:screenshot});
    return {url:page.url(), headings:await page.getByRole('dialog').getByRole('heading').allTextContents(), screenshot};
  `
  const result = await command([cli, 'execute', '--session', session, '--json', code], {
    redactions: [code, account.password], log: directory + '/command.json',
  })
  const receipt = JSON.parse(result)
  NodeAssert.equal(receipt.ok, true, 'Helium product journey failed')
  await json(directory + '/verdict.json', {
    feature: 'monitoring', verdict: 'proved', head: state.head, dirty: state.dirty,
    diffHash: state.diffHash, host: state.hostname, model: state.model,
    scope: 'Real web sign-in and Settings render against the monitored disposable server',
    receipt: receipt.value,
    limits: ['Native mobile performance/error capture and email delivery require separate receipts.'],
  })
}

if (process.argv[3] === 'browser')
  await browserMonitoring(JSON.parse(await NodeFSP.readFile(process.argv[2], 'utf8')))
