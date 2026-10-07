import { read, ReadFailed } from './fixtures/reading.ts'
import { Option, Effect } from 'effect'
import { type ChatTransport, type UIMessage, type UIMessageChunk, uiMessageChunkSchema } from 'ai'
import { expect, it } from '@effect/vitest'
import { ConnectionLost, connectionLostInput, resumable, closeInputs } from './client.ts'

/** A transport fixture owns chunk delivery and cancellation, never Response or SDK state. */
function transport(source: ReadableStream<UIMessageChunk>): ChatTransport<UIMessage> {
  return {
    sendMessages: () => Promise.resolve(source),
    reconnectToStream: () => Promise.resolve(source),
  }
}

/** The next pull faults only after all preceding chunks have actually reached the reader. */
function broken(chunks: UIMessageChunk[], cause: Error) {
  const pending = [...chunks]
  return new ReadableStream<UIMessageChunk>(
    {
      pull(controller) {
        const next = pending.shift()
        if (next === undefined) controller.error(cause)
        else controller.enqueue(next)
      },
    },
    { highWaterMark: 0 },
  )
}

/** Close every started input before the original network error becomes a plain Error failure. */
it.live.each(['send', 'reconnect'] as const)(
  'guards %s chunks without retaining SDK state',
  (kind) =>
    Effect.gen(function* () {
      const cause = new TypeError('fetch network failed')
      const start: UIMessageChunk = { type: 'tool-input-start', toolCallId: 'a', toolName: 'pay' }
      const second: UIMessageChunk = {
        type: 'tool-input-start',
        toolCallId: 'b',
        toolName: 'ask',
        dynamic: true,
      }
      const guarded = resumable(transport(broken([start, second], cause)))
      const stream =
        kind === 'send'
          ? yield* Effect.promise(() =>
              guarded.sendMessages({
                trigger: 'submit-message',
                chatId: 'chat',
                messages: [],
                messageId: undefined,
                abortSignal: undefined,
              }),
            )
          : yield* Effect.promise(() => guarded.reconnectToStream({ chatId: 'chat' }))
      if (stream === null) throw new Error('Expected stream')
      const reader = stream.getReader()
      expect((yield* Effect.promise(() => reader.read())).value).toEqual(start)
      expect((yield* Effect.promise(() => reader.read())).value).toEqual(second)
      for (const identity of [start, second]) {
        const received = (yield* Effect.promise(() => reader.read())).value
        expect(received).toMatchObject({
          type: 'tool-input-error',
          toolCallId: identity.toolCallId,
          errorText: connectionLostInput,
        })
        const schema = uiMessageChunkSchema()
        if (schema.validate === undefined) throw new Error('Expected chunk validator')
        const validate = schema.validate.bind(schema)
        expect((yield* Effect.promise(() => Promise.resolve(validate(received)))).success).toBe(
          true,
        )
      }
      const failed = yield* Effect.promise(() => reader.read().catch((error: Error) => error))
      expect(failed).toBeInstanceOf(ConnectionLost)
      expect(failed).not.toBeInstanceOf(TypeError)
      expect(failed).toMatchObject({ name: 'ConnectionLost', cause })
    }),
)

/** Completed inputs and a reset are not failed a second time; stream ledgers belong to each reader. */
it.live('clears completed and reset inputs before a disconnect', () =>
  Effect.gen(function* () {
    const source = broken(
      [
        { type: 'tool-input-start', toolCallId: 'a', toolName: 'pay' },
        { type: 'tool-input-available', toolCallId: 'a', toolName: 'pay', input: {} },
        { type: 'tool-input-start', toolCallId: 'b', toolName: 'ask' },
        { type: 'reset-step' },
      ],
      new TypeError('network failed'),
    )
    const stream = yield* Effect.promise(() =>
      resumable(transport(source)).reconnectToStream({ chatId: 'chat' }),
    )
    if (stream === null) throw new Error('Expected stream')
    const reader = stream.getReader()
    for (let i = 0; i < 4; i += 1)
      expect((yield* Effect.promise(() => reader.read())).done).toBe(false)
    expect((yield* rejected(() => reader.read())).cause).toBeInstanceOf(ConnectionLost)
  }),
)

/** Method-level failures and reader failures preserve standard abort exception identity. */
it.live('passes aborts through at both transport boundaries', () =>
  Effect.gen(function* () {
    const cause = new DOMException('Stopped', 'AbortError')
    const before: ChatTransport<UIMessage> = {
      sendMessages: () => Promise.reject(cause),
      reconnectToStream: () => Promise.reject(cause),
    }
    expect(
      (yield* rejected(() => resumable(before).reconnectToStream({ chatId: 'chat' }))).cause,
    ).toBe(cause)
    const stream = yield* Effect.promise(() =>
      resumable(transport(broken([], cause))).reconnectToStream({ chatId: 'chat' }),
    )
    if (stream === null) throw new Error('Expected stream')
    expect((yield* rejected(() => stream.getReader().read())).cause).toBe(cause)
  }),
)

type Cancellation = { reason?: { stopped: boolean } }

/** Preserve cancellation reasons and null idle replies; pre-stream network errors are wrapped too. */
it.live('forwards cancellation and guards acquisition failures', () =>
  Effect.gen(function* () {
    const received: Cancellation = {}
    const stopped = { stopped: true }
    const source = new ReadableStream<UIMessageChunk>({
      cancel(value: { stopped: boolean }) {
        received.reason = value
      },
    })
    const stream = yield* Effect.promise(() =>
      resumable(transport(source)).reconnectToStream({ chatId: 'chat' }),
    )
    if (stream === null) throw new Error('Expected stream')
    yield* Effect.promise(() => stream.cancel(stopped))
    expect(received.reason).toBe(stopped)
    const cause = new TypeError('fetch failed')
    const before: ChatTransport<UIMessage> = {
      sendMessages: () => Promise.reject(cause),
      reconnectToStream: () => Promise.resolve(null),
    }
    expect(
      yield* Effect.promise(() => resumable(before).reconnectToStream({ chatId: 'chat' })),
    ).toBeNull()
    expect(
      (yield* rejected(() =>
        resumable(before).sendMessages({
          trigger: 'submit-message',
          chatId: 'chat',
          messages: [],
          messageId: undefined,
          abortSignal: undefined,
        }),
      )).cause,
    ).toMatchObject({ name: 'ConnectionLost', cause })
  }),
)

/** A terminal tool output ends the ledger even if an adapter omitted input-available. */
it.live.each(['tool-output-available', 'tool-output-error', 'tool-output-denied'] as const)(
  'closes the ledger on %s',
  (type) =>
    Effect.gen(function* () {
      let terminal: UIMessageChunk
      switch (type) {
        case 'tool-output-available':
          terminal = { type, toolCallId: 'a', output: 1 }
          break
        case 'tool-output-error':
          terminal = { type, toolCallId: 'a', errorText: 'tool failed' }
          break
        case 'tool-output-denied':
          terminal = { type, toolCallId: 'a' }
          break
      }
      const stream = yield* Effect.promise(() =>
        resumable(
          transport(
            broken(
              [{ type: 'tool-input-start', toolCallId: 'a', toolName: 'pay' }, terminal],
              new TypeError('network failed'),
            ),
          ),
        ).reconnectToStream({ chatId: 'chat' }),
      )
      if (stream === null) throw new Error('Expected stream')
      const reader = stream.getReader()
      yield* Effect.promise(() => reader.read())
      yield* Effect.promise(() => reader.read())
      expect((yield* rejected(() => reader.read())).cause).toBeInstanceOf(ConnectionLost)
    }),
)

/** Feed a finite protocol sequence through the public SDK reader on this DOM typing baseline. */
function finite(chunks: readonly UIMessageChunk[]): ReadableStream<UIMessageChunk> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    },
  })
}

/** Compare the pure saved-message operation with the SDK's actual synthetic input-error fold. */
it.live.each([false, true])(
  'closes saved partial inputs exactly like the SDK (dynamic=%s)',
  (dynamic) =>
    Effect.gen(function* () {
      const start: UIMessageChunk = {
        type: 'tool-input-start',
        toolCallId: 'a',
        toolName: 'pay',
        dynamic,
        title: 'Invoice',
      }
      const chunks: UIMessageChunk[] = [
        { type: 'start', messageId: 'message' },
        { type: 'start-step' },
        start,
        { type: 'tool-input-delta', toolCallId: 'a', inputTextDelta: '{"amount":5' },
      ]
      let partial = Option.none<UIMessage>()
      const source = finite(chunks)
      partial = Option.some(structuredClone(yield* read(source, Option.none())))
      if (Option.isNone(partial)) throw new Error('Expected partial message')
      let closed = Option.none<UIMessage>()
      closed = Option.some(
        yield* read(
          finite([
            ...chunks,
            {
              type: 'tool-input-error',
              toolCallId: 'a',
              toolName: 'pay',
              dynamic,
              input: undefined,
              errorText: connectionLostInput,
            },
          ]),
          Option.none(),
        ),
      )
      expect(closeInputs([partial.value])).toEqual(Option.toArray(closed))
      expect(partial.value.parts[1]).toMatchObject({ state: 'input-streaming' })
    }),
)

/** TimeoutError is a transport acquisition failure too; a DOM exception does not require an
 * Error prototype across every browser realm. A plain status Error is passed through unchanged. */
it.live.each([new DOMException('Timed out', 'TimeoutError'), new Error('Turn was refused')])(
  'classifies the acquisition exception $name without changing a refusal',
  (cause) =>
    Effect.gen(function* () {
      const source: ChatTransport<UIMessage> = {
        sendMessages: () => Promise.reject(cause),
        reconnectToStream: () => Promise.reject(cause),
      }
      const failed = resumable(source).reconnectToStream({ chatId: 'chat' })
      if (cause.name === 'TimeoutError')
        expect((yield* rejected(() => failed)).cause).toMatchObject({
          name: 'ConnectionLost',
          cause,
        })
      else expect((yield* rejected(() => failed)).cause).toBe(cause)
    }),
)

/** Inspect one rejected operation's original cause without changing SDK error identity. */
function rejected<A>(operation: () => PromiseLike<A>) {
  return Effect.tryPromise({ try: operation, catch: (cause) => new ReadFailed({ cause }) }).pipe(
    Effect.matchEffect({
      onFailure: (error) =>
        Effect.succeed({
          cause: error.cause,
          raise: () => {
            throw error.cause
          },
        }),
      onSuccess: () => Effect.die(new Error('Expected the operation to reject')),
    }),
  )
}
