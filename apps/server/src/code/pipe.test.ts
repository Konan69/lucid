import * as NodeStream from 'node:stream'
import * as NodeChildProcess from 'node:child_process'
import * as NodeProcess from 'node:process'
import * as NodePath from 'node:path'
import { describe, expect, it } from '@effect/vitest'
import { Effect, Fiber } from 'effect'
import { FrameReader, writeFrame } from './pipe.ts'
import { budgets } from './budgets.ts'
import { decodeWorker, encodeParent, ParentMessage, WorkerMessage } from './protocol.ts'
import { prepareWorker } from './source.ts'

/** Real streams exercise the framing boundary before JSON or SDK callbacks can allocate data. */
describe('Program pipes', () => {
  it.effect(
    'rejects a declared oversized frame before receiving its body and bounds final frames separately',
    () =>
      Effect.gen(function* () {
        for (const [kind, size] of [
          [1, budgets.wire + 1],
          [2, budgets.result + budgets.logs + 1_024 + 1],
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
    'refuses reads after EOF and truncated pipe destruction instead of waiting forever',
    () =>
      Effect.gen(function* () {
        const ended = new NodeStream.PassThrough()
        const eof = Effect.callback<void>((resume) => {
          ended.once('end', () => resume(Effect.void))
          ended.resume()
          ended.end()
        })
        yield* eof
        expect((yield* new FrameReader(ended).read().pipe(Effect.flip)).reason).toBe('closed')
        const truncated = new NodeStream.PassThrough()
        truncated.write(Buffer.from([1, 0, 0, 0, 10, 123]))
        const read = new FrameReader(truncated).read()
        const waiting = yield* Effect.forkChild(read, { startImmediately: true })
        truncated.destroy()
        expect((yield* Fiber.join(waiting).pipe(Effect.flip)).reason).toBe('closed')
      }),
  )

  it.effect(
    'pipe EOF after a callback exits the real worker and cancels the guest without replying',
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const directory = yield* prepareWorker()
          const child = yield* Effect.acquireRelease(
            Effect.sync(() =>
              NodeChildProcess.spawn(
                NodeProcess.execPath,
                ['--wasm-num-compilation-tasks=1', NodePath.join(directory, 'start.mjs')],
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
