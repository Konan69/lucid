import type { UserInput } from '@earendil-works/pi-durable'
import type { TextContent, ImageContent } from '@earendil-works/pi-ai'
import { Effect, Option, Predicate, Schema } from 'effect'

import { LimitInvalid, PartTooLarge, PartUnsupported, TurnInvalid } from './errors.ts'
import { base64Head, base64Size } from './base64.ts'
import { imageMatches } from './images.ts'

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
/** Host policy, in decoded bytes per image. Supply a nonnegative integer; absence imposes no bound. */
export type InputOptions = { readonly maxPartBytes?: number }

/** Absence is explicit after the host ingress; every internal consumer sees a valid byte policy. */
export const PartLimit = Schema.TaggedUnion({
  Unbounded: {},
  Bounded: {
    bytes: Schema.Number.check(Schema.isFinite(), Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  },
})
export type PartLimit = typeof PartLimit.Type
const Options = Schema.Struct({
  maxPartBytes: Schema.optionalKey(PartLimit.cases.Bounded.fields.bytes),
})
const decodeOptions = Schema.decodeUnknownEffect(Options)

/** Validate host options once at a public input seam, never recover them as a client HTTP error. */
export const inputLimit: (options: InputOptions) => Effect.Effect<PartLimit, LimitInvalid> =
  Effect.fn('Durable.inputLimit')(function* (options) {
    const decoded = yield* decodeOptions(options).pipe(
      Effect.mapError(
        () =>
          new LimitInvalid({
            value: options.maxPartBytes,
          }),
      ),
    )
    return decoded.maxPartBytes === undefined
      ? PartLimit.cases.Unbounded.make({})
      : PartLimit.cases.Bounded.make({ bytes: decoded.maxPartBytes })
  })

/** Empty text beside a file is valid SDK input; admission omits it from the persisted Pi content. */
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

type FilePart = Extract<InputPart, { type: 'file' }>

/** Only inline base64 images map to Pi's input. Never fetch a URL or discard unsupported files. */
const image = Effect.fn('Durable.imageInput')(function* (part: FilePart, options: PartLimit) {
  const prefix = `data:${part.mediaType};base64,`
  if (!part.url.startsWith(prefix)) return yield* new PartUnsupported({ mediaType: part.mediaType })
  const bytes = base64Size(part.url, prefix.length)
  if (Option.isNone(bytes)) return yield* new PartUnsupported({ mediaType: part.mediaType })
  if (!imageMatches(base64Head(part.url, prefix.length), part.mediaType))
    return yield* new PartUnsupported({ mediaType: part.mediaType })
  if (PartLimit.guards.Bounded(options) && bytes.value > options.bytes)
    return yield* new PartTooLarge({ bytes: bytes.value, limit: options.bytes })
  const data = {
    mimeType: part.mediaType,
    data: part.url.slice(prefix.length),
  }
  return part.filename === undefined
    ? StoredImage.make({ type: 'image', ...data })
    : StoredImage.make({ type: 'image', ...data, filename: part.filename })
})

/** One SDK part becomes exactly one native Pi block in the same position. */
function toContent(
  part: InputPart,
  options: PartLimit,
): Effect.Effect<TextContent | ImageContent, PartUnsupported | PartTooLarge> {
  return part.type === 'text'
    ? Effect.succeed({ type: 'text', text: part.text })
    : image(part, options)
}

/** Validate the complete input before opening observation or submitting anything to Pi. */
export const inputContent: (
  content: string | readonly InputPart[],
  options: PartLimit,
) => Effect.Effect<UserInput, PartUnsupported | PartTooLarge | TurnInvalid> = Effect.fn(
  'Durable.inputContent',
)(function* (
  content: string | readonly InputPart[],
  options: PartLimit,
): Effect.fn.Return<UserInput, PartUnsupported | PartTooLarge | TurnInvalid> {
  if (Predicate.isString(content)) return content
  const parts = yield* InputParts.makeEffect(content).pipe(
    Effect.mapError(() => new TurnInvalid({})),
  )
  return yield* Effect.forEach(
    parts.filter((part) => part.type === 'file' || part.text.length > 0),
    (part) => toContent(part, options),
  )
})
