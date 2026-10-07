import * as NodeBuffer from 'node:buffer'
import * as NodeCrypto from 'node:crypto'
import { Effect, Option, Schema } from 'effect'
import {
  AttachmentTooLarge,
  InvalidAttachment,
  MessageAttachment,
  PictureMediaType,
  PicturesRequirePrivateThread,
  SendMessageRequest,
  TooManyAttachments,
  UnsupportedAttachment,
} from '@vivid/contracts'
import type { StoredThread } from './access.ts'

/** Decode the envelope first so attachment limits and formats have their own actionable tags. */
export const IncomingMessage = Schema.Struct({
  kind: SendMessageRequest.fields.kind,
  body: SendMessageRequest.fields.body,
  idempotencyKey: SendMessageRequest.fields.idempotencyKey,
  attachments: Schema.optionalKey(Schema.Json),
})

const Candidate = Schema.Struct({
  type: Schema.String,
  data: Schema.String,
  mimeType: Schema.String,
  filename: MessageAttachment.fields.filename,
})
const decodeCandidate = Schema.decodeUnknownEffect(Candidate)
const decodeCandidates = Schema.decodeUnknownEffect(Schema.Array(Schema.Json))
const decodeMediaType = Schema.decodeUnknownOption(PictureMediaType)
const maxBytes = 5 * 1024 * 1024
const maxEncodedLength = 4 * Math.ceil(maxBytes / 3)
// A repeated four-character group over a 5 MB picture overflows V8's regexp stack.
// This flat scan checks the alphabet; the decoded round-trip below checks padding and trailing bits.
const base64 = /^[A-Za-z0-9+/]*={0,2}$/u

/** Signatures identify these four formats without trusting extensions or a client-supplied MIME. */
export function pictureType(bytes: Uint8Array): Option.Option<PictureMediaType> {
  const data = NodeBuffer.Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (data.subarray(0, 8).equals(NodeBuffer.Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    return Option.some('image/png')
  if (data[0] === 255 && data[1] === 216 && data[2] === 255) return Option.some('image/jpeg')
  const header = data.toString('latin1', 0, 6)
  if (header === 'GIF87a' || header === 'GIF89a') return Option.some('image/gif')
  if (data.toString('latin1', 0, 4) === 'RIFF' && data.toString('latin1', 8, 12) === 'WEBP')
    return Option.some('image/webp')
  return Option.none()
}

/** Strict base64 prevents Node's permissive decoder from silently dropping malformed input. */
const checkedAttachment = Effect.fn('Pictures.checked')(function* (input: Schema.Json) {
  const candidate = yield* decodeCandidate(input).pipe(
    Effect.mapError(
      () => new InvalidAttachment({ message: 'Send a picture with valid attachment fields.' }),
    ),
  )
  const mediaType = decodeMediaType(candidate.mimeType)
  if (candidate.type !== 'image' || Option.isNone(mediaType))
    return yield* new UnsupportedAttachment({ message: 'Choose a PNG, JPEG, WebP or GIF picture.' })
  if (candidate.data.length > maxEncodedLength)
    return yield* new AttachmentTooLarge({ message: 'Each picture must be 5 MB or smaller.' })
  if (!base64.test(candidate.data))
    return yield* new InvalidAttachment({ message: 'The picture data must be valid base64.' })
  const bytes = NodeBuffer.Buffer.from(candidate.data, 'base64')
  if (bytes.byteLength > maxBytes)
    return yield* new AttachmentTooLarge({ message: 'Each picture must be 5 MB or smaller.' })
  if (bytes.toString('base64') !== candidate.data)
    return yield* new InvalidAttachment({ message: 'The picture data must be valid base64.' })
  if (!Option.contains(pictureType(bytes), mediaType.value))
    return yield* new UnsupportedAttachment({
      message: 'The picture type does not match its contents.',
    })
  // Candidate has already decoded the fields; byte checks refine its MIME into the allowed domain.
  return MessageAttachment.make({ ...candidate, type: 'image', mimeType: mediaType.value })
})

/** Shared refusals precede reservation and delivery; an empty array still means an ordinary text message. */
export const messagePictures = Effect.fn('Pictures.message')(function* (
  sent: typeof IncomingMessage.Type,
  thread: Pick<StoredThread, 'id' | 'audience'>,
) {
  const attachments =
    sent.attachments === undefined
      ? []
      : yield* decodeCandidates(sent.attachments).pipe(
          Effect.mapError(
            () =>
              new InvalidAttachment({ message: 'Pictures must be sent as an attachment list.' }),
          ),
        )
  if (attachments.length > 0 && thread.audience !== 'private')
    return yield* new PicturesRequirePrivateThread({
      threadId: thread.id,
      message: 'Pictures can only be sent in a private thread for now.',
    })
  if (attachments.length > 4)
    return yield* new TooManyAttachments({ message: 'Send at most four pictures in one message.' })
  return yield* Effect.forEach(attachments, (attachment) => checkedAttachment(attachment))
})

/** Canonical base64, MIME, filename and order all belong to the immutable keyed message. */
export const messageFingerprint = (body: string, attachments: ReadonlyArray<MessageAttachment>) =>
  NodeCrypto.createHash('sha256')
    .update(
      JSON.stringify([
        body,
        attachments.map((attachment) => [
          attachment.type,
          attachment.mimeType,
          attachment.data,
          attachment.filename === undefined ? null : attachment.filename,
        ]),
      ]),
    )
    .digest('hex')
