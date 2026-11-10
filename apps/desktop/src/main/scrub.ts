import type {
  Breadcrumb,
  DebugImage,
  Envelope,
  ErrorEvent,
  Event,
  EventEnvelope,
  EventItem,
  Exception,
  StackFrame,
  Transport,
} from '@sentry/core'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import * as Struct from 'effect/Struct'
import { CodeName, DEEPEST_CAUSE, Incident, IncidentSource } from '@vivid/contracts'

/**
 * What an error report may carry to Sentry, as an allowlist: `scrub` builds a new report from the
 * named parts of the one the SDK made and leaves everything else behind. A denylist would let
 * through whatever a later SDK version starts collecting; this cannot.
 *
 * What goes: which kind of error it was, where in the code it happened, which build and which
 * system it happened on. What never goes: anything a Person wrote or was shown. That is why the
 * error's message is dropped too. A decoding failure quotes the value it could not decode
 * (Effect's `SchemaError` prints the offending input), so a message can hold a Thread's text. The
 * message is still read where it is safe: the window's `fault.ts` sends it to Vivid's own server.
 *
 * The web and mobile apps keep their own copy of this file (`apps/web/src/data/scrub.ts`,
 * `apps/mobile/src/data/scrub.ts`), because each is typed by its own SDK's events. A change to
 * what may leave is made in all three. This copy runs in the main process, over its own errors
 * and over every report a window hands it (`telemetry.ts`).
 *
 * It is enforced twice. `scrub` and `scrubBreadcrumb` are the SDK's `beforeSend` and
 * `beforeBreadcrumb`. `guarded` then wraps the SDK's transport, the one place everything that
 * leaves has to pass: the SDK adds attachments to a report after `beforeSend`, and sends its own
 * internal errors without calling it (`sendEvent` and `_processEvent` in `@sentry/core`
 * `client.js`), so the hooks alone are not the whole way out.
 */

/** One field of a context or a breadcrumb that may leave: a name, a version, an address. */
const text = Schema.optionalKey(Schema.String)
/** One field that may leave and is a yes or a no. */
const flag = Schema.optionalKey(Schema.Boolean)
/** A context that is only a name and a version: a runtime, a browser. */
const named = Schema.optionalKey(Schema.Struct({ name: text, version: text }))

/**
 * The tags an Incident's report adds (`sending.reportOf` in `@vivid/state`), each admitted by the
 * closed set or the shape its field has in `Incident` (`@vivid/contracts`): the case by
 * `Incident`'s cases, a hop's service by `IncidentSource`, its operation and tag as `CodeName`s,
 * its status as an HTTP status. One set of keys for each place a cause can have a hop
 * (`DEEPEST_CAUSE`), so the keys are finite and known, and a case or a source added to the
 * contract is admitted without a second list.
 */
/** A tag an Incident's report adds: every one is a string of a closed set or of a fixed shape. */
type IncidentTag = Schema.optionalKey<Schema.Codec<string>>

/** The tags of the hop at place `n` of a cause. */
const causeTags = (n: number): ReadonlyArray<readonly [string, IncidentTag]> => [
  [`vivid.incident.cause.${n}.service`, Schema.optionalKey(IncidentSource)],
  [`vivid.incident.cause.${n}.operation`, Schema.optionalKey(CodeName)],
  [`vivid.incident.cause.${n}.tag`, Schema.optionalKey(CodeName)],
  [
    `vivid.incident.cause.${n}.status`,
    Schema.optionalKey(Schema.String.check(Schema.isPattern(/^[1-5][0-9]{2}$/u))),
  ],
]

const incidentTags = Object.fromEntries<IncidentTag>([
  ['vivid.incident.kind', Schema.optionalKey(Schema.Literals(Struct.keys(Incident.cases)))],
  ...Array.from({ length: DEEPEST_CAUSE }, (_, n) => causeTags(n)).flat(),
])

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
  'vivid.operation': Schema.optionalKey(
    Schema.String.check(Schema.isPattern(/^[A-Za-z_$][A-Za-z0-9_$.]{0,119}$/)),
  ),
  'event.process': text,
  'event.origin': text,
  'event.environment': text,
  'expo.updates.update_id': text,
  'expo.updates.channel': text,
  'expo.updates.runtime_version': text,
  ...incidentTags,
})

/**
 * The parts of each context a report keeps. Contexts describe the system, but not only the
 * system: `device.name` is what the Person called their phone, so each context is cut to the
 * fields that describe a model or a version.
 */
const Contexts = Schema.Struct({
  trace: Schema.optionalKey(
    Schema.Struct({
      trace_id: Schema.String.check(Schema.isPattern(/^[0-9a-f]{32}$/)),
      span_id: Schema.String.check(Schema.isPattern(/^[0-9a-f]{16}$/)),
    }),
  ),
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
  status_code: Schema.optionalKey(Schema.Finite),
  url: text,
})

/** What a breadcrumb for a move between screens keeps of its data. */
const Move = Schema.Struct({ from: text, to: text })

const tags = Schema.decodeUnknownOption(Tags)
const contexts = Schema.decodeUnknownOption(Contexts)
const requested = Schema.decodeUnknownOption(Request)
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
const place = (address: string): string =>
  ROOTS.reduce(
    (path, root) => path.replace(root, ''),
    withoutQuery(address).replaceAll('\\', '/').replace(ORIGIN, ''),
  )

/** The same for an address the SDK may have left out, which stays left out. */
const bare = ({ address }: { readonly address?: string }) =>
  Option.getOrUndefined(Option.map(Option.fromUndefinedOr(address), place))

/**
 * One stack frame: where it is and what it is called. The source lines around it and the values
 * of its local variables are left behind; the addresses stay, because a native frame is only
 * turned back into a name from them.
 */
const frame = (from: StackFrame): StackFrame => ({
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
 * (its method, its status and where in the app it went, `place`) and a move between screens (the
 * two places). Every other kind is dropped whole, because its text is the
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
 * The one sentence the SDK writes itself, for a report that is nothing but that sentence: a window
 * or helper process that ended (`getMessageAndSeverity` in `@sentry/electron`
 * `main/integrations/child-process.js`). Both of its blanks are Electron's own words for a
 * process and a reason, so it is the only message that may leave.
 */
const PROCESS_ENDED = /^'[\w -]+' process exited with '[\w-]+'$/u

/**
 * The browser's own description of itself, which is the only thing Sentry can tell the system
 * from on the web. Every other header, the cookies and the body of the page's request are left
 * behind, and the page's address is cut to its place in the app (`place`).
 */
const request = (from: NonNullable<ErrorEvent['request']>): ErrorEvent['request'] => {
  const agent = from.headers === undefined ? undefined : from.headers['User-Agent']
  return {
    url: bare({ address: from.url }),
    headers: agent === undefined ? undefined : { 'User-Agent': agent },
  }
}

/** The one fingerprint the SDK writes itself: group this report the way Sentry would anyway. */
const DEFAULT_FINGERPRINT = '{{ default }}'

const isKind = Schema.is(Schema.Literals(Struct.keys(Incident.cases)))
const isCodeName = Schema.is(CodeName)
const isSource = Schema.is(IncidentSource)

/**
 * An Incident's fingerprint (`sending.reportOf` in `@vivid/state`): its case, then
 * `<service>.<tag>` of each hop of its cause, every part a code name from a closed set.
 */
const isIncidentFingerprint = (from: ReadonlyArray<string>) =>
  from.length <= DEEPEST_CAUSE + 1 &&
  isKind(from[0]) &&
  from.slice(1).every((part) => isCodeName(part) && isSource(part.split('.')[0]))

/**
 * A fingerprint is free text that code chooses to group reports by, so it can be anything: an
 * email, a Thread's title. Only one made of nothing but the SDK's default marker is kept, or an
 * Incident's, which is made of nothing but code names.
 */
const fingerprint = (from: ReadonlyArray<string>) =>
  from.every((part) => part === DEFAULT_FINGERPRINT) || isIncidentFingerprint(from)
    ? [...from]
    : undefined

/**
 * One loaded file a frame can belong to, cut to what turns a frame back into a name: which kind
 * it is, its debug id, where it was loaded (native code only) and its place in the app. A kind
 * this does not name (`wasm`, which Vivid does not load) is left out.
 */
const image = (from: DebugImage): ReadonlyArray<DebugImage> => {
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
 * The SDK's `beforeSend`: the report that leaves, built from the allowed parts of the one the SDK
 * made. The user, the extras, every message but the SDK's own (`PROCESS_ENDED`), the request's body, cookies and headers, and anything
 * this function does not name are not copied, so they are gone.
 *
 * It takes any event and always returns an error report, because `guarded` runs it again over
 * whatever reaches the transport.
 */
export const scrub = (event: Event): ErrorEvent => ({
  type: undefined,
  event_id: event.event_id,
  timestamp: event.timestamp,
  level: event.level,
  platform: event.platform,
  release: event.release,
  dist: event.dist,
  environment: event.environment,
  message:
    event.message !== undefined && PROCESS_ENDED.test(event.message) ? event.message : undefined,
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
          const kept = scrubBreadcrumb(crumb)
          return kept === null ? [] : [kept]
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
 * header cut to its id, its time and where it is going. None when it carries no report.
 *
 * An envelope is how the SDK sends everything, not only errors: sessions, its own counts of what
 * it dropped, replays, profiles, feedback, check-ins, transactions, and the attachments (a
 * screenshot, a view hierarchy) that ride beside a report. All of those are other item types and
 * are left behind here, whatever switched them on. The header's `trace` goes too: it names the
 * screen a trace started on, and Vivid sends no traces.
 */
const outbound = (envelope: Envelope): Option.Option<EventEnvelope> => {
  if (!carriesEvent(envelope)) return Option.none()
  const [headers, items] = envelope
  const reports: Array<EventItem> = []
  for (const item of items) if (isEvent(item)) reports.push([{ type: 'event' }, scrub(item[1])])
  return Option.some([
    { event_id: headers.event_id, sent_at: headers.sent_at, dsn: headers.dsn, sdk: headers.sdk },
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
      onSome: (kept) => inner.send(kept),
    }),
  flush: (timeout) => inner.flush(timeout),
})
