import * as NodeChildProcess from 'node:child_process'
import * as NodeFSP from 'node:fs/promises'
import * as NodeOS from 'node:os'
import * as NodePath from 'node:path'
import * as NodeProcess from 'node:process'
import { describe, expect, it } from '@effect/vitest'
import { Effect } from 'effect'
import { signInCommand } from './guest.ts'

/** This proof owns a fresh headless Chrome profile on the build machine. It never reaches a
 * Boat API, a Person's Computer, an installed user profile or a window on the developer's PC. */
const enabled = NodeProcess.env.VIVID_LIVE_SIGNIN_BROWSER === '1'

/** Capture process descriptors before signalling so Chrome's adopted helpers cannot keep writing
 * the profile after its main process exits. pidfd readiness joins every captured process. */
const stopChrome = String.raw`
import os, pathlib, select, signal, sys
root = int(sys.argv[1])
parents = {}
for entry in pathlib.Path('/proc').iterdir():
 if not entry.name.isdigit(): continue
 try: stat = (entry/'stat').read_text()
 except FileNotFoundError: continue
 parents[int(entry.name)] = int(stat[stat.rfind(')')+2:].split()[1])
owned = [root]
for parent in owned:
 owned.extend(pid for pid, ancestor in parents.items() if ancestor == parent)
descriptors = []
for pid in owned:
 try: descriptors.append(os.pidfd_open(pid))
 except ProcessLookupError: pass
for descriptor in descriptors:
 try: signal.pidfd_send_signal(descriptor, signal.SIGKILL)
 except ProcessLookupError: pass
while descriptors:
 ready, _, _ = select.select(descriptors, [], [])
 for descriptor in ready:
  os.close(descriptor); descriptors.remove(descriptor)
`

/** The process's own DevTools receipt is readiness. Cleanup kills only the child this proof
 * started and joins its exit before removing the profile. No browser-name matching or polling. */
const chrome = Effect.fn('SignInProof.chrome')(function* (directory: string) {
  const child = yield* Effect.acquireRelease(
    Effect.sync(() =>
      NodeChildProcess.spawn(
        '/usr/bin/google-chrome-stable',
        [
          '--headless=new',
          '--no-sandbox',
          '--no-first-run',
          '--disable-background-networking',
          '--remote-debugging-port=0',
          `--user-data-dir=${directory}`,
          'about:blank',
        ],
        { stdio: ['ignore', 'ignore', 'pipe'] },
      ),
    ),
    (owned) =>
      Effect.gen(function* () {
        if (owned.pid === undefined) return
        const closed = Effect.callback<void>((resume) => {
          if (owned.exitCode !== null || owned.signalCode !== null) return resume(Effect.void)
          owned.once('close', () => resume(Effect.void))
        })
        const stopped = Effect.callback<void>((resume) => {
          NodeChildProcess.execFile('python3', ['-c', stopChrome, String(owned.pid)], (failure) =>
            resume(
              failure === null ? Effect.void : Effect.die('Chrome process tree did not close.'),
            ),
          )
        })
        yield* Effect.all([closed, stopped], { concurrency: 'unbounded' })
      }),
  )
  yield* Effect.callback<void>((resume) => {
    let stderr = ''
    child.on('error', () => resume(Effect.die('The proof Chrome could not start.')))
    child.once('exit', () =>
      resume(Effect.die('The proof Chrome exited before its DevTools receipt.')),
    )
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-4096)
      if (stderr.includes('DevTools listening on ws://')) resume(Effect.void)
    })
  })
  if (child.pid === undefined) return yield* Effect.die('The proof Chrome has no PID.')
  return child.pid
})

/** Execute exactly the production SSH shell command. Input arrives over a kept-open pipe, so
 * the proof catches incorrect newline framing as well as wrong CDP domain or shell escaping. */
const inject = Effect.fn('SignInProof.inject')((pid: number) =>
  Effect.callback<string>((resume, signal) => {
    const child = NodeChildProcess.execFile(
      '/bin/sh',
      ['-c', signInCommand],
      { signal },
      (failure, stdout) =>
        resume(
          failure === null
            ? Effect.succeed(stdout)
            : Effect.die(
                `The production cookie injection command failed at stage ${failure.code}.`,
              ),
        ),
    )
    if (child.stdin === null) {
      resume(Effect.die('The injection process has no stdin.'))
      return
    }
    child.stdin.write(
      `${JSON.stringify({
        pid,
        cookies: [
          {
            name: '__Host-signin-proof',
            value: 'synthetic-proof-cookie',
            url: 'https://signin.example.test/',
            path: '/',
            secure: true,
            httpOnly: true,
            sameSite: 'Lax',
          },
          {
            name: '__Host-signin-persistent-proof',
            value: 'synthetic-persistent-cookie',
            url: 'https://signin.example.test/',
            path: '/',
            secure: true,
            httpOnly: true,
            sameSite: 'Lax',
            expires: Date.now() / 1000 + 500 * 86400,
          },
        ],
      })}\n`,
    )
  }),
)

describe.skipIf(!enabled)('cookie injection into a real isolated Chrome', () => {
  it.live(
    'sets and reads back host-only session and capped persistent cookies through the private command',
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const directory = yield* Effect.acquireRelease(
            Effect.promise(() =>
              NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), 'vivid-signin-chrome-')),
            ),
            // The browser resource closes its captured process tree before this profile scope ends.
            (owned) => Effect.promise(() => NodeFSP.rm(owned, { recursive: true, force: true })),
          )
          expect(yield* inject(yield* chrome(directory))).toBe('{"cookies":2}')
        }),
      ),
  )
})
