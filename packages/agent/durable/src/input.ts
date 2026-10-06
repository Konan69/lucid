import type { UserInput } from '@earendil-works/pi-durable'
import type { TextContent, ImageContent } from '@earendil-works/pi-ai'
import { Effect, Option, Predicate, Schema } from 'effect'

import { PartUnsupported, TurnInvalid } from './errors.ts'
import { base64Size } from './base64.ts'

/** Ordered SDK user content; a file remains explicit until admission validates its representation. */
export const InputPart = Schema.Union([
  Schema.Struct({
    type: Schema.Literal('text'),
    text: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal('file'),
    mediaType: Schema.String,
    url: Schema.String,
    filename: Schema.optionalKey(Schema.String),
  }),
])
export type InputPart = typeof InputPart.Type
/** Keep empty text blocks in order beside meaningful input, without admitting an empty chat turn. */
export const InputParts = Schema.Array(InputPart).check(
  Schema.isMinLength(1),
  Schema.makeFilter((parts) =>
    parts.some((part) => part.type === 'file' || part.text.length > 0)
      ? undefined
      : 'Expected text or a file',
  ),
)

/**
 * Pi ImageContent owns data/mimeType. Filename is bridge metadata on that same JSON block:
 * harness/submissions.js:142/168 copies input unchanged into pi.user, including through the inbox.
 * Providers consume only the native image fields. No second document or transcript is created.
 */
export const StoredImage = Schema.Struct({
  type: Schema.Literal('image'),
  data: Schema.String,
  mimeType: Schema.String,
  filename: Schema.optionalKey(Schema.String),
})
export const decodeStoredImage = Schema.decodeUnknownSync(StoredImage)

const ImageData = Schema.Struct({
  mimeType: Schema.String.check(Schema.isPattern(/^image\/[a-zA-Z0-9.+-]+$/u)),
  data: Schema.String,
})
type FilePart = Extract<InputPart, { type: 'file' }>

/** Only inline base64 images map to Pi's input. Never fetch a URL or discard unsupported files. */
const image = Effect.fn('Durable.imageInput')(function* (part: FilePart) {
  const prefix = `data:${part.mediaType};base64,`
  if (!part.url.startsWith(prefix) || Option.isNone(base64Size(part.url, prefix.length)))
    return yield* new PartUnsupported({ mediaType: part.mediaType })
  const data = yield* ImageData.makeEffect({
    mimeType: part.mediaType,
    data: part.url.slice(prefix.length),
  }).pipe(Effect.mapError(() => new PartUnsupported({ mediaType: part.mediaType })))
  return part.filename === undefined
    ? StoredImage.make({ type: 'image', ...data })
    : StoredImage.make({ type: 'image', ...data, filename: part.filename })
})

/** One SDK part becomes exactly one native Pi block in the same position. */
function toContent(part: InputPart): Effect.Effect<TextContent | ImageContent, PartUnsupported> {
  return part.type === 'text' ? Effect.succeed({ type: 'text', text: part.text }) : image(part)
}

/** Validate the complete input before opening observation or submitting anything to Pi. */
export const inputContent = Effect.fn('Durable.inputContent')(function* (
  content: string | readonly InputPart[],
): Effect.fn.Return<UserInput, PartUnsupported | TurnInvalid> {
  if (Predicate.isString(content)) return content
  const parts = yield* InputParts.makeEffect(content).pipe(
    Effect.mapError(() => new TurnInvalid({})),
  )
  return yield* Effect.forEach(parts, toContent)
})
