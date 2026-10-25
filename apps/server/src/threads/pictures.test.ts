import * as NodeBuffer from 'node:buffer'
import { expect, it } from '@effect/vitest'
import { MessageAttachment, SendToThreadRequest } from '@vivid/contracts'
import { Effect, Result, Schema } from 'effect'
import { messagePictures } from './pictures.ts'

const decodeRequest = Schema.decodeUnknownEffect(SendToThreadRequest)
const decodeFields = Schema.decodeUnknownEffect(Schema.Struct(SendToThreadRequest.fields))
const encodePictures = Schema.encodeEffect(Schema.toCodecJson(Schema.Array(MessageAttachment)))
const picture = { type: 'image', mimeType: 'image/png', data: 'AA==' }
const request = { threadId: 'thread', text: 'Look', key: 'key' }
const transportLimit = 28 * 1024 * 1024

/** Transport bounds refuse absurd envelopes before allocation or Run reservation. */
it.effect('refuses seventeen pictures, oversized picture data and excessive aggregate data', () =>
  Effect.gen(function* () {
    for (const pictures of [
      Array.from({ length: 17 }, () => picture),
      [{ ...picture, data: 'A'.repeat(transportLimit + 1) }],
      [
        { ...picture, data: 'A'.repeat(transportLimit / 2) },
        { ...picture, data: 'A'.repeat(transportLimit / 2 + 1) },
      ],
    ]) {
      const result = yield* decodeRequest({ ...request, pictures }).pipe(Effect.result)
      expect(Result.isFailure(result)).toBe(true)
    }
  }),
)

/** Ordinary oversize must cross RPC decoding and answer the product's actionable errors. */
it.effect(
  'answers TooManyAttachments for five pictures and AttachmentTooLarge just above 5 MiB',
  () =>
    Effect.gen(function* () {
      for (const refusal of [
        {
          pictures: Array.from({ length: 5 }, () => picture),
          tag: 'TooManyAttachments',
        },
        {
          pictures: [
            { ...picture, data: NodeBuffer.Buffer.alloc(5 * 1024 * 1024 + 1).toString('base64') },
          ],
          tag: 'AttachmentTooLarge',
        },
      ]) {
        const decoded = yield* decodeRequest({ ...request, pictures: refusal.pictures })
        const attachments = yield* encodePictures(decoded.pictures)
        const result = yield* messagePictures(
          { kind: 'user', body: decoded.text, attachments, idempotencyKey: decoded.key },
          { id: decoded.threadId, audience: 'private' },
        ).pipe(Effect.result)
        expect(Result.isFailure(result) && result.failure._tag).toBe(refusal.tag)
      }
    }),
)

/** The serialized ceiling also counts text, escaping and envelope fields, unlike picture totals. */
it.effect('refuses a serialized envelope that fits every field and aggregate picture bound', () =>
  Effect.gen(function* () {
    const envelope = {
      ...request,
      text: '\n'.repeat(1000),
      pictures: [{ ...picture, data: 'A'.repeat(transportLimit - 1000) }],
    }
    const fields = yield* decodeFields(envelope)
    expect(fields.pictures).toHaveLength(1)
    const result = yield* decodeRequest(envelope).pipe(Effect.result)
    expect(Result.isFailure(result)).toBe(true)
  }),
)
