import * as NodeFS from 'node:fs'
import * as NodeFSP from 'node:fs/promises'

import { Effect, Schema } from 'effect'

/** Bootstrap failures cannot expose the private screen credential. */
class BootstrapFailed extends Schema.TaggedError()(
  'BootstrapFailed',
  {},
  { title: 'Computer bootstrap failed' },
) {}

/** Subscribe before checking each path, using nonrecursive watchers that cannot retain descendant handles. */
const waitForPath = Effect.fn('Computer.network.path')(function* (directory, path, kind) {
  yield* Effect.callback((resume) => {
    const watcher = NodeFS.watch(directory, check)
    watcher.on('error', () => {
      watcher.close()
      resume(Effect.fail(new BootstrapFailed()))
    })
    /** Missing paths await a filesystem event; existing paths must have the required filesystem type. */
    function check() {
      NodeFSP.stat(path).then(
        (stat) => {
          watcher.close()
          const valid = kind === 'directory' ? stat.isDirectory() : stat.isFIFO()
          resume(valid ? Effect.void : Effect.fail(new BootstrapFailed()))
        },
        (error) => {
          if (error.code !== 'ENOENT') {
            watcher.close()
            resume(Effect.fail(new BootstrapFailed()))
          }
        },
      )
    }
    check()
    return Effect.sync(() => watcher.close())
  })
})

/** The entrypoint creates the directory before the FIFO; watching each parent closes both creation races. */
const waitForNetwork = Effect.fn('Computer.network.ready')(function* () {
  yield* waitForPath('/tmp', '/tmp/vivid', 'directory')
  yield* waitForPath('/tmp/vivid', '/tmp/vivid/network', 'fifo')
})

/** stdin is the only private payload ingress; it cannot appear in process or Docker exec arguments. */
async function readAuthorization() {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  return Buffer.concat(chunks).toString('ascii')
}

/** Credentials are stored only on tmpfs before the desktop's network-ready signal; FIFO writes never create files. */
export const bootstrap = Effect.fn('Computer.network.bootstrap')(function* () {
  const authorization = yield* Effect.tryPromise({
    try: readAuthorization,
    catch: () => new BootstrapFailed(),
  })
  if (!/^Bearer [a-f0-9]{64}$/.test(authorization)) yield* Effect.fail(new BootstrapFailed())
  yield* waitForNetwork()
  yield* Effect.tryPromise({
    try: async () => {
      await NodeFSP.writeFile('/tmp/vivid/authorization', authorization, {
        mode: 0o600,
        flag: 'wx',
      })
      // O_WRONLY without O_CREAT forbids replacing a missing FIFO with a regular file.
      const fifo = await NodeFSP.open('/tmp/vivid/network', NodeFS.constants.O_WRONLY)
      await fifo.write('ready')
      await fifo.close()
    },
    catch: () => new BootstrapFailed(),
  })
})
