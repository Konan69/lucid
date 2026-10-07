import * as NodeCrypto from 'node:crypto'
import * as NodeEvents from 'node:events'
import * as NodeNet from 'node:net'
import * as NodeOS from 'node:os'
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

/**
 * A lock the kernel holds: a listening socket in Linux's abstract namespace (a name starting
 * with a NUL byte, no file). Binding the name is atomic and exclusive, and the kernel frees it
 * the moment the owning process ends, however it ends. A lock file with a process id in it has
 * neither property: two gates could both take over a dead owner's file, and a reused process
 * id kept a dead lock alive. Returns the release, or nothing while another process holds it.
 * The gate runs on Linux (the Cloudbox, GitHub's runners, the developer's WSL); another system
 * has no abstract namespace and fails here with the kernel's own error.
 */
export async function takeLock(name) {
  const server = NodeNet.createServer()
  try {
    server.listen(`\0vivid-gate-${name}`)
    await NodeEvents.once(server, 'listening')
  } catch (error) {
    if (error.code === 'EADDRINUSE') return undefined
    throw error
  }
  // The lock must not keep a finished gate's process alive.
  server.unref()
  return () => server.close()
}

/** A lock name for one checkout: its path, shortened to something a socket name can hold. */
export function treeLockName(root) {
  return `tree-${NodeCrypto.createHash('sha256').update(root).digest('hex').slice(0, 24)}`
}

/** Wait for one of the machine's slots and hold it. */
export async function holdSlot(announce) {
  const slots = Array.from(
    { length: slotCount(NodeOS.availableParallelism()) },
    (_, index) => `slot-${index}`,
  )
  let announced = false
  for (;;) {
    for (const slot of slots) {
      const release = await takeLock(slot)
      if (release !== undefined) return release
    }
    if (!announced) announce(`waiting: ${slots.length} gates are already running on this machine`)
    announced = true
    await NodeTimersPromises.setTimeout(500)
  }
}
