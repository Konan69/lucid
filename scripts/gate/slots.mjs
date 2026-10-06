import * as NodeFS from 'node:fs'
import * as NodeOS from 'node:os'
import * as NodePath from 'node:path'
import * as NodeTimersPromises from 'node:timers/promises'

/**
 * How many gates may do work at once on this machine, across every checkout: one per four
 * cores, at least one. Nothing holds a slot for long (a gate with nothing changed is seconds),
 * and gates never share state, so this is only about processor time. Without it, every thread's
 * gate started at once: on 6 Oct 2026 the eight-core Cloudbox stood at load 25 and tests that
 * start a cold process timed out in code nobody had touched.
 */
export function slotCount(cores) {
  return Math.max(1, Math.floor(cores / 4))
}

/** Signal 0 delivers nothing; it only asks whether the process exists. */
export function processAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * Take a lock file exclusively, writing this process's id into it. A lock whose owner no longer
 * exists (a killed gate) is taken over. Returns the release, or nothing when a live gate has it.
 */
export function takeLock(file) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      NodeFS.writeFileSync(file, String(process.pid), { flag: 'wx' })
      return () => NodeFS.rmSync(file, { force: true })
    } catch {
      if (!NodeFS.existsSync(file)) continue
      if (processAlive(Number(NodeFS.readFileSync(file, 'utf8')))) return undefined
      NodeFS.rmSync(file, { force: true })
    }
  }
  return undefined
}

/**
 * Wait for one of the machine's slots and hold it. The slot files live in the system's temporary
 * directory, which every checkout on the machine shares and a restart clears.
 */
export async function holdSlot(announce) {
  const directory = NodePath.join(NodeOS.tmpdir(), 'vivid-gate-slots')
  NodeFS.mkdirSync(directory, { recursive: true })
  const slots = Array.from({ length: slotCount(NodeOS.availableParallelism()) }, (_, index) =>
    NodePath.join(directory, `slot-${index}`),
  )
  let announced = false
  for (;;) {
    for (const slot of slots) {
      const release = takeLock(slot)
      if (release !== undefined) return release
    }
    if (!announced) announce(`waiting: ${slots.length} gates are already running on this machine`)
    announced = true
    await NodeTimersPromises.setTimeout(500)
  }
}
