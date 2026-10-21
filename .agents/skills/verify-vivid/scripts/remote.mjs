import * as NodeFSP from 'node:fs/promises'

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
    browser.socketDirectory !== '/tmp/vivid-verify-' + state.run.slice(-8)
  )
    throw new Error('Browser ownership mismatch')
  await execute(
    [browser.executable, '--namespace', browser.namespace, '--session', browser.session, 'close'],
    {
      env: {
        PATH: process.env.PATH,
        HOME: state.scratch,
        AGENT_BROWSER_SOCKET_DIR: browser.socketDirectory,
      },
      log: state.evidence + '/browser-cleanup.json',
    },
  )
  await NodeFSP.rm(browser.socketDirectory, { recursive: true, force: true })
  await NodeFSP.unlink(state.scratch + '/browser.json')
}
export const sshEnvironment = { PATH: process.env.PATH }
