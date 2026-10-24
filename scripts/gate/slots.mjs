import * as NodeCrypto from 'node:crypto'
import * as NodeChildProcess from 'node:child_process'
import * as NodeEvents from 'node:events'
import * as NodeNet from 'node:net'
import * as NodeOS from 'node:os'

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
  const clients = new Set()
  const server = NodeNet.createServer({ allowHalfOpen: true }, (client) => {
    clients.add(client)
    client.unref()
    client.once('close', () => clients.delete(client))
    // Half-close distinguishes a release-aware holder from the older socket-only protocol.
    client.write('1')
    client.resume()
  })
  try {
    server.listen(`\0vivid-gate-${name}`)
    await NodeEvents.once(server, 'listening')
  } catch (error) {
    if (error.code === 'EADDRINUSE') return undefined
    throw error
  }
  // The lock must not keep a finished gate's process alive.
  server.unref()
  return () => {
    for (const client of clients) client.destroy()
    server.close()
  }
}

/** A lock name for one checkout: its path, shortened to something a socket name can hold. */
export function treeLockName(root) {
  return `tree-${NodeCrypto.createHash('sha256').update(root).digest('hex').slice(0, 24)}`
}

/** New holders acknowledge the release protocol and close their peers on release.
 * Older holders close on the waiter's half-close instead. Only those need SO_PEERPIDFD,
 * Linux's atomic peer identity API, option 77 in asm-generic/socket.h since Linux 6.5.
 * Their connection is closed before waiting for exit so it cannot keep the older gate alive. */
const ownerScript = String.raw`
import errno, os, select, socket, sys
peer_pidfd = 77
peer = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
try:
    peer.connect('\0vivid-gate-' + sys.argv[1])
    peer.shutdown(socket.SHUT_WR)
    protocol = peer.recv(1)
    if protocol == b'1':
        select.select([peer], [], [])
    elif protocol == b'':
        owner = peer.getsockopt(socket.SOL_SOCKET, peer_pidfd)
        peer.close()
        select.select([owner], [], [])
        os.close(owner)
    else:
        raise RuntimeError('unrecognized gate slot owner protocol')
except OSError as error:
    if error.errno not in (errno.ECONNREFUSED, errno.ECONNRESET, errno.ESRCH):
        raise
finally:
    peer.close()
`

/** Subscribe before retrying the bind. A missing or exited owner wakes the contender
 * immediately; a living holder is watched by pidfd without relying on a recyclable PID. */
function observeRelease(name) {
  const owner = NodeChildProcess.spawn('python3', ['-c', ownerScript, name])
  const released = NodeEvents.once(owner, 'close').then(([code, signal]) => {
    if (code !== 0 && signal === null) throw new Error('could not observe the gate slot owner')
  })
  return { released, close: () => owner.kill() }
}

/** Atomic bind remains the acquisition authority; observations only wake contenders. */
async function availableSlot(slots) {
  for (const slot of slots) {
    const release = await takeLock(slot)
    if (release !== undefined) return release
  }
  return undefined
}

/** Wait for one of the machine's slots and hold it. */
export async function holdSlot(announce) {
  const slots = Array.from(
    { length: slotCount(NodeOS.availableParallelism()) },
    (_, index) => `slot-${index}`,
  )
  let announced = false
  for (;;) {
    const observers = slots.map(observeRelease)
    try {
      const release = await availableSlot(slots)
      if (release !== undefined) return release
      if (!announced) announce(`waiting: ${slots.length} gates are already running on this machine`)
      announced = true
      await Promise.race(observers.map((observer) => observer.released))
    } finally {
      for (const observer of observers) observer.close()
    }
  }
}
