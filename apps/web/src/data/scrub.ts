import type { Breadcrumb, ErrorEvent, Exception, StackFrame } from '@sentry/react'
import { Option, Schema } from 'effect'

/**
 * What an error report may carry to Sentry, as an allowlist: `scrub` builds a new report from the
 * named parts of the one the SDK made and leaves everything else behind. A denylist would let
 * through whatever a later SDK version starts collecting; this cannot.
 *
 * What goes: which kind of error it was, where in the code it happened, which build and which
 * system it happened on. What never goes: anything a Person wrote or was shown. That is why the
 * error's message is dropped too. A decoding failure quotes the value it could not decode
 * (Effect's `SchemaError` prints the offending input), so a message can hold a Thread's text. The
 * message is still read where it is safe: `fault.ts` sends it to Vivid's own server.
 *
 * The mobile and desktop apps keep their own copy of this file (`apps/mobile/src/data/scrub.ts`,
 * `apps/desktop/src/main/scrub.ts`), because each is typed by its own SDK's events. A change to
 * what may leave is made in all three.
 */

/** One field of a context or a breadcrumb that may leave: a name, a version, an address. */
const text = Schema.optionalKey(Schema.String)
/** One field that may leave and is a yes or a no. */
const flag = Schema.optionalKey(Schema.Boolean)
/** A context that is only a name and a version: a runtime, a browser. */
const named = Schema.optionalKey(Schema.Struct({ name: text, version: text }))

/**
 * The tags a report keeps: which process and which over-the-air update it came from. The SDKs set
 * these themselves (`event.process` in `@sentry/electron`, `expo.updates.*` in
 * `@sentry/react-native`'s `expoContextIntegration`).
 *
 * This and the schemas below are how the allowlist is enforced on the parts of a report the SDK
 * types loosely (a tag, a context and a breadcrumb's data can hold anything): each part is
 * decoded through the schema of what may leave, which keeps the named fields and leaves every
 * other one behind. A part that does not decode is left out whole.
 */
const Tags = Schema.Struct({
  'event.process': text,
  'event.origin': text,
  'event.environment': text,
  'expo.updates.update_id': text,
  'expo.updates.channel': text,
  'expo.updates.runtime_version': text,
})

/**
 * The parts of each context a report keeps. Contexts describe the system, but not only the
 * system: `device.name` is what the Person called their phone, so each context is cut to the
 * fields that describe a model or a version.
 */
const Contexts = Schema.Struct({
  os: Schema.optionalKey(
    Schema.Struct({ name: text, version: text, build: text, kernel_version: text }),
  ),
  device: Schema.optionalKey(
    Schema.Struct({
      family: text,
      model: text,
      model_id: text,
      arch: text,
      manufacturer: text,
      brand: text,
      simulator: flag,
    }),
  ),
  app: Schema.optionalKey(
    Schema.Struct({
      app_name: text,
      app_version: text,
      app_build: text,
      app_identifier: text,
      build_type: text,
    }),
  ),
  runtime: named,
  browser: named,
  chrome: named,
  node: named,
  react_native_context: Schema.optionalKey(
    Schema.Struct({
      js_engine: text,
      hermes_version: text,
      react_native_version: text,
      fabric: flag,
    }),
  ),
  ota_updates: Schema.optionalKey(
    Schema.Struct({
      update_id: text,
      channel: text,
      runtime_version: text,
      is_embedded_launch: flag,
      is_emergency_launch: flag,
    }),
  ),
})

/** What a request breadcrumb keeps of its data. Its sizes and its separate query field are not named. */
const Request = Schema.Struct({
  method: text,
  status_code: Schema.optionalKey(Schema.Number),
  url: text,
})

/** What a breadcrumb for a move between screens keeps of its data. */
const Move = Schema.Struct({ from: text, to: text })

const tags = Schema.decodeUnknownOption(Tags)
const contexts = Schema.decodeUnknownOption(Contexts)
const requested = Schema.decodeUnknownOption(Request)
const moved = Schema.decodeUnknownOption(Move)

/** An address without its query or fragment: where a request went, not what it asked for. */
export const withoutQuery = (address: string): string => {
  const cut = address.search(/[?#]/u)
  return cut === -1 ? address : address.slice(0, cut)
}

/** The same for an address the SDK may have left out, which stays left out. */
const bare = ({ address }: { readonly address?: string }) =>
  Option.getOrUndefined(Option.map(Option.fromUndefinedOr(address), withoutQuery))

/**
 * One stack frame: where it is and what it is called. The source lines around it and the values
 * of its local variables are left behind; the addresses stay, because a native frame is only
 * turned back into a name from them.
 */
const frame = (from: StackFrame): StackFrame => ({
  filename: bare({ address: from.filename }),
  abs_path: bare({ address: from.abs_path }),
  function: from.function,
  module: from.module,
  platform: from.platform,
  lineno: from.lineno,
  colno: from.colno,
  in_app: from.in_app,
  instruction_addr: from.instruction_addr,
  addr_mode: from.addr_mode,
  debug_id: from.debug_id,
})

/**
 * One exception: its type, its stack and how it was caught. Its `value` is the error's message
 * and is left behind (see the top of this file), and so is the mechanism's free-form `data`.
 */
const exception = (from: Exception): Exception => ({
  type: from.type,
  module: from.module,
  thread_id: from.thread_id,
  mechanism:
    from.mechanism === undefined
      ? undefined
      : {
          type: from.mechanism.type,
          handled: from.mechanism.handled,
          synthetic: from.mechanism.synthetic,
          source: from.mechanism.source,
          is_exception_group: from.mechanism.is_exception_group,
          exception_id: from.mechanism.exception_id,
          parent_id: from.mechanism.parent_id,
        },
  stacktrace:
    from.stacktrace === undefined
      ? undefined
      : {
          frames:
            from.stacktrace.frames === undefined ? undefined : from.stacktrace.frames.map(frame),
        },
})

/** The categories the SDKs give a request breadcrumb: the browser's two, and the phone's native one. */
const REQUESTS = new Set(['fetch', 'xhr', 'http'])

/**
 * One breadcrumb, or null when nothing of it may leave. Two kinds are kept, cut down: a request
 * (its method, its status and its address without the query) and a move between screens (the two
 * addresses without their queries). Every other kind is dropped whole, because its text is the
 * Person's: a console line prints what the app was handling, and a click is named by the label of
 * what was pressed, which can be a Thread's title.
 *
 * It is the SDK's `beforeBreadcrumb`, and `scrub` applies it again to whatever a report carries,
 * since native breadcrumbs join a report without passing the first.
 */
export const scrubBreadcrumb = (from: Breadcrumb): Breadcrumb | null => {
  const kept = {
    type: from.type,
    category: from.category,
    level: from.level,
    timestamp: from.timestamp,
  }
  if (from.category !== undefined && REQUESTS.has(from.category))
    return Option.match(requested(from.data), {
      onNone: () => kept,
      onSome: ({ method, status_code, url }) => ({
        ...kept,
        data: { method, status_code, url: bare({ address: url }) },
      }),
    })
  if (from.category === 'navigation')
    return Option.match(moved(from.data), {
      onNone: () => kept,
      onSome: (data) => ({
        ...kept,
        data: { from: bare({ address: data.from }), to: bare({ address: data.to }) },
      }),
    })
  return null
}

/**
 * The browser's own description of itself, which is the only thing Sentry can tell the system
 * from on the web. Every other header, the cookies and the body of the page's request are left
 * behind, and the page's address loses its query.
 */
const request = (from: NonNullable<ErrorEvent['request']>): ErrorEvent['request'] => {
  const agent = from.headers === undefined ? undefined : from.headers['User-Agent']
  return {
    url: bare({ address: from.url }),
    headers: agent === undefined ? undefined : { 'User-Agent': agent },
  }
}

/**
 * The SDK's `beforeSend`: the report that leaves, built from the allowed parts of the one the SDK
 * made. The user, the extras, the message, the request's body, cookies and headers, and anything
 * this function does not name are not copied, so they are gone.
 */
export const scrub = (event: ErrorEvent): ErrorEvent => ({
  type: undefined,
  event_id: event.event_id,
  timestamp: event.timestamp,
  level: event.level,
  platform: event.platform,
  release: event.release,
  dist: event.dist,
  environment: event.environment,
  sdk: event.sdk,
  fingerprint: event.fingerprint,
  // Which loaded files the frames belong to: their debug ids and load addresses, nothing else.
  debug_meta: event.debug_meta,
  exception:
    event.exception === undefined
      ? undefined
      : {
          values:
            event.exception.values === undefined
              ? undefined
              : event.exception.values.map(exception),
        },
  breadcrumbs:
    event.breadcrumbs === undefined
      ? undefined
      : event.breadcrumbs.flatMap((crumb) => {
          const kept = scrubBreadcrumb(crumb)
          return kept === null ? [] : [kept]
        }),
  tags: Option.getOrUndefined(tags(event.tags)),
  contexts: Option.getOrUndefined(contexts(event.contexts)),
  request: event.request === undefined ? undefined : request(event.request),
})
