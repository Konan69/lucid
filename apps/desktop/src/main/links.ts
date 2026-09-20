import * as Array from 'effect/Array'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'

export const VIVID_PROTOCOL = 'vivid'

/** A validated Vivid activation target. Query data is intentionally not accepted yet. */
export const VividDeepLink = Schema.Struct({
  host: Schema.String.check(Schema.isNonEmpty({ message: 'Expected a deep-link host' })),
  path: Schema.String,
})
export interface VividDeepLink extends Schema.Schema.Type<typeof VividDeepLink> {}

/** The supplied activation is malformed or belongs to another protocol. */
export class InvalidDeepLink extends Schema.TaggedError<InvalidDeepLink>()(
  'InvalidDeepLink',
  { url: Schema.String },
  { title: 'Invalid Vivid deep link' },
) {}

/**
 * Parse one operating-system activation without allowing URL constructor failures to escape.
 * A host is required so `vivid:///path` cannot become an ambiguous product route.
 */
export const parseVividUrl = Effect.fn('DesktopLinks.parse')(function* (url: string) {
  const parsed = yield* Effect.try({
    try: () => new URL(url),
    catch: () => new InvalidDeepLink({ url }),
  })
  if (
    parsed.protocol !== `${VIVID_PROTOCOL}:` ||
    parsed.host.length === 0 ||
    parsed.search.length > 0 ||
    parsed.hash.length > 0
  ) {
    return yield* new InvalidDeepLink({ url })
  }
  return VividDeepLink.make({ host: parsed.host, path: parsed.pathname })
})

/**
 * Parse process arguments as optional activations. Ordinary Electron and Chromium arguments are
 * expected noise, so invalid values are discarded only here rather than weakening the parser.
 */
export const vividUrlsFromArguments = Effect.fn('DesktopLinks.fromArguments')(function* (
  arguments_: ReadonlyArray<string>,
) {
  const links = yield* Effect.forEach(arguments_, (argument) =>
    parseVividUrl(argument).pipe(Effect.option),
  )
  return Array.getSomes(links)
})
