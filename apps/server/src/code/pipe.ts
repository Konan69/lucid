import type * as NodeStream from 'node:stream'
import * as NodeBuffer from 'node:buffer'
import * as Effect from 'effect/Effect'
import { boundedNesting, budgets } from './budgets.ts'
import { PipeFailure } from './protocol.ts'

/** One frame is read at a time. The length is checked before allocating its body or parsing JSON. */
export class FrameReader {
  private readonly header = Buffer.alloc(5)
  private head = 0
  private body = Buffer.alloc(0)
  private used = 0
  private size = 0

  private readonly input: NodeStream.Readable

  /** Keep the stream receiver explicit; the executable uses Node's erasable TypeScript subset. */
  constructor(input: NodeStream.Readable) {
    this.input = input
  }

  /** Header validation precedes allocation, including the final value, log allowance and frame envelope.
   * The parent reserves receipts and clips logs only after decoding the worker's final frame. */
  private allocate(limit: number) {
    this.size = this.header.readUInt32BE(1)
    const kind = this.header[0]
    const maximum = kind === 2 ? Math.min(limit, budgets.result + budgets.logs + 1_024) : limit
    if (kind === undefined || kind > 2 || this.size === 0 || this.size > maximum) return false
    this.body = Buffer.alloc(this.size)
    return true
  }

  /** A paused readable supplies backpressure while the parent is busy checking an inner call. */
  readonly read = Effect.fn('Code.readFrame')((limit: number = budgets.wire) =>
    Effect.callback<string, PipeFailure>((resume) => {
      /** Completion must remove listeners too; Effect callback cleanup runs only on interruption. */
      const complete = (effect: Effect.Effect<string, PipeFailure>) => {
        cleanup()
        resume(effect)
      }
      /** Node stream reads are an unknown ingress; only binary chunks enter our bounded buffer. */
      const drain = () => {
        while (true) {
          const needed = this.head < 5 ? 5 - this.head : this.size - this.used
          const chunk: unknown = this.input.read(Math.min(needed, 65_536))
          if (chunk === null) return exhausted()
          if (!Buffer.isBuffer(chunk)) {
            complete(Effect.fail(new PipeFailure({ reason: 'invalid' })))
            return
          }
          if (this.head < 5) {
            chunk.copy(this.header, this.head)
            this.head += chunk.length
            if (this.head < 5) continue
            if (!this.allocate(limit)) {
              complete(Effect.fail(new PipeFailure({ reason: 'size' })))
              return
            }
          } else {
            chunk.copy(this.body, this.used)
            this.used += chunk.length
            if (this.used < this.size) continue
            if (!NodeBuffer.isUtf8(this.body)) {
              complete(Effect.fail(new PipeFailure({ reason: 'invalid' })))
              return
            }
            const text = this.body.toString('utf8')
            this.head = 0
            this.used = 0
            this.size = 0
            this.body = Buffer.alloc(0)
            complete(
              boundedNesting(text)
                ? Effect.succeed(text)
                : Effect.fail(new PipeFailure({ reason: 'size' })),
            )
            return
          }
        }
      }
      // End can precede read() and a truncated stream can close without an end event.
      const exhausted = () => {
        if (this.input.readableEnded || this.input.destroyed) closed()
      }
      const closed = () => complete(Effect.fail(new PipeFailure({ reason: 'closed' })))
      const cleanup = () => {
        this.input.off('readable', drain)
        this.input.off('end', closed)
        this.input.off('error', closed)
        this.input.off('close', closed)
      }
      this.input.on('readable', drain)
      this.input.on('end', closed)
      this.input.on('error', closed)
      this.input.on('close', closed)
      drain()
      return Effect.sync(cleanup)
    }),
  )
}

/** Writes await the stream callback, bounding queued frames; stdout is exclusively this protocol. */
export const writeFrame = Effect.fn('Code.writeFrame')(function* (
  output: NodeStream.Writable,
  text: string,
  kind: 'request' | 'call' | 'result',
) {
  const body = Buffer.from(text)
  if (body.length > budgets.wire || !boundedNesting(text))
    return yield* Effect.fail(new PipeFailure({ reason: 'size' }))
  const header = Buffer.alloc(5)
  const kinds = { request: 0, call: 1, result: 2 }
  header[0] = kinds[kind]
  header.writeUInt32BE(body.length, 1)
  return yield* Effect.callback<void, PipeFailure>((resume) => {
    const failed = () => resume(Effect.fail(new PipeFailure({ reason: 'closed' })))
    output.once('error', failed)
    output.write(Buffer.concat([header, body]), (error) => {
      output.off('error', failed)
      resume(
        error === null || error === undefined
          ? Effect.void
          : Effect.fail(new PipeFailure({ reason: 'closed' })),
      )
    })
    return Effect.sync(() => output.off('error', failed))
  })
})
