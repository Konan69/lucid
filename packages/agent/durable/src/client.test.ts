import { type ChatTransport, type UIMessage, type UIMessageChunk, uiMessageChunkSchema } from 'ai'
import { expect, it } from 'vitest'
import { ConnectionLost, connectionLostInput, resumable } from './client.ts'

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
it.each(['send', 'reconnect'] as const)(
  'guards %s chunks without retaining SDK state',
  async (kind) => {
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
        ? await guarded.sendMessages({
            trigger: 'submit-message',
            chatId: 'chat',
            messages: [],
            messageId: undefined,
            abortSignal: undefined,
          })
        : await guarded.reconnectToStream({ chatId: 'chat' })
    if (stream === null) throw new Error('Expected stream')
    const reader = stream.getReader()
    expect((await reader.read()).value).toEqual(start)
    expect((await reader.read()).value).toEqual(second)
    for (const identity of [start, second]) {
      const received = (await reader.read()).value
      expect(received).toMatchObject({
        type: 'tool-input-error',
        toolCallId: identity.toolCallId,
        errorText: connectionLostInput,
      })
      const schema = uiMessageChunkSchema()
      if (schema.validate === undefined) throw new Error('Expected chunk validator')
      expect((await schema.validate(received)).success).toBe(true)
    }
    const failed = await reader.read().catch((error: Error) => error)
    expect(failed).toBeInstanceOf(ConnectionLost)
    expect(failed).not.toBeInstanceOf(TypeError)
    expect(failed).toMatchObject({ name: 'ConnectionLost', cause })
  },
)

/** Completed inputs and a reset are not failed a second time; stream ledgers belong to each reader. */
it('clears completed and reset inputs before a disconnect', async () => {
  const source = broken(
    [
      { type: 'tool-input-start', toolCallId: 'a', toolName: 'pay' },
      { type: 'tool-input-available', toolCallId: 'a', toolName: 'pay', input: {} },
      { type: 'tool-input-start', toolCallId: 'b', toolName: 'ask' },
      { type: 'reset-step' },
    ],
    new TypeError('network failed'),
  )
  const stream = await resumable(transport(source)).reconnectToStream({ chatId: 'chat' })
  if (stream === null) throw new Error('Expected stream')
  const reader = stream.getReader()
  for (let i = 0; i < 4; i += 1) expect((await reader.read()).done).toBe(false)
  await expect(reader.read()).rejects.toBeInstanceOf(ConnectionLost)
})

/** Method-level failures and reader failures preserve standard abort exception identity. */
it('passes aborts through at both transport boundaries', async () => {
  const cause = new DOMException('Stopped', 'AbortError')
  const before: ChatTransport<UIMessage> = {
    sendMessages: () => Promise.reject(cause),
    reconnectToStream: () => Promise.reject(cause),
  }
  await expect(resumable(before).reconnectToStream({ chatId: 'chat' })).rejects.toBe(cause)
  const stream = await resumable(transport(broken([], cause))).reconnectToStream({ chatId: 'chat' })
  if (stream === null) throw new Error('Expected stream')
  await expect(stream.getReader().read()).rejects.toBe(cause)
})

type Cancellation = { reason?: { stopped: boolean } }

/** Preserve cancellation reasons and null idle replies; pre-stream network errors are wrapped too. */
it('forwards cancellation and guards acquisition failures', async () => {
  const received: Cancellation = {}
  const stopped = { stopped: true }
  const source = new ReadableStream<UIMessageChunk>({
    cancel(value: { stopped: boolean }) {
      received.reason = value
    },
  })
  const stream = await resumable(transport(source)).reconnectToStream({ chatId: 'chat' })
  if (stream === null) throw new Error('Expected stream')
  await stream.cancel(stopped)
  expect(received.reason).toBe(stopped)
  const cause = new TypeError('fetch failed')
  const before: ChatTransport<UIMessage> = {
    sendMessages: () => Promise.reject(cause),
    reconnectToStream: () => Promise.resolve(null),
  }
  expect(await resumable(before).reconnectToStream({ chatId: 'chat' })).toBeNull()
  await expect(
    resumable(before).sendMessages({
      trigger: 'submit-message',
      chatId: 'chat',
      messages: [],
      messageId: undefined,
      abortSignal: undefined,
    }),
  ).rejects.toMatchObject({ name: 'ConnectionLost', cause })
})
