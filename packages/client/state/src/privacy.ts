import { Option, Schema } from 'effect'

/**
 * What an error report may carry to Sentry, as an allowlist, decided once for the browser, the
 * phone and the desktop app: `report` builds a new report from the named parts of the one the SDK
 * made and leaves everything else behind. A denylist would let through whatever a later SDK
 * version starts collecting; this cannot.
 *
 * What goes: which kind of error it was, where in the code it happened, which build and which
 * system it happened on. What never goes: anything a Person wrote or was shown. That is why the
 * error's message is dropped too. A decoding failure quotes the value it could not decode
 * (Effect's `SchemaError` prints the offending input), so a message can hold a Thread's text. The
 * message is still read where it is safe: each app's `fault.ts` sends it to Vivid's own server.
 *
 * Each app used to keep this whole file, and a change to what may leave was made three times.
 * The policy is here now. What stays in each app is its `scrub.ts`, which is only the installed
 * SDK's side of it: the hooks typed by that SDK's events, its envelopes and its transport. The
 * phone's SDK is built on `@sentry/core` 10.75.2 and the other two on 11.1.0, so this module
 * imports neither. It names the parts of a report it reads and the parts it lets leave as its own
 * types, which both versions' events fit, and passes through the two values it keeps whole
 * (`Level`, `Sdk`) as whatever the caller's SDK says they are.
 *
 * It is enforced twice in each app. `report` and `breadcrumb` are behind the SDK's `beforeSend`
 * and `beforeBreadcrumb`. Each app's `guarded` then wraps the SDK's transport, the one place
 * everything that leaves has to pass, and runs `report` again there: the SDK adds attachments to
 * a report after `beforeSend`, and sends its own internal errors without calling it (`sendEvent`
 * and `_processEvent` in `@sentry/core` `client.js`), so the hooks alone are not the whole way
 * out.
 */

/**
 * A part of a report the SDKs type loosely: a tag, a context and a breadcrumb's data can hold
 * anything, so all that is said of one is that it is an object. It is never copied. It is
 * decoded through the schema of what may leave.
 */
type Loose = object

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
const RequestData = Schema.Struct({
  method: text,
  status_code: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 100, maximum: 599 })),
  ),
  url: text,
})

/** What a breadcrumb for a move between screens keeps of its data. */
const Move = Schema.Struct({ from: text, to: text })

const tags = Schema.decodeUnknownOption(Tags)
const contexts = Schema.decodeUnknownOption(Contexts)
const requested = Schema.decodeUnknownOption(RequestData)
const moved = Schema.decodeUnknownOption(Move)

/** An address without its query or fragment: where a request went, not what it asked for. */
const withoutQuery = (address: string): string => {
  const cut = address.search(/[?#]/u)
  return cut === -1 ? address : address.slice(0, cut)
}

/** The scheme and the authority of an address: `https://name:password@host:port`. */
const ORIGIN = /^[a-z][a-z0-9+.-]*:\/\/[^/]*/iu

/**
 * Where a Person's own folders end and the app begins, in the paths a report can hold. Each
 * matches from the start of a path to the end of the part that is not the app's:
 * - a home folder (`/Users/NAME/`, `/home/NAME/`, `C:/Users/NAME/`), which is the Person's name;
 * - an Android app's data folder (`/data/user/0/PACKAGE/`);
 * - an app bundle (`.../Vivid.app/`), whose path on a phone holds an install id;
 * - the desktop app's archive (`.../resources/app.asar/`).
 * They are applied in this order and each cuts what the one before left, so a path inside all of
 * them ends as its place in the archive.
 */
const ROOTS = [
  /^.*\/(?:Users|home)\/[^/]+\//iu,
  /^.*\/data\/(?:user\/\d+|data)\/[^/]+\//u,
  /^.*\.app\//u,
  /^.*app\.asar(?:\.unpacked)?\//u,
]

/**
 * Where something is in the app, and nothing about whose machine or which server it is on: an
 * address loses its query and fragment, then its scheme, credentials and host, then every folder
 * down to the app's own (`ROOTS`). A Windows path is read with forward slashes first. What is
 * left names a file of the build, which is the same on every machine.
 *
 * Every address and path in a report goes through this: a frame's file and module, a debug
 * image's file, the page's address and a breadcrumb's.
 */
export const place = (address: string): string =>
  ROOTS.reduce(
    (path, root) => path.replace(root, ''),
    withoutQuery(address).replaceAll('\\', '/').replace(ORIGIN, ''),
  )

/** The same for an address the SDK may have left out, which stays left out. */
const bare = ({ address }: { readonly address?: string }) =>
  Option.getOrUndefined(Option.map(Option.fromUndefinedOr(address), place))

/**
 * One stack frame as it leaves: where it is and what it is called. These fields are the
 * allowlist. The source lines around a frame and the values of its local variables are not
 * named, so they are left behind; the addresses stay, because a native frame is only turned back
 * into a name from them.
 */
type Frame = {
  readonly filename?: string
  readonly abs_path?: string
  readonly function?: string
  readonly module?: string
  readonly platform?: string
  readonly lineno?: number
  readonly colno?: number
  readonly in_app?: boolean
  readonly instruction_addr?: string
  readonly addr_mode?: string
  readonly debug_id?: string
}

/** How an error was caught. Its free-form `data` is not named. */
type Mechanism = {
  readonly type: string
  readonly handled?: boolean
  readonly synthetic?: boolean
  readonly source?: string
  readonly is_exception_group?: boolean
  readonly exception_id?: number
  readonly parent_id?: number
}

/**
 * One exception: its type, its stack and how it was caught. Its `value` is the error's message
 * and is not named (see the top of this file).
 */
type Exception = {
  readonly type?: string
  readonly module?: string
  readonly thread_id?: number | string
  readonly mechanism?: Mechanism
  readonly stacktrace?: { readonly frames?: Array<Frame> }
}

/**
 * One loaded file a frame can belong to, cut to what turns a frame back into a name: which kind
 * it is, its debug id, where it was loaded (native code only) and its place in the app.
 */
type Image =
  | { readonly type: 'sourcemap'; readonly debug_id: string; readonly code_file: string }
  | {
      readonly type: 'macho'
      readonly debug_id: string
      readonly image_addr: string
      readonly image_size?: number
      readonly code_file?: string
    }

/** An image as the SDK reports it. `wasm` is a kind Vivid does not load, and it is left out. */
type ImageSeen = Image | { readonly type: 'wasm' }

/** A breadcrumb as the SDK reports it, at the level its own SDK gives it. */
type CrumbSeen<Level extends string> = {
  readonly type?: string
  readonly category?: string
  readonly level?: Level
  readonly timestamp?: number
  readonly data?: Loose
}

/** A breadcrumb as it leaves: what kind it is and when, and for the two kept kinds their data. */
type Crumb<Level extends string> = {
  readonly type?: string
  readonly category?: string
  readonly level?: Level
  readonly timestamp?: number
  readonly data?:
    | { readonly method?: string; readonly status_code?: number; readonly url?: string }
    | { readonly from?: string; readonly to?: string }
}

/** The page's request as the SDK reports it: only the parts this reads. */
type PageSeen = {
  readonly url?: string
  readonly headers?: { readonly [key: string]: string }
}

/**
 * The parts of an SDK's event that `report` reads. Both installed versions' events fit it, with
 * `Level` their severity and `Sdk` their own description of themselves. Everything else an event
 * holds (the user, the extras, the message, the transaction) is not named and so is never read.
 */
type Reported<Level extends string, Sdk extends object> = {
  readonly event_id?: string
  readonly timestamp?: number
  readonly level?: Level
  readonly platform?: string
  readonly release?: string
  readonly dist?: string
  readonly environment?: string
  readonly sdk?: Sdk
  readonly fingerprint?: ReadonlyArray<string>
  readonly debug_meta?: { readonly images?: ReadonlyArray<ImageSeen> }
  readonly exception?: { readonly values?: ReadonlyArray<Exception> }
  readonly breadcrumbs?: ReadonlyArray<CrumbSeen<Level>>
  readonly tags?: Loose
  readonly contexts?: Loose
  readonly request?: PageSeen
}

/**
 * The report that leaves: every field it can have. `type` is always absent, which is what the
 * SDKs call an error report. Arrays are plain arrays because that is what the SDKs' own event
 * types ask for.
 */
type Report<Level extends string, Sdk extends object> = {
  readonly type: undefined
  readonly event_id?: string
  readonly timestamp?: number
  readonly level?: Level
  readonly platform?: string
  readonly release?: string
  readonly dist?: string
  readonly environment?: string
  readonly sdk?: Sdk
  readonly fingerprint?: Array<string>
  readonly debug_meta?: { readonly images?: Array<Image> }
  readonly exception?: { readonly values?: Array<Exception> }
  readonly breadcrumbs?: Array<Crumb<Level>>
  readonly tags?: typeof Tags.Type
  readonly contexts?: typeof Contexts.Type
  readonly request?: {
    readonly url?: string
    readonly headers?: { readonly 'User-Agent': string }
  }
}

/** One stack frame, rebuilt from its named fields with every address cut to its place. */
const frame = (from: Frame): Frame => ({
  filename: bare({ address: from.filename }),
  abs_path: bare({ address: from.abs_path }),
  function: from.function,
  module: bare({ address: from.module }),
  platform: from.platform,
  lineno: from.lineno,
  colno: from.colno,
  in_app: from.in_app,
  instruction_addr: from.instruction_addr,
  addr_mode: from.addr_mode,
  debug_id: from.debug_id,
})

/** One exception, rebuilt without its message and without the mechanism's free-form data. */
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
 * (its method, its status and where in the app it went, `place`) and a move between screens (the
 * two places). Every other kind is dropped whole, because its text is the
 * Person's: a console line prints what the app was handling, and a click is named by the label of
 * what was pressed, which can be a Thread's title.
 *
 * It is behind each SDK's `beforeBreadcrumb`, and `report` applies it again to whatever a report
 * carries, since native breadcrumbs join a report without passing the first.
 */
export const breadcrumb = <Level extends string>(from: CrumbSeen<Level>): Crumb<Level> | null => {
  const kept: Crumb<Level> = {
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
 * behind, and the page's address is cut to its place in the app (`place`).
 */
const page = (from: PageSeen) => {
  const agent = from.headers === undefined ? undefined : from.headers['User-Agent']
  return {
    url: bare({ address: from.url }),
    headers: agent === undefined ? undefined : { 'User-Agent': agent },
  }
}

/** The one fingerprint the SDK writes itself: group this report the way Sentry would anyway. */
const DEFAULT_FINGERPRINT = '{{ default }}'

/**
 * A fingerprint is free text that code chooses to group reports by, so it can be anything: an
 * email, a Thread's title. Only one made of nothing but the SDK's default marker is kept.
 */
const fingerprint = (from: ReadonlyArray<string>) =>
  from.every((part) => part === DEFAULT_FINGERPRINT) ? [...from] : undefined

/** One loaded file, rebuilt from its kind. A kind this does not name is left out. */
const image = (from: ImageSeen): ReadonlyArray<Image> => {
  if (from.type === 'sourcemap')
    return [{ type: 'sourcemap', debug_id: from.debug_id, code_file: place(from.code_file) }]
  if (from.type === 'macho')
    return [
      {
        type: 'macho',
        debug_id: from.debug_id,
        image_addr: from.image_addr,
        image_size: from.image_size,
        code_file: bare({ address: from.code_file }),
      },
    ]
  return []
}

/**
 * The report that leaves, built from the allowed parts of the one the SDK made. The user, the
 * extras, the message, the request's body, cookies and headers, and anything this function does
 * not name are not copied, so they are gone.
 *
 * It is behind each SDK's `beforeSend`. It takes any event and always returns an error report,
 * because each app's `guarded` runs it again over whatever reaches the transport.
 *
 * No message leaves from here. The desktop app lets one sentence through, which its own SDK
 * writes; that exception is the desktop's and is made in its `scrub.ts`, on top of this.
 */
export const report = <Level extends string, Sdk extends object>(
  event: Reported<Level, Sdk>,
): Report<Level, Sdk> => ({
  type: undefined,
  event_id: event.event_id,
  timestamp: event.timestamp,
  level: event.level,
  platform: event.platform,
  release: event.release,
  dist: event.dist,
  environment: event.environment,
  sdk: event.sdk,
  fingerprint: event.fingerprint === undefined ? undefined : fingerprint(event.fingerprint),
  debug_meta:
    event.debug_meta === undefined
      ? undefined
      : {
          images:
            event.debug_meta.images === undefined
              ? undefined
              : event.debug_meta.images.flatMap(image),
        },
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
          const kept = breadcrumb(crumb)
          return kept === null ? [] : [kept]
        }),
  tags: Option.getOrUndefined(tags(event.tags)),
  contexts: Option.getOrUndefined(contexts(event.contexts)),
  request: event.request === undefined ? undefined : page(event.request),
})

/**
 * What of an envelope's header may leave: its id, its time, where it is going and which SDK made
 * it. An envelope is how an SDK sends everything, and each app's `scrub.ts` keeps only the error
 * reports in one (`outbound`); this is the header they then travel under. The header's `trace`
 * is not named: it names the screen a trace started on, and Vivid sends no traces.
 *
 * Its id and its time are required, as they are in both installed SDKs' header for an envelope
 * that carries a report (`EventEnvelopeHeaders` in `@sentry/core` `types/envelope.d.ts`, 10.75.2
 * and 11.1.0), so the answer is that SDK's own header again. They are named here as they are
 * there: reading them off a header that is only known to extend an optional shape would type the
 * id as possibly absent, which no SDK's event envelope accepts. `Sdk` is the caller's SDK's own
 * description of itself, passed through as it is in `report`.
 */
export const envelopeHeader = <Sdk extends object>(from: {
  readonly event_id: string
  readonly sent_at: string
  readonly dsn?: string
  readonly sdk?: Sdk
}) => ({ event_id: from.event_id, sent_at: from.sent_at, dsn: from.dsn, sdk: from.sdk })
