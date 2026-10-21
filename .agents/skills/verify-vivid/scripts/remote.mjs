import * as NodeFSP from 'node:fs/promises'
import { alive, json } from './process.mjs'

/** The retained acquisition receipt authorizes only this run's local browser session. */
export async function remoteCleanup(state, execute) {
  const receipt = await NodeFSP.readFile(state.scratch + '/browser.json', 'utf8').catch((error) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (receipt === null) return
  const browser = JSON.parse(receipt)
  if (
    browser.scratch !== state.scratch ||
    browser.namespace !== 'v-' + state.run.slice(-8) ||
    browser.session !== 'v' ||
    browser.profile !== state.scratch + '/browser-profile' ||
    browser.socketDirectory !== '/tmp/vivid-verify-' + state.run.slice(-8)
  )
    throw new Error('Browser ownership mismatch')
  let closeError
  try {
    await execute(
      [
        browser.executable,
        '--namespace',
        browser.namespace,
        '--session',
        browser.session,
        '--profile',
        browser.profile,
        '--executable-path',
        browser.chrome,
        'close',
      ],
      {
        env: {
          PATH: process.env.PATH,
          HOME: state.scratch,
          AGENT_BROWSER_SOCKET_DIR: browser.socketDirectory,
        },
        log: state.evidence + '/browser-cleanup.json',
      },
    )
  } catch (error) {
    closeError = error
  }
  const { stopCaptured } = await import('./recovery.mjs')
  const receipts = []
  for (const process of [...(browser.processes ?? [])].reverse())
    receipts.push(await stopCaptured(process))
  for (const process of browser.processes ?? [])
    if (await alive(process)) throw new Error('Owned browser process survived cleanup')
  if (closeError && !browser.processes?.length) throw closeError
  await json(state.evidence + '/browser-process-cleanup.json', {
    receipts,
    closeError: closeError?.message,
  })
  await NodeFSP.rm(browser.socketDirectory, { recursive: true, force: true })
  await NodeFSP.unlink(state.scratch + '/browser.json')
}
export const sshEnvironment = { PATH: process.env.PATH }
