import * as NodeChildProcess from 'node:child_process'
import * as NodeEvents from 'node:events'
import * as NodeNet from 'node:net'
import * as NodePath from 'node:path'
import * as NodeURL from 'node:url'
import { Effect, Option, Schema } from 'effect'

const decodeAddress = Schema.decodeUnknownOption(Schema.Struct({ port: Schema.Int }))
const isCode = Schema.is(Schema.Int)

/** Stop a process still running, by its own handle, and wait until it has ended. */
const stop = (spawned: NodeChildProcess.ChildProcess) => {
  if (spawned.exitCode !== null || spawned.signalCode !== null) return Promise.resolve()
  const ended = NodeEvents.EventEmitter.once(spawned, 'exit')
  spawned.kill('SIGTERM')
  return ended.then(() => {})
}

const packageRoot = NodeURL.fileURLToPath(new URL('../', import.meta.url))

/** The runtime process ended before it said it was listening. */
export class ChildEnded extends Schema.TaggedError<ChildEnded>()(
  'ChildEnded',
  { output: Schema.String },
  { title: 'Runtime process ended before it listened' },
) {}

/** A loopback port nothing listens on right now, for the process to bind. */
const freePort = Effect.promise(() => {
  const server = NodeNet.createServer()
  server.listen(0, '127.0.0.1')
  return NodeEvents.EventEmitter.once(server, 'listening').then(() => {
    const port = Option.match(decodeAddress(server.address()), {
      onNone: () => 0,
      onSome: (address) => address.port,
    })
    return NodeEvents.EventEmitter.once(server.close(), 'close').then(() => port)
  })
})

/**
 * The production runtime as its own operating-system process (`pnpm start` runs the same
 * `tsx src/main.ts`), on the given database, for the life of the scope. It is started with only
 * the settings it needs; no model key, because these cases never ask it for a reply.
 *
 * `listening` settles when the process logs the address it bound (`main.ts`,
 * `HttpServer.withLogAddress`), which is after it took the runtime's authority and recovered the
 * stores with work. `exit` settles with its exit code. Release stops a process still running with
 * SIGTERM, by the handle this spawn returned, and waits for it to end.
 */
export const runtimeProcess = Effect.fn('RuntimeChild.start')(function* (input: {
  readonly database: string
  readonly notes: string
}) {
  const port = yield* freePort
  const output: Array<string> = []
  const child = yield* Effect.acquireRelease(
    Effect.sync(() =>
      NodeChildProcess.spawn(NodePath.join(packageRoot, 'node_modules/.bin/tsx'), ['src/main.ts'], {
        cwd: packageRoot,
        env: {
          PATH: process.env.PATH,
          DATABASE_URL: input.database,
          VIVID_MEMORY_DIR: input.notes,
          VIVID_RUNTIME_TOKEN: 'child-runtime-token',
          VIVID_SERVER_URL: 'http://server.invalid',
          HOST: '127.0.0.1',
          PORT: String(port),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    ),
    (spawned) => Effect.promise(() => stop(spawned)),
  )
  const exit = NodeEvents.EventEmitter.once(child, 'exit').then(([code]) =>
    isCode(code) ? code : -1,
  )
  // The address line is the process's own signal that it took authority and serves.
  const signals = new NodeEvents.EventEmitter()
  const announced = Promise.race([
    exit.then(() => false),
    NodeEvents.EventEmitter.once(signals, 'listening').then(() => true),
  ])
  child.stdout.on('data', (chunk: Buffer) => {
    output.push(chunk.toString())
    if (output.join('').includes('Listening on')) signals.emit('listening')
  })
  child.stderr.on('data', (chunk: Buffer) => output.push(chunk.toString()))
  return {
    pid: child.pid,
    /** Waits until the process listens; fails if it ends first. */
    listening: Effect.promise(() => announced).pipe(
      Effect.flatMap((ok) =>
        ok ? Effect.void : Effect.fail(new ChildEnded({ output: output.join('') })),
      ),
    ),
    /** The exit code, once the process has ended. */
    exit: Effect.promise(() => exit),
    output: () => output.join(''),
  }
})
