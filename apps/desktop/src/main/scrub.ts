import type {
  Breadcrumb,
  DebugImage,
  Envelope,
  ErrorEvent,
  Event,
  EventEnvelope,
  EventItem,
  Exception,
  SdkInfo,
  StackFrame,
  Transport,
} from '@sentry/core'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import * as SchemaGetter from 'effect/SchemaGetter'
import { FILES, INTEGRATIONS, MESSAGES, PLACES, type Allowed } from './allowed.ts'

/**
 * What an error report may carry to Sentry, as an allowlist: `scrub` builds a new report from the
 * named parts of the one the SDK made and leaves everything else behind.
 *
 * Every string that is kept is kept by its shape, never by having the bad parts cut out of it.
 * A value either is one of a closed set of words, or matches the shape of a thing that cannot be
 * a Person's words (a version, a hex id, a file of this build, one of the app's own routes), or
 * it becomes `REMOVED`. Cutting out what is known to be bad kept losing to inputs nobody had
 * listed: a network share, an escaped slash, a folder outside the home folder. A shape has no
 * such list to fall behind.
 *
 * What goes: which kind of error it was, where in the code it happened, which build and which
 * system it happened on. What never goes: anything a Person wrote or was shown. That is why the
 * error's message is dropped too. A decoding failure quotes the value it could not decode
 * (Effect's `SchemaError` prints the offending input), so a message can hold a Thread's text. The
 * message is still read where it is safe: the window's `fault.ts` sends it to Vivid's own server.
 *
 * The closed sets that are this app's own (the files its build makes, its routes, the SDK
 * integrations it turns on) are in `allowed.ts`. Each of the three apps has its own `allowed.ts`
 * and its own copy of this file, typed by its own SDK's events; what is written here is the same
 * in all three (`apps/web/src/data`, `apps/mobile/src/data`, `apps/desktop/src/main`).
 *
 * It is enforced twice. `scrub` and `scrubBreadcrumb` are the SDK's `beforeSend` and
 * `beforeBreadcrumb`. `guarded` then wraps the SDK's transport, the one place everything that
 * leaves has to pass: the SDK adds attachments to a report after `beforeSend`, and sends its own
 * internal errors without calling it (`sendEvent` and `_processEvent` in `@sentry/core`
 * `client.js`), so the hooks alone are not the whole way out.
 */

/** What stands in a report where a value was that did not have a shape that may leave. */
export const REMOVED = '[removed]'

/** The longest address or path that is read at all. Nothing of the build is near it. */
const LONGEST = 2048

/** A shape that is exactly one of a closed list of words. */
const oneOf = (words: ReadonlyArray<string>) =>
  new RegExp(
    `^(?:${words.map((word) => word.replaceAll(/[.*+?^${}()|[\]\\]/gu, '\\$&')).join('|')})$`,
    'u',
  )

/**
 * The shapes a kept value can have. None of them has room for a sentence: each is a closed list,
 * a number with dots, a run of hex, or one short token without a space.
 */
const FORMS = {
  /** A version: numbers and dots, then at most a short build suffix. `19.1`, `0.2.0+1`, `44.4.3`. */
  version: /^\d{1,5}(?:\.\d{1,8}){0,3}(?:[-+][0-9A-Za-z.]{1,24})?$/u,
  /** An id written in hex, with or without the dashes of a UUID. */
  hex: /^[0-9a-fA-F-]{8,40}$/u,
  /** A memory address. */
  address: /^0x[0-9a-fA-F]{1,16}$/u,
  /** How a frame's address is to be read: absolute, or relative to a numbered image. */
  mode: /^(?:abs|rel:\d{1,4})$/u,
  /** One token with no space: a hardware model code (`iPhone17,1`), a build number (`23A341`). */
  token: /^[A-Za-z0-9][A-Za-z0-9,._-]{0,31}$/u,
  /**
   * A name out of code: a function, a module, the class of an error. Letters, digits and the
   * marks minified and async frames use (`Object.<anonymous>`, `async App`, `a$1`), or the single
   * `?` the SDK writes for a function it could not name.
   */
  code: /^(?:[A-Za-z0-9_$.<>: ]{1,200}|\?)$/u,
  /** How an error was caught, as the SDK names it: `generic`, `auto.browser.global_handlers.onerror`. */
  mechanism: /^[A-Za-z0-9_.]{1,80}$/u,
  /** Which link of a chain of errors this is: `cause`, `errors[0]`. */
  source: /^[A-Za-z0-9_.[\]]{1,80}$/u,
  /** A release as the apps name theirs: a name, `@`, a version. `vivid-web@0.0.0+b3b26ca07f1c`. */
  release: /^[a-z][a-z0-9.-]{1,40}@\d{1,5}(?:\.\d{1,8}){0,3}(?:\+[0-9A-Za-z.]{1,24})?$/u,
  /** The SDK's own name and the packages it lists: `sentry.javascript.react`, `npm:@sentry/react`. */
  sdk: /^sentry\.[a-z.-]{1,60}$/u,
  package: /^(?:npm|cocoapods|maven|spm|carthage):[@A-Za-z0-9./:_-]{1,80}$/u,
  /** A Sentry project's address, which is public and names no Person. */
  dsn: /^https:\/\/[0-9a-f]{32}@o\d{1,20}\.ingest(?:\.[a-z]{2})?\.sentry\.io\/\d{1,20}$/u,
  /** A moment, as the SDK writes it in an envelope's header. */
  moment: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/u,
  level: oneOf(['fatal', 'error', 'warning', 'log', 'info', 'debug']),
  platform: oneOf(['javascript', 'node', 'native', 'cocoa', 'java', 'objc', 'other']),
  environment: oneOf(['production']),
  /** A breadcrumb's kind, for the two kinds that are kept. */
  crumb: oneOf(['http', 'navigation', 'default']),
  method: oneOf(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']),
  /** Which process a desktop report came from: the SDK's three words, then Electron's own list. */
  process: oneOf([
    'browser',
    'renderer',
    'utility',
    'Browser',
    'Tab',
    'Utility',
    'Zygote',
    'Sandbox helper',
    'GPU',
    'Pepper Plugin',
    'Pepper Plugin Broker',
    'Unknown',
  ]),
  origin: oneOf(['javascript', 'android', 'ios']),
  layer: oneOf(['javascript', 'native', 'java']),
  os: oneOf(['iOS', 'iPadOS', 'Android', 'macOS', 'Mac OS X', 'Windows', 'Linux', 'Darwin']),
  architecture: oneOf([
    'arm64',
    'arm64e',
    'arm',
    'armv7',
    'x64',
    'x86',
    'x86_64',
    'ia32',
    'arm64-v8a',
    'armeabi-v7a',
  ]),
  runtime: oneOf([
    'Electron',
    'Chrome',
    'Chromium',
    'Node',
    'node',
    'Hermes',
    'hermes',
    'jsc',
    'JavaScriptCore',
  ]),
  app: oneOf(['Vivid']),
  identifier: oneOf(['work.vivid.mobile', 'com.vivid.app']),
} as const

/** A value that has the shape, or `REMOVED`. */
const kept = (pattern: RegExp, value: string) => (pattern.test(value) ? value : REMOVED)

/** A level the SDK may have left out, kept when it is one of the SDK's own words for a level. */
const severity = ({ level }: Pick<Breadcrumb, 'level'>) =>
  Option.getOrUndefined(
    Option.filter(Option.fromUndefinedOr(level), (given) => FORMS.level.test(given)),
  )

/** The same for a value the SDK may have left out, which stays left out. */
const fitting = (pattern: RegExp, { value }: { readonly value?: string }) =>
  Option.getOrUndefined(
    Option.map(Option.fromUndefinedOr(value), (present) => kept(pattern, present)),
  )

/**
 * A field of something the SDK types loosely (a tag, a context, a breadcrumb's data can hold
 * anything): a string with the shape. A value that is there but is not such a string decodes to
 * `REMOVED`, and a field that is absent stays absent. An object decoded through a struct of these
 * keeps the named fields and nothing else.
 */
const field = (pattern: RegExp) => {
  const fits = Schema.decodeUnknownOption(Schema.String.check(Schema.isPattern(pattern)))
  return Schema.optionalKey(
    Schema.Unknown.pipe(
      Schema.decodeTo(Schema.String, {
        decode: SchemaGetter.transform((given) => Option.getOrElse(fits(given), () => REMOVED)),
        encode: SchemaGetter.passthrough(),
      }),
    ),
  )
}

/** A field that may leave and is a yes or a no. One that is anything else fails its struct. */
const flag = Schema.optionalKey(Schema.Boolean)

/** A context that is only a name and a version: a runtime, a browser. */
const named = Schema.optionalKey(
  Schema.Struct({ name: field(FORMS.runtime), version: field(FORMS.version) }),
)

/**
 * The tags a report keeps, each with the shape its value must have: which process and which
 * over-the-air update it came from. The SDKs set these themselves (`event.process` in
 * `@sentry/electron`, `event.origin` and `event.environment` in `@sentry/react-native`); the
 * phone app sets the three update tags (`telemetry.ts` there).
 */
const Tags = Schema.Struct({
  'event.process': field(FORMS.process),
  'event.origin': field(FORMS.origin),
  'event.environment': field(FORMS.layer),
  'expo.updates.update_id': field(FORMS.hex),
  'expo.updates.channel': field(FORMS.token),
  'expo.updates.runtime_version': field(FORMS.version),
})

/**
 * The parts of each context a report keeps. Contexts describe the system, but not only the
 * system: `device.name` is what the Person called their phone, and `os.kernel_version` is a
 * sentence. So each context is cut to the fields that are a model or a version, and each of
 * those is kept by its shape.
 */
const Contexts = Schema.Struct({
  os: Schema.optionalKey(
    Schema.Struct({
      name: field(FORMS.os),
      version: field(FORMS.version),
      build: field(FORMS.token),
    }),
  ),
  device: Schema.optionalKey(
    Schema.Struct({
      family: field(FORMS.token),
      model: field(FORMS.token),
      model_id: field(FORMS.token),
      arch: field(FORMS.architecture),
      manufacturer: field(FORMS.token),
      brand: field(FORMS.token),
      simulator: flag,
    }),
  ),
  app: Schema.optionalKey(
    Schema.Struct({
      app_name: field(FORMS.app),
      app_version: field(FORMS.version),
      app_build: field(FORMS.token),
      app_identifier: field(FORMS.identifier),
    }),
  ),
  runtime: named,
  browser: named,
  chrome: named,
  node: named,
  react_native_context: Schema.optionalKey(
    Schema.Struct({
      js_engine: field(FORMS.runtime),
      hermes_version: field(FORMS.version),
      react_native_version: field(FORMS.version),
      fabric: flag,
    }),
  ),
  ota_updates: Schema.optionalKey(
    Schema.Struct({
      update_id: field(FORMS.hex),
      channel: field(FORMS.token),
      runtime_version: field(FORMS.version),
      is_embedded_launch: flag,
      is_emergency_launch: flag,
    }),
  ),
})

/** What a request breadcrumb keeps of its data. Its address is read on its own, as a place. */
const Request = Schema.Struct({
  method: field(FORMS.method),
  status_code: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 100, maximum: 599 })),
  ),
})

/** An address in a breadcrumb's data: where a request went, or where a move started and ended. */
const Addresses = Schema.Struct({
  url: Schema.optionalKey(Schema.String),
  from: Schema.optionalKey(Schema.String),
  to: Schema.optionalKey(Schema.String),
})

const tags = Schema.decodeUnknownOption(Tags)
const contexts = Schema.decodeUnknownOption(Contexts)
const requested = Schema.decodeUnknownOption(Request)
const addressed = Schema.decodeUnknownOption(Addresses)

/** Reads an address the way it was before it was escaped. One that was never validly escaped has no reading. */
const unescaped = Option.liftThrowable(decodeURIComponent)

/** The scheme and the authority of an address: `https://name:password@host:port`. */
const ORIGIN = /^[a-z][a-z0-9+.-]*:\/\/[^/]*/iu

/**
 * An address made ready to be compared with the shapes it may have, or none when it cannot be
 * read: longer than anything of the build, or escaped wrongly. It is unescaped once, so a slash
 * written as `%2F` is a slash; a Windows path is read with forward slashes; and it is read up to
 * its query or fragment and from after its scheme and host, because the shapes are of paths.
 *
 * This is only how an address is read. Nothing it returns is kept: `located` keeps one of the
 * closed shapes, or nothing.
 */
const readable = (address: string) =>
  Option.map(
    Option.flatMap(
      Option.liftPredicate((given: string) => given.length <= LONGEST)(address),
      unescaped,
    ),
    (plain) =>
      plain
        .replaceAll('\\', '/')
        .replace(/[?#].*$/su, '')
        .replace(ORIGIN, ''),
  )

/**
 * One of the closed shapes for what it is given, or `REMOVED`. The first shape that the whole
 * address matches says what is kept, which is the shape's own canonical form (`Allowed` in
 * `allowed.ts`), so nothing is carried over from the address but what the shape names.
 */
const located = (allowed: ReadonlyArray<Allowed>, address: string): string =>
  Option.getOrElse(
    Option.flatMap(readable(address), (path) =>
      Option.map(
        Option.fromUndefinedOr(allowed.find(([pattern]) => pattern.test(path))),
        ([pattern, form]) => path.replace(pattern, form),
      ),
    ),
    () => REMOVED,
  )

/**
 * Where a frame or a loaded image is in the build: one of the files the build makes (`FILES`), or
 * `REMOVED`. A path on someone's machine, a network share, a file of some other program: none of
 * them is a file of the build, so none of them is kept, whatever folder it is in.
 */
export const file = (address: string): string => located(FILES, address)

/**
 * Where in the app a page or a request was: one of the app's own routes with every changing part
 * replaced (`PLACES`), or `REMOVED`. `/t/8f2c` is `/t/:id`; an address the app has no route for
 * is not kept, so a part of a path that is a name or an email has nowhere to stay.
 */
export const place = (address: string): string => located(PLACES, address)

/**
 * A report's message, when it is one of the sentences an SDK writes itself (`MESSAGES`), rebuilt
 * from that sentence's own closed words. Any other message is the app's or a Person's text and
 * is left out: there is no shape a sentence can be trusted by.
 */
const said = ({ message }: Pick<Event, 'message'>) =>
  Option.getOrUndefined(
    Option.flatMap(Option.fromUndefinedOr(message), (given) =>
      Option.map(
        Option.fromUndefinedOr(MESSAGES.find(([pattern]) => pattern.test(given))),
        ([pattern, form]) => given.replace(pattern, form),
      ),
    ),
  )

/** `file` for a path the SDK may have left out, which stays left out. */
const filed = ({ address }: { readonly address?: string }) =>
  Option.getOrUndefined(Option.map(Option.fromUndefinedOr(address), file))

/**
 * One stack frame: where it is and what it is called, each by its shape. The source lines around
 * it and the values of its local variables are left behind; the addresses stay, because a native
 * frame is only turned back into a name from them.
 */
const frame = (from: StackFrame): StackFrame => ({
  filename: filed({ address: from.filename }),
  abs_path: filed({ address: from.abs_path }),
  function: fitting(FORMS.code, { value: from.function }),
  module: fitting(FORMS.code, { value: from.module }),
  platform: fitting(FORMS.platform, { value: from.platform }),
  lineno: from.lineno,
  colno: from.colno,
  in_app: from.in_app,
  instruction_addr: fitting(FORMS.address, { value: from.instruction_addr }),
  addr_mode: fitting(FORMS.mode, { value: from.addr_mode }),
  debug_id: fitting(FORMS.hex, { value: from.debug_id }),
})

/**
 * One exception: its type, its stack and how it was caught. Its `value` is the error's message
 * and is left behind (see the top of this file), and so are the mechanism's free-form `data` and
 * the thread it was on.
 */
const exception = (from: Exception): Exception => ({
  type: fitting(FORMS.code, { value: from.type }),
  module: fitting(FORMS.code, { value: from.module }),
  mechanism:
    from.mechanism === undefined
      ? undefined
      : {
          type: kept(FORMS.mechanism, from.mechanism.type),
          handled: from.mechanism.handled,
          synthetic: from.mechanism.synthetic,
          source: fitting(FORMS.source, { value: from.mechanism.source }),
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

/** An address out of a breadcrumb's data, as a place, when the data had one. */
const placed = (address: Option.Option<string>) => Option.getOrUndefined(Option.map(address, place))

/**
 * One breadcrumb, or null when nothing of it may leave. Two kinds are kept, cut down: a request
 * (its method, its status and which of the app's routes it went to) and a move between screens
 * (the two routes). Every other kind is dropped whole, because its text is the Person's: a
 * console line prints what the app was handling, and a click is named by the label of what was
 * pressed, which can be a Thread's title.
 *
 * It is the SDK's `beforeBreadcrumb`, and `scrub` applies it again to whatever a report carries,
 * since native breadcrumbs join a report without passing the first.
 */
export const scrubBreadcrumb = (from: Breadcrumb): Breadcrumb | null => {
  const addresses = addressed(from.data)
  const base = {
    type: fitting(FORMS.crumb, { value: from.type }),
    level: severity(from),
    timestamp: from.timestamp,
  }
  if (from.category !== undefined && REQUESTS.has(from.category))
    return {
      ...base,
      category: from.category,
      data: {
        ...Option.getOrElse(requested(from.data), () => ({})),
        url: placed(Option.flatMap(addresses, (given) => Option.fromUndefinedOr(given.url))),
      },
    }
  if (from.category === 'navigation')
    return {
      ...base,
      category: from.category,
      data: {
        from: placed(Option.flatMap(addresses, (given) => Option.fromUndefinedOr(given.from))),
        to: placed(Option.flatMap(addresses, (given) => Option.fromUndefinedOr(given.to))),
      },
    }
  return null
}

/**
 * The browser's own description of itself, which is the only thing Sentry can tell the system
 * from on the web, and which of the app's routes the page was on. Every other header, the
 * cookies and the body of the page's request are left behind.
 *
 * `User-Agent` is the one string here kept as it is, with no shape: it is written by the browser,
 * not by a Person, and it has no shape narrower than "what a browser says it is". It is the same
 * string every site the Person visits is sent.
 */
const request = (from: NonNullable<ErrorEvent['request']>): ErrorEvent['request'] => {
  const agent = from.headers === undefined ? undefined : from.headers['User-Agent']
  return {
    url: from.url === undefined ? undefined : place(from.url),
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

/**
 * One loaded file a frame can belong to, cut to what turns a frame back into a name: which kind
 * it is, its debug id, where it was loaded (native code only) and which file of the build it is.
 * A kind this does not name (`wasm`, which Vivid does not load) is left out.
 */
const image = (from: DebugImage): ReadonlyArray<DebugImage> => {
  if (from.type === 'sourcemap')
    return [
      {
        type: 'sourcemap',
        debug_id: kept(FORMS.hex, from.debug_id),
        code_file: file(from.code_file),
      },
    ]
  if (from.type === 'macho')
    return [
      {
        type: 'macho',
        debug_id: kept(FORMS.hex, from.debug_id),
        image_addr: kept(FORMS.address, from.image_addr),
        image_size: from.image_size,
        code_file: filed({ address: from.code_file }),
      },
    ]
  return []
}

/**
 * What the SDK says about itself: its name, its version, its packages and which of its
 * integrations are on. Each is the SDK's own word, so each is kept by shape, and an integration
 * only when it is one this app turns on (`INTEGRATIONS`): the list is otherwise a place any code
 * could put a name.
 *
 * `infer_ip` is not copied. It is written as `never` whatever the SDK said, because it is what
 * tells Sentry not to record the address a report came from.
 */
const sdk = (from: SdkInfo): SdkInfo => ({
  name: fitting(FORMS.sdk, { value: from.name }),
  version: fitting(FORMS.version, { value: from.version }),
  integrations:
    from.integrations === undefined
      ? undefined
      : from.integrations.filter((name) => INTEGRATIONS.has(name)),
  packages:
    from.packages === undefined
      ? undefined
      : from.packages.map(({ name, version }) => ({
          name: kept(FORMS.package, name),
          version: kept(FORMS.version, version),
        })),
  settings: { infer_ip: 'never' },
})

/**
 * The SDK's `beforeSend`: the report that leaves, built from the allowed parts of the one the SDK
 * made. The user, the extras, every message that is not an SDK's own sentence, the request's body, cookies and headers, and anything
 * this function does not name are not copied, so they are gone.
 *
 * It takes any event and always returns an error report, because `guarded` runs it again over
 * whatever reaches the transport.
 */
export const scrub = (event: Event): ErrorEvent => ({
  type: undefined,
  event_id: fitting(FORMS.hex, { value: event.event_id }),
  timestamp: event.timestamp,
  level: severity(event),
  platform: fitting(FORMS.platform, { value: event.platform }),
  release: fitting(FORMS.release, { value: event.release }),
  dist: fitting(FORMS.token, { value: event.dist }),
  environment: fitting(FORMS.environment, { value: event.environment }),
  message: said(event),
  sdk: event.sdk === undefined ? undefined : sdk(event.sdk),
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
          const scrubbed = scrubBreadcrumb(crumb)
          return scrubbed === null ? [] : [scrubbed]
        }),
  tags: Option.getOrUndefined(tags(event.tags)),
  contexts: Option.getOrUndefined(contexts(event.contexts)),
  request: event.request === undefined ? undefined : request(event.request),
})

/** Whether an envelope is the kind that carries a report: only that kind has an `event` item. */
const carriesEvent = (envelope: Envelope): envelope is EventEnvelope =>
  envelope[1].some(([header]) => header.type === 'event')

/** Whether one item of such an envelope is the report itself. */
const isEvent = (item: EventEnvelope[1][number]): item is EventItem => item[0].type === 'event'

/**
 * What of an envelope may leave: the error reports in it, each through `scrub` once more, under a
 * header cut to its id, its time and where it is going, each by its shape. None when it carries
 * no report.
 *
 * An envelope is how the SDK sends everything, not only errors: sessions, its own counts of what
 * it dropped, replays, profiles, feedback, check-ins, transactions, and the attachments (a
 * screenshot, a view hierarchy) that ride beside a report. All of those are other item types and
 * are left behind here, whatever switched them on. The header's `trace` and `sdk` go too: the
 * first names the screen a trace started on, and the second is already in the report.
 */
export const outbound = (envelope: Envelope): Option.Option<EventEnvelope> => {
  if (!carriesEvent(envelope)) return Option.none()
  const [headers, items] = envelope
  const reports: Array<EventItem> = []
  for (const item of items) if (isEvent(item)) reports.push([{ type: 'event' }, scrub(item[1])])
  return Option.some([
    {
      event_id: kept(FORMS.hex, headers.event_id),
      sent_at: kept(FORMS.moment, headers.sent_at),
      dsn: fitting(FORMS.dsn, { value: headers.dsn }),
    },
    reports,
  ])
}

/**
 * A transport that sends only what `outbound` allows. An envelope with nothing allowed in it is
 * answered as sent, with the empty answer the SDK's own transports give for a request that needs
 * no reply, so the SDK neither retries it nor counts a failure.
 */
export const guarded = (inner: Transport): Transport => ({
  send: (envelope) =>
    Option.match(outbound(envelope), {
      onNone: () => Promise.resolve({}),
      onSome: (allowed) => inner.send(allowed),
    }),
  flush: (timeout) => inner.flush(timeout),
})
