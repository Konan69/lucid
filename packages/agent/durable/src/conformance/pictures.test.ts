import { runForPi } from '../pi.ts'
import { consumeReadable } from '../fixtures/reading.ts'
import type { Message } from '@earendil-works/pi-ai'
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux'
import { expect, it } from '@effect/vitest'
import { DefaultChatTransport, type FileUIPart, type UIMessage } from 'ai'
import { Effect, Option, Stream } from 'effect'

import * as Core from '../core.ts'
import { PlainChat } from '../fixtures/chat.ts'
import type { ProviderOptions } from '../fixtures/provider.ts'
import {
  decodeTurn,
  history,
  respond,
  respondTurn,
  streamRun,
  PartUnsupported,
  PartTooLarge,
  TurnInvalid,
} from '../main.ts'
import { context, host } from './fixtures/host.ts'
import {} from './fixtures/host.ts'

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

/** Large base64 input with the PNG signature; validation never decodes/copies the full binary. */
function largePicture(megabytes: number, malformed: boolean): Core.InputPart {
  const length = megabytes * 1024 * 1024
  const payload = 'iVBORw0KGgoA' + 'AAAA'.repeat(length / 4 - 4)
  return {
    type: 'file',
    mediaType: 'image/png',
    url: `data:image/png;base64,${payload}${malformed ? 'AAA!' : 'AAAA'}`,
  }
}

// Build and flatten each large payload once per file. Reusing these immutable wire values keeps
// allocation/flattening out of the measured public admission while retaining full persistence.
const largePictures = [8, 32].map((megabytes) => ({
  megabytes,
  valid: largePicture(megabytes, false),
  malformed: largePicture(megabytes, true),
}))
for (const { valid, malformed } of largePictures) {
  if (valid.type !== 'file' || malformed.type !== 'file') throw new Error('Expected image parts')
  valid.url.charCodeAt(valid.url.length - 1)
  malformed.url.charCodeAt(malformed.url.length - 1)
}

/** Exercise public admission and HTTP rejection at sizes that overflowed Schema.isBase64. */
for (const { megabytes, valid, malformed } of largePictures) {
  it.live(`admits ${megabytes} MB base64 without a regex stack overflow`, () =>
    Effect.gen(function* () {
      const fixture = yield* host({}, {}, {}, images)
      const opened = yield* fixture.open()
      opened.faux.setResponses([fauxAssistantMessage('Accepted.')])
      const part = valid
      const stream = yield* Effect.promise(() =>
        Promise.resolve(
          streamRun(
            opened.harness,
            { conversationId: opened.root.id, content: [part], requestId: 'large-image' },
            context,
          ),
        ),
      )
      const result = yield* consumeReadable(stream, Option.none())
      expect(result.message.parts).toContainEqual({
        type: 'text',
        text: 'Accepted.',
        state: 'done',
      })
      expect(opened.faux.state.callCount).toBe(1)
    }),
  )
  it.live(`rejects malformed ${megabytes} MB base64 with tagged core failure and HTTP 400`, () =>
    Effect.gen(function* () {
      const fixture = yield* host({}, {}, {}, images)
      const opened = yield* fixture.open()
      const parts = [malformed]
      const result = yield* Core.prepareRun(
        opened.harness,
        { conversationId: opened.root.id, content: parts, requestId: 'invalid-large-image' },
        context,
      ).pipe(Effect.flip)
      expect(result).toBeInstanceOf(PartUnsupported)
      const response = yield* Effect.promise(() =>
        respond(
          opened.harness,
          opened.root.id,
          new Request('http://durable.test/chat', {
            method: 'POST',
            body: JSON.stringify({ messages: [{ role: 'user', id: 'bad-image', parts }] }),
          }),
          context,
        ),
      )
      expect(response.status).toBe(400)
      expect(opened.faux.state.callCount).toBe(0)
      expect(
        (yield* Effect.promise(() => opened.root.entries({}, 10, undefined, context))).items,
      ).toEqual([])
    }),
  )
}

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
  Effect.gen(function* () {
    const fixture = yield* host({}, {}, {}, images)
    const opened = yield* fixture.open()
    let received: readonly Message[] = []
    opened.faux.setResponses([
      (transcript) => {
        received = transcript.messages
        return fauxAssistantMessage('A picture.')
      },
    ])
    const chat = new PlainChat({ transport: opened.transport })
    yield* Effect.promise(() =>
      Promise.resolve(chat.sendMessage({ text: 'Describe this', files: [picture] })),
    )
    expect(chat.status).toBe('ready')
    expect(userContent(received)).toEqual([
      { type: 'image', mimeType: 'image/png', data, filename: 'picture.png' },
      { type: 'text', text: 'Describe this' },
    ])
    const page = yield* Effect.promise(() =>
      Promise.resolve(history(opened.harness, opened.root.id, { limit: 10 }, context)),
    )
    expect(partsAt(page.messages, 0)).toEqual([picture, { type: 'text', text: 'Describe this' }])
    const reloaded = new PlainChat({ transport: opened.transport })
    reloaded.messages = page.messages
    yield* Effect.promise(() => Promise.resolve(reloaded.resumeStream()))
    expect(reloaded.messages.map((message) => message.role)).toEqual(['user', 'assistant'])
    expect(partsAt(reloaded.messages, 0)).toEqual(partsAt(chat.messages, 0))
    expect(partsAt(reloaded.messages, 1)).toEqual(partsAt(chat.messages, 1))
    expect(opened.faux.state.callCount).toBe(1)
  }),
)

/** A multi-megabyte HTTP body persists and reloads the entire validated image, without truncation. */
it.live('round trips a three-megabyte image payload through stock Chat HTTP and history', () =>
  Effect.gen(function* () {
    const opened = yield* (yield* host({}, {}, {}, images)).open()
    opened.faux.setResponses([fauxAssistantMessage('Stored the picture.')])
    const part = largePicture(3, false)
    const chat = new PlainChat({ transport: opened.transport })
    yield* Effect.promise(() => Promise.resolve(chat.sendMessage({ parts: [part] })))
    expect(chat.status).toBe('ready')
    const page = yield* Effect.promise(() =>
      Promise.resolve(history(opened.harness, opened.root.id, { limit: 10 }, context)),
    )
    expect(partsAt(page.messages, 0)).toEqual([part])
    const reloaded = new PlainChat({ transport: opened.transport })
    reloaded.messages = page.messages
    yield* Effect.promise(() => Promise.resolve(reloaded.resumeStream()))
    expect(partsAt(reloaded.messages, 0)).toEqual([part])
    expect(opened.faux.state.callCount).toBe(1)
  }),
)

/** An explicit SDK message retains interleaved text/image order rather than flattening text. */
it.live('retains ordered text and pictures through chat and raw history', () =>
  Effect.gen(function* () {
    const fixture = yield* host({}, {}, {}, images)
    const opened = yield* fixture.open()
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
    yield* Effect.promise(() => Promise.resolve(chat.sendMessage({ parts })))
    expect(chat.status).toBe('ready')
    expect(userContent(received)).toEqual([
      { type: 'text', text: 'First' },
      { type: 'image', mimeType: 'image/png', data, filename: 'picture.png' },
      { type: 'text', text: 'Second' },
      { type: 'image', mimeType: 'image/png', data },
    ])
    const page = yield* Effect.promise(() =>
      Promise.resolve(history(opened.harness, opened.root.id, { limit: 10 }, context)),
    )
    expect(partsAt(page.messages, 0)).toEqual(
      parts.filter((part) => part.type !== 'text' || part.text !== ''),
    )
  }),
)

/** File-only turns are valid on the core too; preparation admits the identical native image block. */
it.live('admits file-only input through core prepareRun', () =>
  Effect.gen(function* () {
    const fixture = yield* host({}, {}, {}, images)
    const opened = yield* fixture.open()
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
  {
    name: 'SVG with script',
    mediaType: 'image/svg+xml',
    url: 'data:image/svg+xml;base64,PHN2Zz48c2NyaXB0PmFsZXJ0KDEpPC9zY3JpcHQ+PC9zdmc+',
  },
  {
    name: 'unknown image media',
    mediaType: 'image/x-anything',
    url: 'data:image/x-anything;base64,YQ==',
  },
  {
    name: 'plain text declared as PNG',
    mediaType: 'image/png',
    url: 'data:image/png;base64,aGVsbG8=',
  },
  { name: 'remote images', mediaType: 'image/png', url: 'https://picture.test/image.png' },
  {
    name: 'non-image files',
    mediaType: 'application/pdf',
    url: 'data:application/pdf;base64,YQ==',
  },
  { name: 'invalid base64', mediaType: 'image/png', url: 'data:image/png;base64,invalid!' },
  { name: 'mismatched media types', mediaType: 'image/png', url: `data:image/jpeg;base64,${data}` },
]

/** All four admitted MIME types must match actual decoded signature bytes. */
for (const [mediaType, signature] of [
  ['image/png', [137, 80, 78, 71, 13, 10, 26, 10]],
  ['image/jpeg', [255, 216, 255, 224]],
  ['image/gif', [71, 73, 70, 56, 55, 97]],
  ['image/gif', [71, 73, 70, 56, 57, 97]],
  ['image/webp', [82, 73, 70, 70, 4, 0, 0, 0, 87, 69, 66, 80]],
] as const)
  it.live(`admits ${mediaType} signature ${signature.join(',')}`, () =>
    Effect.gen(function* () {
      const fixture = yield* host({}, {}, {}, images)
      const opened = yield* fixture.open()
      const encoded = Buffer.from(signature).toString('base64')
      const parts: Core.InputPart[] = [
        { type: 'file', mediaType, url: `data:${mediaType};base64,${encoded}` },
      ]
      opened.faux.setResponses([fauxAssistantMessage('Recognized.')])
      yield* consumeReadable(
        yield* Effect.promise(() =>
          Promise.resolve(
            streamRun(
              opened.harness,
              { conversationId: opened.root.id, content: parts, requestId: 'signature' },
              context,
            ),
          ),
        ),
        Option.none(),
      )
      expect(opened.faux.state.callCount).toBe(1)
      const page = yield* Effect.promise(() =>
        Promise.resolve(history(opened.harness, opened.root.id, { limit: 10 }, context)),
      )
      expect(partsAt(page.messages, 0)).toEqual(parts)
    }),
  )

/** Byte budgets use the decoded size and reject before persistence on every public input seam. */
it.live(
  'enforces the host decoded-byte bound in core, streamRun, respondTurn and Request ingress',
  () =>
    Effect.gen(function* () {
      const fixture = yield* host({}, {}, {}, images)
      const opened = yield* fixture.open()
      const bytes = Buffer.from(data, 'base64').byteLength
      const options = { maxPartBytes: bytes - 1 }
      const input = {
        conversationId: opened.root.id,
        content: [picture],
        requestId: 'bounded',
        options,
      }
      const failure = yield* Core.prepareRun(opened.harness, input, context).pipe(Effect.flip)
      expect(failure).toBeInstanceOf(PartTooLarge)
      expect(failure).toMatchObject({ bytes, limit: bytes - 1 })
      yield* Effect.promise(() =>
        expect(streamRun(opened.harness, input, context)).rejects.toBeInstanceOf(PartTooLarge),
      )
      const turn = Core.ChatTurn.cases.Input.make({ messageId: 'bounded', parts: [picture] })
      const core = yield* Core.respond(
        opened.harness,
        opened.root.id,
        { turn, options },
        context,
      ).pipe(Effect.flip)
      expect(core).toBeInstanceOf(PartTooLarge)
      const turned = yield* Effect.promise(() =>
        respondTurn(opened.harness, opened.root.id, { turn, options }, context),
      )
      expect(turned.status).toBe(413)
      const request = new Request('http://durable.test/chat', {
        method: 'POST',
        body: JSON.stringify({ messages: [{ role: 'user', id: 'bounded', parts: [picture] }] }),
      })
      const response = yield* Effect.promise(() =>
        respond(opened.harness, opened.root.id, { request, options }, context),
      )
      expect(response.status).toBe(413)
      expect(yield* Effect.promise(() => response.text())).toBe('File part too large')
      expect(opened.faux.state.callCount).toBe(0)
      expect(
        (yield* Effect.promise(() => opened.root.entries({}, 10, undefined, context))).items,
      ).toEqual([])
      opened.faux.setResponses([fauxAssistantMessage('At the bound.')])
      yield* Effect.gen(function* () {
        return yield* consumeReadable(
          yield* Effect.promise(() =>
            Promise.resolve(
              streamRun(
                opened.harness,
                {
                  ...input,
                  options: { maxPartBytes: bytes },
                },
                context,
              ),
            ),
          ),
          Option.none(),
        )
      })
      expect(opened.faux.state.callCount).toBe(1)
    }),
)

/** Incomplete files cannot fall through to a generic ignored part alongside otherwise valid text. */
it.live('rejects incomplete file shapes and empty text at body decoding', () =>
  Effect.gen(function* () {
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
      yield* Effect.promise(() =>
        Promise.resolve(
          expect(
            decodeTurn({ messages: [{ role: 'user', id: 'invalid-file', parts }] }),
          ).rejects.toBeInstanceOf(TurnInvalid),
        ),
      )
  }),
)

/** Unsupported files fail before admission, including beside valid text, with no model call/fetch. */
for (const given of unsupported)
  it.live(`rejects ${given.name} without dropping the file or submitting a turn`, () =>
    Effect.gen(function* () {
      const fixture = yield* host({}, {}, {}, images)
      const opened = yield* fixture.open()
      const statuses: number[] = []
      const transport = new DefaultChatTransport<UIMessage>({
        api: 'http://durable.test/chat',
        fetch: (url, init) =>
          runForPi(
            Effect.gen(function* () {
              const response = yield* Effect.promise(() =>
                Promise.resolve(
                  respond(opened.harness, opened.root.id, new Request(url, init), context),
                ),
              )
              statuses.push(response.status)
              return response
            }),
            undefined,
          ),
      })
      const part: Core.InputPart = { type: 'file', mediaType: given.mediaType, url: given.url }
      const chat = new PlainChat({ transport })
      yield* Effect.promise(() =>
        Promise.resolve(chat.sendMessage({ text: 'Do not lose my file', files: [part] })),
      )
      expect(statuses).toEqual([400])
      expect(chat.status).toBe('error')
      if (chat.error === undefined) throw new Error('Expected chat admission failure')
      expect(chat.error.message).toBe('Unsupported file; use an inline base64 image')
      yield* Effect.promise(() =>
        Promise.resolve(
          expect(
            streamRun(
              opened.harness,
              { conversationId: opened.root.id, content: [part], requestId: 'unsupported' },
              context,
            ),
          ).rejects.toMatchObject({ mediaType: given.mediaType }),
        ),
      )
      yield* Effect.promise(() =>
        Promise.resolve(
          expect(
            streamRun(
              opened.harness,
              { conversationId: opened.root.id, content: [part], requestId: 'unsupported-repeat' },
              context,
            ),
          ).rejects.toBeInstanceOf(PartUnsupported),
        ),
      )
      expect(opened.faux.state.callCount).toBe(0)
      expect(
        (yield* Effect.promise(() =>
          Promise.resolve(opened.root.entries({}, 10, undefined, context)),
        )).items,
      ).toEqual([])
    }),
  )
