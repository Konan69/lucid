import * as NodeFS from 'node:fs'
import * as NodePath from 'node:path'
import { expect, it } from '@effect/vitest'
import { Effect, Fiber } from 'effect'
import { FILE_BYTES, OUTPUT_BYTES, openLink } from './link.ts'
import { peer, peerAvailable } from './peer.ts'

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes)
const bytes = (value: string) => new TextEncoder().encode(value)

/** One server and one connection for a test, as the adapter holds one per awake machine. */
const connected = Effect.gen(function* () {
  const server = yield* peer
  const link = yield* openLink(server)
  return { server, link }
})

it.live.skipIf(!peerAvailable)(
  'puts a file in directories that do not exist, reads it back, and a command sees it',
  () =>
    Effect.gen(function* () {
      const { server, link } = yield* connected
      const path = NodePath.join(server.home, 'notes/today/list.txt')
      yield* link.put(path, bytes('milk\nbread\n'))
      expect(NodeFS.readFileSync(path, 'utf8')).toBe('milk\nbread\n')
      expect(text(yield* link.read(path))).toBe('milk\nbread\n')
      const run = yield* link.run({
        command: 'wc -l < notes/today/list.txt; echo problem >&2; exit 3',
        directory: server.home,
        timeoutSeconds: 20,
      })
      expect(run.stdout.trim()).toBe('2')
      expect(run.stderr.trim()).toBe('problem')
      expect(run).toMatchObject({ exitCode: 3, timedOut: false, truncated: false })
    }).pipe(Effect.scoped),
  30_000,
)

it.live.skipIf(!peerAvailable)(
  'carries bytes that are not text unchanged in both directions',
  () =>
    Effect.gen(function* () {
      const { server, link } = yield* connected
      const picture = Uint8Array.from({ length: 70_000 }, (_, index) => (index * 7) % 256)
      const path = NodePath.join(server.home, 'picture.bin')
      yield* link.put(path, picture)
      expect(Buffer.from(yield* link.read(path)).equals(Buffer.from(picture))).toBe(true)
    }).pipe(Effect.scoped),
  30_000,
)

it.live.skipIf(!peerAvailable)(
  'says why a file could not be read: missing, a directory, or too large',
  () =>
    Effect.gen(function* () {
      const { server, link } = yield* connected
      const missing = yield* Effect.flip(link.read(NodePath.join(server.home, 'absent.txt')))
      expect(missing).toMatchObject({ _tag: 'LinkFileRefused', reason: 'missing' })
      const directory = yield* Effect.flip(link.read(server.home))
      expect(directory).toMatchObject({ _tag: 'LinkFileRefused', reason: 'directory' })
      const large = NodePath.join(server.home, 'large.bin')
      NodeFS.writeFileSync(large, Buffer.alloc(FILE_BYTES + 1))
      expect(yield* Effect.flip(link.read(large))).toMatchObject({ reason: 'large' })
    }).pipe(Effect.scoped),
  30_000,
)

/** Asks the machine itself until the process is gone; the loop is the machine's, not the test's. */
const gone = (pid: string) => `while kill -0 ${pid} 2>/dev/null; do :; done; echo gone`

it.live.skipIf(!peerAvailable)(
  'ends a command and its children at the deadline',
  () =>
    Effect.gen(function* () {
      const { server, link } = yield* connected
      const run = yield* link.run({
        command: 'echo started; sleep 300 & echo $! > pid; wait',
        directory: server.home,
        timeoutSeconds: 1,
      })
      expect(run).toMatchObject({ exitCode: null, timedOut: true })
      expect(run.stdout.trim()).toBe('started')
      const pid = NodeFS.readFileSync(NodePath.join(server.home, 'pid'), 'utf8').trim()
      const after = yield* link.run({ command: gone(pid), directory: server.home, timeoutSeconds: 20 })
      expect(after.stdout.trim()).toBe('gone')
    }).pipe(Effect.scoped),
  40_000,
)

it.live.skipIf(!peerAvailable)(
  'ends a command on the machine when the caller stops waiting for it',
  () =>
    Effect.gen(function* () {
      const { server, link } = yield* connected
      const pidFile = NodePath.join(server.home, 'pid')
      const running = yield* Effect.forkChild(
        link.run({
          command: 'sleep 300 & echo $! > pid.part; mv pid.part pid; wait',
          directory: server.home,
          timeoutSeconds: 600,
        }),
      )
      // The command says it started by making the file; wait on the machine for that.
      yield* link.run({
        command: 'until [ -f pid ]; do :; done',
        directory: server.home,
        timeoutSeconds: 20,
      })
      yield* Fiber.interrupt(running)
      const pid = NodeFS.readFileSync(pidFile, 'utf8').trim()
      const after = yield* link.run({ command: gone(pid), directory: server.home, timeoutSeconds: 20 })
      expect(after.stdout.trim()).toBe('gone')
    }).pipe(Effect.scoped),
  40_000,
)

it.live.skipIf(!peerAvailable)(
  'keeps the end of an output that is larger than the limit',
  () =>
    Effect.gen(function* () {
      const { server, link } = yield* connected
      const run = yield* link.run({
        command: `head -c ${OUTPUT_BYTES * 3} /dev/zero | tr '\\0' a; echo; echo last-line`,
        directory: server.home,
        timeoutSeconds: 30,
      })
      expect(run.truncated).toBe(true)
      expect(run.stdout.length).toBeLessThanOrEqual(OUTPUT_BYTES)
      expect(run.stdout.endsWith('last-line\n')).toBe(true)
    }).pipe(Effect.scoped),
  40_000,
)

it.live.skipIf(!peerAvailable)(
  'refuses a host that does not present the expected key, before anything is sent',
  () =>
    Effect.gen(function* () {
      const server = yield* peer
      const failure = yield* Effect.flip(openLink({ ...server, hostKey: server.stranger }))
      expect(failure._tag).toBe('LinkHostMismatch')
    }).pipe(Effect.scoped),
  30_000,
)

it.live.skipIf(!peerAvailable)(
  'reports an unreachable machine when the server goes while the connection is open',
  () =>
    Effect.gen(function* () {
      const { server, link } = yield* connected
      // Ending the listener leaves the session's own process; end the whole group's sessions by
      // closing from this side is not the claim, so the peer is killed outright.
      server.child.kill('SIGKILL')
      const closed = yield* Effect.callback<boolean>((resume) => {
        server.child.once('exit', () => resume(Effect.succeed(true)))
      })
      expect(closed).toBe(true)
      const refused = yield* Effect.flip(openLink(server))
      expect(refused._tag).toBe('LinkUnreachable')
      // The open session has its own server process, which outlives the listener: it still works.
      const run = yield* link.run({ command: 'echo alive', directory: server.home, timeoutSeconds: 10 })
      expect(run.stdout.trim()).toBe('alive')
    }).pipe(Effect.scoped),
  30_000,
)
