import type { Message } from '@earendil-works/pi-ai'
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux'
import { expect, it } from '@effect/vitest'
import { DefaultChatTransport, type FileUIPart, type UIMessage } from 'ai'
import { Effect, Option, Stream } from 'effect'

import * as Core from '../core.ts'
import { PlainChat } from '../fixtures/chat.ts'
import type { ProviderOptions } from '../fixtures/provider.ts'
import { decodeTurn, history, respond, streamRun, PartUnsupported, TurnInvalid } from '../main.ts'
import { context, host } from './fixtures/host.ts'

// A valid one-pixel PNG, not a URL that a test or server could fetch.
const data =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZioAAAAASUVORK5CYII='
const picture: FileUIPart = {
  type: 'file',
  mediaType: 'image/png',
  url: `data:image/png;base64,${data}`,
  filename: 'picture.png',
}
const images: ProviderOptions = { models: [{ id: 'faux-1', input: ['text', 'image'] }] }

/** Assert a real user entry exists before comparing what the provider received. */
function userContent(messages: readonly Message[]) {
  const user = messages.find((message) => message.role === 'user')
  if (user === undefined) throw new Error('Expected user input in model context')
  return user.content
}

/** Missing messages are test failures, never empty substitute parts. */
function partsAt(messages: readonly UIMessage[], index: number) {
  const message = messages[index]
  if (message === undefined) throw new Error(`Expected message ${index}`)
  return message.parts
}

/** Stock sendMessage(files) crosses HTTP, Pi input and SQLite, then reloads into the same SDK. */
it.live('sends an inline picture to Pi and restores the same file part from history', () =>
  Effect.promise(async () => {
    const fixture = await host({}, {}, {}, images)
    const opened = await fixture.open()
    let received: readonly Message[] = []
    opened.faux.setResponses([
      (transcript) => {
        received = transcript.messages
        return fauxAssistantMessage('A picture.')
      },
    ])
    const chat = new PlainChat({ transport: opened.transport })
    await chat.sendMessage({ text: 'Describe this', files: [picture] })
    expect(chat.status).toBe('ready')
    expect(userContent(received)).toEqual([
      { type: 'image', mimeType: 'image/png', data, filename: 'picture.png' },
      { type: 'text', text: 'Describe this' },
    ])
    const page = await history(opened.harness, opened.root.id, { limit: 10 }, context)
    expect(partsAt(page.messages, 0)).toEqual([picture, { type: 'text', text: 'Describe this' }])
    const reloaded = new PlainChat({ transport: opened.transport })
    reloaded.messages = page.messages
    await reloaded.resumeStream()
    expect(reloaded.messages.map((message) => message.role)).toEqual(['user', 'assistant'])
    expect(partsAt(reloaded.messages, 0)).toEqual(partsAt(chat.messages, 0))
    expect(partsAt(reloaded.messages, 1)).toEqual(partsAt(chat.messages, 1))
    expect(opened.faux.state.callCount).toBe(1)
  }),
)

/** An explicit SDK message retains interleaved text/image order rather than flattening text. */
it.live('retains ordered text and pictures through chat and raw history', () =>
  Effect.promise(async () => {
    const fixture = await host({}, {}, {}, images)
    const opened = await fixture.open()
    let received: readonly Message[] = []
    opened.faux.setResponses([
      (transcript) => {
        received = transcript.messages
        return fauxAssistantMessage('Ordered.')
      },
    ])
    const parts: Core.InputPart[] = [
      { type: 'text', text: 'First' },
      picture,
      { type: 'text', text: '' },
      { type: 'text', text: 'Second' },
      { type: 'file', mediaType: picture.mediaType, url: picture.url },
    ]
    const chat = new PlainChat({ transport: opened.transport })
    await chat.sendMessage({ parts })
    expect(chat.status).toBe('ready')
    expect(userContent(received)).toEqual([
      { type: 'text', text: 'First' },
      { type: 'image', mimeType: 'image/png', data, filename: 'picture.png' },
      { type: 'text', text: '' },
      { type: 'text', text: 'Second' },
      { type: 'image', mimeType: 'image/png', data },
    ])
    const page = await history(opened.harness, opened.root.id, { limit: 10 }, context)
    expect(partsAt(page.messages, 0)).toEqual(parts)
  }),
)

/** File-only turns are valid on the core too; preparation admits the identical native image block. */
it.live('admits file-only input through core prepareRun', () =>
  Effect.gen(function* () {
    const fixture = yield* Effect.promise(() => host({}, {}, {}, images))
    const opened = yield* Effect.promise(() => fixture.open())
    opened.faux.setResponses([fauxAssistantMessage('Image only.')])
    const stream = yield* Core.prepareRun(
      opened.harness,
      { conversationId: opened.root.id, content: [picture], requestId: 'image-only' },
      context,
    )
    yield* Stream.runDrain(stream)
    const page = yield* Core.history(
      opened.harness,
      opened.root.id,
      { limit: 10, before: Option.none() },
      context,
    )
    expect(partsAt(page.messages, 0)).toEqual([picture])
  }),
)

const unsupported = [
  { name: 'remote images', mediaType: 'image/png', url: 'https://picture.test/image.png' },
  {
    name: 'non-image files',
    mediaType: 'application/pdf',
    url: 'data:application/pdf;base64,YQ==',
  },
  { name: 'invalid base64', mediaType: 'image/png', url: 'data:image/png;base64,invalid!' },
  { name: 'mismatched media types', mediaType: 'image/png', url: `data:image/jpeg;base64,${data}` },
]

/** Incomplete files cannot fall through to a generic ignored part alongside otherwise valid text. */
it.live('rejects incomplete file shapes and empty text at body decoding', () =>
  Effect.promise(async () => {
    const invalid = [
      [{ type: 'text', text: '' }],
      [
        { type: 'text', text: 'Keep the file' },
        { type: 'file', mediaType: 'image/png' },
      ],
      [{ type: 'file', mediaType: 'image/png', url: 7 }],
      [{ ...picture, filename: 7 }],
    ]
    for (const parts of invalid)
      await expect(
        decodeTurn({ messages: [{ role: 'user', id: 'invalid-file', parts }] }),
      ).rejects.toBeInstanceOf(TurnInvalid)
  }),
)

/** Unsupported files fail before admission, including beside valid text, with no model call/fetch. */
for (const given of unsupported)
  it.live(`rejects ${given.name} without dropping the file or submitting a turn`, () =>
    Effect.promise(async () => {
      const fixture = await host({}, {}, {}, images)
      const opened = await fixture.open()
      const statuses: number[] = []
      const transport = new DefaultChatTransport<UIMessage>({
        api: 'http://durable.test/chat',
        fetch: async (url, init) => {
          const response = await respond(
            opened.harness,
            opened.root.id,
            new Request(url, init),
            context,
          )
          statuses.push(response.status)
          return response
        },
      })
      const part: Core.InputPart = { type: 'file', mediaType: given.mediaType, url: given.url }
      const chat = new PlainChat({ transport })
      await chat.sendMessage({ text: 'Do not lose my file', files: [part] })
      expect(statuses).toEqual([400])
      expect(chat.status).toBe('error')
      if (chat.error === undefined) throw new Error('Expected chat admission failure')
      expect(chat.error.message).toBe('Unsupported file; use an inline base64 image')
      await expect(
        streamRun(
          opened.harness,
          { conversationId: opened.root.id, content: [part], requestId: 'unsupported' },
          context,
        ),
      ).rejects.toMatchObject({ mediaType: given.mediaType })
      await expect(
        streamRun(
          opened.harness,
          { conversationId: opened.root.id, content: [part], requestId: 'unsupported-repeat' },
          context,
        ),
      ).rejects.toBeInstanceOf(PartUnsupported)
      expect(opened.faux.state.callCount).toBe(0)
      expect((await opened.root.entries({}, 10, undefined, context)).items).toEqual([])
    }),
  )
