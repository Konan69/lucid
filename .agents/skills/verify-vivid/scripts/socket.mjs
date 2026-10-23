import * as NodeNet from 'node:net'
import * as NodeEvents from 'node:events'
import * as NodeFSP from 'node:fs/promises'
/** Private local control owns fixture signals only; Person actions always use the public gateway/RPC. */
export async function control(state, input) {
  // Unix sockaddr paths have a 108-byte limit; /proc/self/fd keeps the same owned socket file
  // usable in arbitrarily long worktree names without changing its evidence/scratch layout.
  const directory = await NodeFSP.open(state.scratch, 'r')
  const socket = NodeNet.connect('/proc/self/fd/' + directory.fd + '/c.sock')
  // A missing tool receipt fails the feature; elapsed time never implies the held Run is ready.
  // Teardown can queue behind another heavy job, just like launch. Tool/capture receipts stay
  // bounded separately; elapsed queue time grants no resource-readiness or cleanup verdict.
  const deadline = input.action === 'cleanup' ? 2_700_000 : 90_000
  socket.setTimeout(deadline, () => socket.destroy(new Error('Fixture signal deadline expired')))
  try {
    await NodeEvents.once(socket, 'connect')
  } finally {
    await directory.close()
  }
  socket.write(JSON.stringify(input) + '\n')
  let text = ''
  for await (const bytes of socket) text += bytes
  const value = JSON.parse(text)
  if (!value.ok) throw new Error(value.error)
  return value.result
}
