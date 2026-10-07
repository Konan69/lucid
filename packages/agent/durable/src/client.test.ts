import { Option } from 'effect'
import {
  type ChatTransport,
  type UIMessage,
  type UIMessageChunk,
  uiMessageChunkSchema,
  readUIMessageStream,
} from 'ai'
import { expect, it } from 'vitest'
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

/** A terminal tool output ends the ledger even if an adapter omitted input-available. */
it.each(['tool-output-available', 'tool-output-error', 'tool-output-denied'] as const)(
  'closes the ledger on %s',
  async (type) => {
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
    const stream = await resumable(
      transport(
        broken(
          [{ type: 'tool-input-start', toolCallId: 'a', toolName: 'pay' }, terminal],
          new TypeError('network failed'),
        ),
      ),
    ).reconnectToStream({ chatId: 'chat' })
    if (stream === null) throw new Error('Expected stream')
    const reader = stream.getReader()
    await reader.read()
    await reader.read()
    await expect(reader.read()).rejects.toBeInstanceOf(ConnectionLost)
  },
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
it.each([false, true])(
  'closes saved partial inputs exactly like the SDK (dynamic=%s)',
  async (dynamic) => {
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
    for await (const message of readUIMessageStream({ stream: source }))
      partial = Option.some(structuredClone(message))
    if (Option.isNone(partial)) throw new Error('Expected partial message')
    let closed = Option.none<UIMessage>()
    for await (const message of readUIMessageStream({
      stream: finite([
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
    }))
      closed = Option.some(message)
    expect(closeInputs([partial.value])).toEqual(Option.toArray(closed))
    expect(partial.value.parts[1]).toMatchObject({ state: 'input-streaming' })
  },
)
