import { DefaultChatTransport, type UIMessage } from 'ai'
import { expect, it } from 'vitest'
import { resumption } from './client.ts'

/** Exercise the SDK's actual URL selection, preserving relative APIs, queries, fragments and id encoding. */
it.each(['/chat', '/chat?token=public#tail', 'https://durable.test/chat?x=1'])(
  'adds retained reconnect state to the SDK path for %s',
  async (api) => {
    const link = resumption()
    const message: UIMessage = {
      id: 'message / two',
      role: 'assistant',
      parts: [
        { type: 'step-start' },
        { type: 'text', text: 'first', state: 'done' },
        { type: 'step-start' },
      ],
    }
    const requests: string[] = []
    const transport = new DefaultChatTransport({
      api,
      prepareReconnectToStreamRequest: link.prepare,
      fetch: async (url) => {
        requests.push(
          new Request(url instanceof Request ? url : new URL(url, 'https://durable.test')).url,
        )
        return new Response(null, { status: 204 })
      },
    })
    await transport.reconnectToStream({ chatId: 'chat / id', abortSignal: undefined })
    link.onFinish({
      message,
      messages: [message],
      isAbort: false,
      isDisconnect: true,
      isError: false,
    })
    await transport.reconnectToStream({ chatId: 'chat / id', abortSignal: undefined })
    const original = requests[0]
    const retained = requests[1]
    if (original === undefined || retained === undefined)
      throw new Error('Expected reconnect requests')
    const before = new URL(original, 'https://durable.test')
    const after = new URL(retained, 'https://durable.test')
    expect(after.pathname).toBe(before.pathname)
    expect(after.pathname).toBe('/chat/chat%20%2F%20id/stream')
    expect(after.hash).toBe(before.hash)
    expect(after.searchParams.get('message')).toBe(message.id)
    expect(after.searchParams.get('steps')).toBe('2')
    for (const [key, value] of before.searchParams) expect(after.searchParams.get(key)).toBe(value)
    for (const isAbort of [false, true]) {
      link.onFinish({ message, messages: [message], isAbort, isDisconnect: false, isError: false })
      await transport.reconnectToStream({ chatId: 'chat / id', abortSignal: undefined })
      expect(requests.at(-1)).toBe(original)
    }
  },
)

/** A custom reconnect URL must retain the SDK's protection against URL dot-segment normalization. */
it.each(['.', '..'])('rejects dot chat id %s even with retained state', async (id) => {
  const link = resumption()
  const message: UIMessage = { id: 'message', role: 'assistant', parts: [{ type: 'step-start' }] }
  link.onFinish({
    message,
    messages: [message],
    isAbort: false,
    isDisconnect: true,
    isError: false,
  })
  const transport = new DefaultChatTransport({
    api: '/chat',
    prepareReconnectToStreamRequest: link.prepare,
  })
  await expect(
    transport.reconnectToStream({ chatId: id, abortSignal: undefined }),
  ).rejects.toMatchObject({ name: 'AI_InvalidArgumentError' })
})
