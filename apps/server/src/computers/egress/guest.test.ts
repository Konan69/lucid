import { describe, expect, it } from '@effect/vitest'
import * as NodeChildProcess from 'node:child_process'
import * as NodeFS from 'node:fs'
import * as NodeNet from 'node:net'
import * as NodeOS from 'node:os'
import * as NodePath from 'node:path'
import * as NodeURL from 'node:url'
import { Deferred, Effect, Option, Schema } from 'effect'
import { startCommand } from './guest.ts'

/**
 * The command that puts the egress proxy on a Computer and starts it (`guest.ts`), run for real
 * by a real shell, in a home of its own and on ports of its own.
 */
const proxyFile = NodeURL.fileURLToPath(new URL('./proxy.mjs', import.meta.url))

/** Where a listening server is bound, as Node reports it for a TCP listener. */
const decodeBound = Schema.decodeUnknownEffect(Schema.Struct({ port: Schema.Int }))

/** Listens on a free loopback port and answers which. */
const bound = (server: NodeNet.Server) =>
  Effect.callback<void>((resume) => {
    server.listen(0, '127.0.0.1', () => resume(Effect.void))
  }).pipe(
    Effect.andThen(Effect.suspend(() => decodeBound(server.address()))),
    Effect.map((address) => address.port),
    Effect.orDie,
  )

describe('starting the proxy on a Computer', () => {
  /** A free loopback port: taken for a moment to learn its number, then given back. */
  const freePort = Effect.suspend(() => {
    const probe = NodeNet.createServer()
    return bound(probe).pipe(
      Effect.tap(() =>
        Effect.callback<void>((resume) => {
          probe.close(() => resume(Effect.void))
        }),
      ),
    )
  })
  /** Runs the start command as the Computer's shell would, in a home of its own. */
  const start = (home: string, command: string) =>
    Effect.callback<number | null>((resume) => {
      const child = NodeChildProcess.spawn('bash', ['-c', command], {
        env: { ...process.env, HOME: home },
        stdio: 'ignore',
      })
      child.on('close', (code) => resume(Effect.succeed(code)))
    })
  const recorded = (home: string) =>
    Number(
      NodeFS.readFileSync(NodePath.join(home, '.local/share/vivid/computer/egress.pid'), 'utf8'),
    )

  it.live('starts it once, leaves a running one alone, and replaces an older text', () =>
    Effect.gen(function* () {
      const home = yield* Effect.acquireRelease(
        Effect.sync(() => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), 'vivid-egress-'))),
        (directory) =>
          Effect.sync(() => {
            // The proxy this test started, by the process id it recorded itself.
            Option.map(Option.liftThrowable(() => recorded(directory))(), (pid) =>
              Option.liftThrowable(() => process.kill(pid))(),
            )
            NodeFS.rmSync(directory, { recursive: true, force: true })
          }),
      )
      const ports = { tunnel: yield* freePort, proxy: yield* freePort }
      const text = NodeFS.readFileSync(proxyFile, 'utf8')
      expect(yield* start(home, startCommand(text, ports))).toBe(0)
      const first = recorded(home)
      expect(yield* start(home, startCommand(text, ports))).toBe(0)
      expect(recorded(home)).toBe(first)
      // A server with a changed proxy ends the old one and starts its own.
      expect(yield* start(home, startCommand(`${text}\n// changed\n`, ports))).toBe(0)
      const second = recorded(home)
      expect(second).not.toBe(first)
      expect(Option.liftThrowable(() => process.kill(first, 0))()).toEqual(Option.none())
    }),
  )
  /**
   * A `cat` to put first on the start command's `PATH`, so that a test can hold a start inside
   * the moment it writes the proxy's text. When its output is a temporary file of the start
   * command's (`*.new`) it makes a pipe named for the shell that ran it, and waits there until
   * something is written to the pipe; then, and for every other use, it is the real `cat`.
   */
  const heldCat = (gates: string) =>
    [
      '#!/bin/bash',
      'case "$(readlink "/proc/$$/fd/1")" in',
      `*.new) mkfifo "${gates}/$PPID" && read -r _ < "${gates}/$PPID" ;;`,
      'esac',
      `exec ${NodeFS.existsSync('/bin/cat') ? '/bin/cat' : '/usr/bin/cat'} "$@"`,
      '',
    ].join('\n')

  /** Waits until a directory holds this many entries. The watch is the signal; nothing polls. */
  const holds = (directory: string, count: number) =>
    Effect.callback<ReadonlyArray<string>>((resume) => {
      const watcher = NodeFS.watch(directory)
      const look = () => {
        const names = NodeFS.readdirSync(directory)
        if (names.length < count) return
        watcher.close()
        resume(Effect.succeed(names))
      }
      watcher.on('change', look)
      look()
      return Effect.sync(() => watcher.close())
    })

  /** A shell's end, heard from the start: one that ends before anyone waits is still heard. */
  const heard = (child: NodeChildProcess.ChildProcess) => {
    const ended = Deferred.makeUnsafe<number | null>()
    child.on('close', (code) => Deferred.doneUnsafe(ended, Effect.succeed(code)))
    return { pid: child.pid, ended: Deferred.await(ended) }
  }

  it.live('two starts inside the write at the same moment each write their own copy', () =>
    Effect.gen(function* () {
      const home = yield* Effect.acquireRelease(
        Effect.sync(() => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), 'vivid-egress-'))),
        (directory) =>
          Effect.sync(() => {
            Option.map(Option.liftThrowable(() => recorded(directory))(), (pid) =>
              Option.liftThrowable(() => process.kill(pid))(),
            )
            NodeFS.rmSync(directory, { recursive: true, force: true })
          }),
      )
      const bin = NodePath.join(home, 'bin')
      const gates = NodePath.join(home, 'gates')
      NodeFS.mkdirSync(bin)
      NodeFS.mkdirSync(gates)
      NodeFS.writeFileSync(NodePath.join(bin, 'cat'), heldCat(gates), { mode: 0o755 })
      const ports = { tunnel: yield* freePort, proxy: yield* freePort }
      const text = NodeFS.readFileSync(proxyFile, 'utf8')
      const command = startCommand(text, ports)
      /**
       * One start, with the held `cat` first on its path: the shell's process id, and its end.
       * The shell leads a process group of its own, so that a test that fails while a start is
       * still held can end the shell and the `cat` it waits on together, by the id it was given
       * here. The proxy is not in that group: the command starts it in a session of its own.
       */
      const begin = Effect.acquireRelease(
        Effect.sync(() =>
          NodeChildProcess.spawn('bash', ['-c', command], {
            env: { ...process.env, HOME: home, PATH: `${bin}:${process.env['PATH']}` },
            stdio: 'ignore',
            detached: true,
          }),
        ),
        (child) =>
          Effect.sync(() =>
            Option.map(Option.fromUndefinedOr(child.pid), (pid) =>
              Option.liftThrowable(() => process.kill(-pid, 'SIGKILL'))(),
            ),
          ),
      ).pipe(Effect.map(heard))
      const starts = [yield* begin, yield* begin]
      // Both are inside the write now, neither has finished it: each has made its pipe.
      const waiting = yield* holds(gates, 2)
      const directory = NodePath.join(home, '.local/share/vivid/computer')
      const writing = NodeFS.readdirSync(directory).filter((name) => name.endsWith('.new'))
      // Each writes a file named for its own shell. With one shared name the first to finish
      // moved the file away from under the second, which then failed.
      expect(new Set(writing.map((name) => name.split('.').at(-2)))).toEqual(
        new Set(starts.map((start) => String(start.pid))),
      )
      expect(writing.length).toBe(2)
      for (const gate of waiting) NodeFS.writeFileSync(NodePath.join(gates, gate), '\n')
      expect(yield* Effect.forEach(starts, (start) => start.ended)).toEqual([0, 0])
      // The one that holds the ports is the one on record, and it is the whole text.
      const pid = recorded(home)
      expect(Option.liftThrowable(() => process.kill(pid, 0))()).toEqual(Option.some(true))
      const files = NodeFS.readdirSync(directory)
      expect(files.filter((name) => name.endsWith('.new'))).toEqual([])
      const file = files.find((name) => name.endsWith('.mjs'))
      expect(NodeFS.readFileSync(NodePath.join(directory, file ?? ''), 'utf8')).toBe(`${text}\n`)
    }),
  )
})
