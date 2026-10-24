import * as NodeChildProcess from 'node:child_process'
import * as NodeProcess from 'node:process'
import { expect, it } from '@effect/vitest'
import { Effect } from 'effect'

/** Vite supplies CommonJS namespace interop that the production tsx ESM loader does not.
 * Exercise the public address policy under the server's actual loader, including private refusals. */
it.effect('loads the public destination policy under Node ESM without Vite interop', () =>
  Effect.gen(function* () {
    const module = new URL('./address.ts', import.meta.url).href
    const source = `const { publicAddress } = await import(${JSON.stringify(module)});
      for (const address of ['93.184.215.14', '2606:4700:4700::1111', '127.0.0.1', '::1', '10.0.0.1'])
        console.log(publicAddress(address));`
    const output = yield* Effect.callback<string>((resume) => {
      const child = NodeChildProcess.spawn(
        NodeProcess.execPath,
        ['--import', import.meta.resolve('tsx'), '--input-type=module', '-e', source],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      )
      let childOutput = ''
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => {
        childOutput += chunk
      })
      child.on('error', () => resume(Effect.die('Could not start the server loader')))
      child.on('close', (code) =>
        resume(
          code === 0
            ? Effect.succeed(childOutput)
            : Effect.die('The public address policy failed under the server loader'),
        ),
      )
      return Effect.sync(() => child.kill())
    })
    expect(output.trim().split('\n')).toEqual(['true', 'true', 'false', 'false', 'false'])
  }),
)
