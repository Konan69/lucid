import * as NodeStream from 'node:stream'
import * as NodeChildProcess from 'node:child_process'
import * as NodeProcess from 'node:process'
import * as NodeURL from 'node:url'
import { describe, expect, it } from '@effect/vitest'
import { Effect } from 'effect'
import { FrameReader, writeFrame } from './pipe.ts'
import { budgets } from './budgets.ts'
import { decodeWorker, encodeParent, ParentMessage, WorkerMessage } from './protocol.ts'

/** Real streams exercise the framing boundary before JSON or SDK callbacks can allocate data. */
describe('Program pipes', () => {
  it.effect(
    'rejects a declared oversized frame before receiving its body and bounds final frames separately',
    () =>
      Effect.gen(function* () {
        for (const [kind, size] of [
          [1, budgets.wire + 1],
          [2, budgets.result + 1],
        ] as const) {
          const input = new NodeStream.PassThrough()
          const header = Buffer.alloc(5)
          header[0] = kind
          header.writeUInt32BE(size, 1)
          input.write(header)
          const failure = yield* new FrameReader(input).read().pipe(Effect.flip)
          expect(failure.reason).toBe('size')
          input.destroy()
        }
      }),
  )

  it.effect(
    'rejects malformed JSON, unknown tool names, ownership fields and excessive nesting',
    () =>
      Effect.gen(function* () {
        for (const text of [
          '{',
          '{"_tag":"Call","id":1,"kind":"steal","input":{}}',
          '{"_tag":"Call","id":1,"kind":"use_tool","input":{},"personId":"another-person"}',
        ]) {
          const result = yield* Effect.result(decodeWorker(text, { onExcessProperty: 'error' }))
          expect(result._tag).toBe('Failure')
        }
        const output = new NodeStream.PassThrough()
        const failure = yield* writeFrame(
          output,
          '['.repeat(33) + '0' + ']'.repeat(33),
          'call',
        ).pipe(Effect.flip)
        expect(failure.reason).toBe('size')
        output.destroy()
      }),
  )

  it.effect('refuses malformed UTF-8 before it can silently change a tool argument', () =>
    Effect.gen(function* () {
      const input = new NodeStream.PassThrough()
      const header = Buffer.from([1, 0, 0, 0, 1])
      input.write(Buffer.concat([header, Buffer.from([0xc0])]))
      const failure = yield* new FrameReader(input).read().pipe(Effect.flip)
      expect(failure.reason).toBe('invalid')
      input.destroy()
    }),
  )

  it.effect(
    'pipe EOF after a callback exits the real worker and cancels the guest without replying',
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const child = yield* Effect.acquireRelease(
            Effect.sync(() =>
              NodeChildProcess.spawn(
                NodeProcess.execPath,
                [
                  '--import',
                  NodeURL.fileURLToPath(import.meta.resolve('tsx')),
                  NodeURL.fileURLToPath(new URL('./worker.ts', import.meta.url)),
                ],
                { stdio: ['pipe', 'pipe', 'ignore'], env: { PATH: '/usr/bin:/bin' } },
              ),
            ),
            (process) => Effect.sync(() => process.kill('SIGKILL')),
          )
          const closed = Effect.callback<number | null>((resume) => {
            child.once('close', (code) => resume(Effect.succeed(code)))
            child.once('error', () => resume(Effect.die('Worker could not start')))
          })
          yield* writeFrame(
            child.stdin,
            encodeParent(
              ParentMessage.cases.Start.make({ code: 'await tools.use_tool({}); while(true) {}' }),
            ),
            'request',
          )
          const message = yield* new FrameReader(child.stdout)
            .read()
            .pipe(Effect.flatMap((text) => decodeWorker(text)))
          expect(WorkerMessage.guards.Call(message)).toBe(true)
          child.stdin.end()
          expect(yield* closed).toBe(0)
        }),
      ),
  )
})
