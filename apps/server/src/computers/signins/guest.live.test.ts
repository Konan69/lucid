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
      Effect.callback<void>((resume) => {
        if (owned.exitCode !== null || owned.signalCode !== null) {
          resume(Effect.void)
          return
        }
        owned.once('exit', () => resume(Effect.void))
        owned.kill('SIGTERM')
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
      { signal, timeout: 30_000 },
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
        ],
      })}\n`,
    )
  }),
)

describe.skipIf(!enabled)('cookie injection into a real isolated Chrome', () => {
  it.live(
    'sets and reads back a host-only sign-in cookie through the production private command',
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const directory = yield* Effect.acquireRelease(
            Effect.promise(() =>
              NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), 'vivid-signin-chrome-')),
            ),
            (owned) => Effect.promise(() => NodeFSP.rm(owned, { recursive: true, force: true })),
          )
          expect(yield* inject(yield* chrome(directory))).toBe('{"cookies":1}')
        }),
      ),
    40_000,
  )
})
