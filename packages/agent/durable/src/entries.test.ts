import * as NodeChildProcess from 'node:child_process'
import * as NodeEvents from 'node:events'
import { expect, it } from '@effect/vitest'
import { Effect } from 'effect'

/** Workspace exports target source TypeScript. Prove all four entries load in a
 * plain Node process, without a transpiling loader or transform-types flags. */
it.live('loads every source entry with plain Node', () =>
  Effect.gen(function* () {
    const entries = ['./main.ts', './core.ts', './client.ts', './postgres/main.ts'].map(
      (path) => new URL(path, import.meta.url).href,
    )
    const code = `Promise.all(${JSON.stringify(entries)}.map(path => import(path))).then(modules => {
    if (modules.some(module => Object.keys(module).length === 0)) throw new Error('Empty entry')
    console.log('All four entries loaded')
  })`
    const child = NodeChildProcess.spawn(process.execPath, ['-e', code], { stdio: 'pipe' })
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      }),
    )
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (text: string) => {
      stdout += text
    })
    child.stderr.setEncoding('utf8').on('data', (text: string) => {
      stderr += text
    })
    const [exitCode, signal] = yield* Effect.promise(() =>
      NodeEvents.EventEmitter.once(child, 'exit'),
    )
    expect({ exitCode, signal, stderr }).toMatchObject({ exitCode: 0, signal: null })
    expect(stdout).toContain('All four entries loaded')
  }),
)
