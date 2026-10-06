import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux'
import { expect, it } from 'vitest'
import { PlainChat } from '../fixtures/chat.ts'
import { abort } from '../main.ts'
import { call, context, shop, signal, texts } from './fixtures/host.ts'

/** A lost HTTP response can be retried with the same user identity after its run has settled. */
it.each(['done', 'aborted', 'failed', 'active'] as const)(
  'finishes a repeated user POST for a %s run without another model invocation',
  async (state) => {
    const fixture = await shop()
    const opened = await fixture.open()
    const response =
      state === 'failed'
        ? fauxAssistantMessage('Failed partial', {
            stopReason: 'error',
            errorMessage: 'invalid model request',
          })
        : fauxAssistantMessage('Done.')
    opened.faux.setResponses(
      state === 'active' || state === 'aborted' ? [call('pay', { amount: 1 }, 'held')] : [response],
    )
    const first = new PlainChat({ transport: opened.transport })
    await first.sendMessage({ text: 'First' })
    if (state === 'aborted') await abort(opened.harness, opened.root.id, context)
    if (state !== 'active') await opened.root.waitForIdle(context)
    const user = first.messages[0]
    if (user === undefined || user.role !== 'user') throw new Error('Expected user input')
    const finished = signal()
    const retried = new PlainChat({
      transport: opened.transport,
      onFinish: () => finished.resolve(),
    })
    retried.messages = [user]
    await retried.sendMessage()
    await finished.promise
    expect(retried.status).toBe('ready')
    expect(opened.faux.state.callCount).toBe(1)
    if (retried.lastMessage === undefined || first.lastMessage === undefined)
      throw new Error('Expected messages')
    expect(retried.lastMessage.id).toBe(first.lastMessage.id)
    if (state === 'done') expect(texts(retried.lastMessage)).toEqual(['Done.'])
    if (state === 'active') expect(retried.lastMessage.parts).toEqual(first.lastMessage.parts)
    if (state === 'aborted')
      expect(retried.lastMessage.parts).toContainEqual(
        expect.objectContaining({ toolCallId: 'held', state: 'output-error' }),
      )
  },
)

/** Pi's transcript is append-only; stock SDK regeneration must be an explicit typed refusal. */
it('refuses stock Chat.regenerate with 400 instead of reopening the same input', async () => {
  const opened = await (await shop()).open()
  opened.faux.setResponses([fauxAssistantMessage('Once')])
  const chat = new PlainChat({ transport: opened.transport })
  await chat.sendMessage({ text: 'First' })
  await chat.regenerate()
  expect(chat.status).toBe('error')
  expect(chat.error).toBeInstanceOf(Error)
  if (chat.error === undefined) throw new Error('Expected regeneration refusal')
  expect(chat.error.message).toBe('Regeneration is not supported')
  expect(opened.faux.state.callCount).toBe(1)
})
