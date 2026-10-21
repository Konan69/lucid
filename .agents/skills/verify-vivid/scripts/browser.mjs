import * as NodeFSP from 'node:fs/promises'
import * as NodeAssert from 'node:assert/strict'
import { command, json } from './process.mjs'
import { control } from './socket.mjs'
import { rpc, settled, history } from './wire.mjs'

/** Browser acquisition is journaled before open; recovery closes only this exact session. */
export async function browser(state) {
  const directory = state.evidence + '/browser'
  await NodeFSP.mkdir(directory, { recursive: true })
  const account = JSON.parse(await NodeFSP.readFile(state.scratch + '/account.json', 'utf8'))
  const executable = process.env.VIVID_VERIFY_BROWSER ?? 'agent-browser'
  const namespace = 'v-' + state.run.slice(-8)
  const socketDirectory = '/tmp/vivid-verify-' + state.run.slice(-8)
  const profile = state.scratch + '/browser-profile'
  const chrome = process.env.VIVID_VERIFY_CHROME ?? '/opt/google/chrome/chrome'
  const receipt = {
    executable,
    namespace,
    session: 'v',
    scratch: state.scratch,
    socketDirectory,
    profile,
    chrome,
  }
  await json(state.scratch + '/browser.json', receipt)
  await NodeFSP.mkdir(socketDirectory, { mode: 0o700 })
  let sequence = 0
  const run = (args) =>
    command(
      [
        executable,
        '--namespace',
        namespace,
        '--session',
        'v',
        '--profile',
        profile,
        '--executable-path',
        chrome,
        ...args,
      ],
      {
        env: {
          PATH: process.env.PATH,
          HOME: state.scratch,
          AGENT_BROWSER_SOCKET_DIR: socketDirectory,
          AGENT_BROWSER_DEFAULT_TIMEOUT: '120000',
        },
        log: directory + '/' + String(++sequence).padStart(2, '0') + '-' + args[0] + '.json',
        redactions: [account.password],
        record: (process) => control(state, { action: 'capture', process }),
      },
    )
  const capture = async (name) => {
    await NodeFSP.writeFile(directory + '/' + name + '.aria.txt', await run(['snapshot']))
    await run(['screenshot', directory + '/' + name + '.png', '--full'])
  }
  let verdict
  try {
    const id = crypto.randomUUID()
    await rpc(state, 'CreateThread', { id, title: 'Verify browser', projectId: null }, directory)
    await json(directory + '/context.json', { thread: id, head: state.head })
    await run(['open', state.web + '/t/' + id])
    await run(['wait', 'input[type=email]'])
    const welcome = await run(['snapshot', '-i'])
    await NodeFSP.writeFile(directory + '/welcome.aria.txt', welcome)
    if (welcome.includes('I already have an account'))
      await run(['find', 'text', 'I already have an account', 'click', '--exact'])
    await run(['find', 'label', 'Email', 'fill', account.email])
    await run(['find', 'label', 'Password', 'fill', account.password])
    await run(['find', 'role', 'button', 'click', '--name', 'Sign in', '--exact'])
    await run(['wait', '[aria-label="Message Vivid"]'])
    for (const [index, feature, phrase, expected] of [
      [1, 'first', 'Hello Vivid browser', 'Try one of these phrases:'],
      [2, 'tool', 'show a table', 'Rehearsal workload'],
      [3, 'document', 'write a document', 'Rehearsal plan'],
    ]) {
      await capture(feature + '-before')
      await run(['find', 'label', 'Message Vivid', 'fill', phrase])
      await run(['find', 'role', 'button', 'click', '--name', 'Send', '--exact'])
      await run(['wait', '--text', expected])
      await settled(state, id, index, 'Completed', directory)
      await capture(feature + '-after')
      await run(['reload'])
      await run(['wait', '--text', expected])
      await run(['wait', '[aria-label="Message Vivid"]'])
      await capture(feature + '-reloaded')
      const page = await history(state, id, directory, feature + '-history')
      NodeAssert.ok(JSON.stringify(page).includes(phrase))
      await json(directory + '/' + feature + '-verdict.json', {
        verdict: 'proved',
        head: state.head,
        thread: id,
        phrase,
        expected,
      })
    }
    const artifacts = await rpc(state, 'ListArtifacts', { threadId: id }, directory)
    NodeAssert.equal(artifacts.artifacts.length, 1)
    NodeAssert.equal(artifacts.artifacts[0].title, 'Rehearsal plan')
    verdict = {
      verdict: 'proved',
      features: ['first', 'tool', 'document'],
      head: state.head,
      thread: id,
    }
  } catch (error) {
    await run(['errors']).catch(() => {})
    await run(['console']).catch(() => {})
    await capture('failure').catch(() => {})
    verdict = { verdict: 'failed', head: state.head, error: error.stack }
    process.exitCode = 1
  } finally {
    try {
      await run(['close'])
      await NodeFSP.rm(socketDirectory, { recursive: true, force: true })
      await NodeFSP.unlink(state.scratch + '/browser.json')
    } catch (error) {
      verdict = { verdict: 'failed', head: state.head, error: error.stack }
      process.exitCode = 1
    }
    await json(directory + '/verdict.json', verdict)
  }
  console.log(JSON.stringify(verdict))
}
if (process.argv[1] === new URL(import.meta.url).pathname)
  await browser(JSON.parse(await NodeFSP.readFile(process.argv[2], 'utf8')))
