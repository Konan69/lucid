import * as NodeFSP from 'node:fs/promises'
import { alive, json } from './process.mjs'
import { stopCaptured } from './recovery.mjs'

/** Native processes are captured at spawn; interrupted drives use the same retained receipt. */
export async function desktopCleanup(state) {
  const file = state.scratch + '/desktop.json'
  const text = await NodeFSP.readFile(file, 'utf8').catch((error) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (text === null) return
  const receipt = JSON.parse(text)
  if (receipt.scratch !== state.scratch) throw new Error('Desktop ownership mismatch')
  const external = await NodeFSP.readFile(state.scratch + '/desktop-external.json', 'utf8').catch(
    (error) => {
      if (error.code === 'ENOENT') return null
      throw error
    },
  )
  const processes = [...receipt.processes]
  if (external) processes.push(JSON.parse(external).process)
  const stopped = []
  for (const owned of processes.toReversed()) stopped.push(await stopCaptured(owned, true))
  for (const owned of processes)
    if (await alive(owned)) throw new Error('Desktop process survived cleanup')
  await json(state.evidence + '/desktop/cleanup.json', { stopped })
  await NodeFSP.rm(state.scratch + '/desktop.json')
}
