import { NotificationOpens, PushPayload } from '@vivid/contracts'
import { Effect, Option, Schema } from 'effect'

/**
 * The web app's service worker: it shows what the server pushes while no Vivid tab is in front,
 * and opens what a notification is about when the Person presses it.
 *
 * The server sends one `PushPayload` per notification, as JSON (`apps/server/src/push/adapter.ts`
 * `sendBrowser`). It is registered by `data/notifying.ts` from wherever the bundler puts it
 * (`/assets/` in a build), so its scope does not cover the app's pages. It needs none: a push
 * reaches the registration whatever its scope, and `clients.matchAll` with `includeUncontrolled`
 * finds every window of this origin.
 */

/** A window of this origin, as the worker sees it. */
interface WindowClient {
  readonly focused: boolean
  focus(): Promise<WindowClient>
  postMessage(message: typeof PushPayload.Encoded): void
}

/** An event whose work the browser waits on before it lets the worker stop. */
interface Waited {
  waitUntil(work: Promise<unknown>): void
}

/** The parts of `ServiceWorkerGlobalScope` this worker uses. */
interface WorkerScope {
  readonly registration: ServiceWorkerRegistration
  readonly clients: {
    matchAll(options: {
      readonly type: 'window'
      readonly includeUncontrolled: boolean
    }): Promise<ReadonlyArray<WindowClient>>
    openWindow(url: string): Promise<WindowClient | null>
  }
  addEventListener(
    type: 'push',
    listener: (event: Waited & { readonly data: { text(): string } | null }) => void,
  ): void
  addEventListener(
    type: 'notificationclick',
    listener: (event: Waited & { readonly notification: Notification }) => void,
  ): void
}

/**
 * The program's own global is a `ServiceWorkerGlobalScope`, which the app's DOM types do not
 * describe; the two type libraries cannot be loaded into one program. This checks the members it
 * goes on to use before treating the global as one.
 */
const isWorkerScope = (value: Partial<WorkerScope>): value is WorkerScope =>
  'registration' in value && 'clients' in value && 'skipWaiting' in value

const decodePushed = Schema.decodeUnknownOption(Schema.fromJsonString(PushPayload))
const decodeShown = Schema.decodeUnknownOption(PushPayload)
const encodePayload = Schema.encodeEffect(PushPayload)

/**
 * Where pressing a notification takes the Person (`NotificationOpens`). Web has no Notifications
 * page: the bell is in the app's own sidebar, so an invitation opens the app.
 */
const placeOf = (payload: PushPayload) =>
  NotificationOpens.match(payload.opens, {
    Thread: ({ threadId }) => `/t/${encodeURIComponent(threadId)}`,
    Feed: () => '/feed',
    Notifications: () => '/',
  })

/**
 * Every window of this origin. A window in front already says the notification itself
 * (`data/live.ts`), so the system's is not shown over it.
 */
const windowsOf = (scope: WorkerScope) =>
  Effect.promise(() => scope.clients.matchAll({ type: 'window', includeUncontrolled: true }))

/** Shows one pushed notification, unless a Vivid window is in front. */
const show = Effect.fn('Worker.show')(function* (scope: WorkerScope, payload: PushPayload) {
  const windows = yield* windowsOf(scope)
  if (windows.some((window) => window.focused)) return
  const data = yield* encodePayload(payload)
  yield* Effect.promise(() =>
    scope.registration.showNotification(payload.title, {
      body: payload.body,
      // One notification per notice: the same one pushed twice replaces itself.
      tag: payload.notificationId,
      // A Feed post Vivid made on its own arrives without a sound (`PushSound`).
      silent: payload.sound === 'Quiet',
      data,
    }),
  )
})

/**
 * Opens what a notification is about. A window that is open is brought forward and told where to
 * go, so the app moves there without loading again; with none open, a new one opens there.
 */
const open = Effect.fn('Worker.open')(function* (scope: WorkerScope, payload: PushPayload) {
  const windows = yield* windowsOf(scope)
  const [first] = windows
  if (first === undefined) {
    yield* Effect.promise(() => scope.clients.openWindow(placeOf(payload)))
    return
  }
  const focused = yield* Effect.promise(() => first.focus())
  focused.postMessage(yield* encodePayload(payload))
})

// Read as the worker's own members first: narrowed from its DOM type, the global would keep the
// window's `addEventListener` overloads ahead of the worker's.
const global: Partial<WorkerScope> = globalThis
if (isWorkerScope(global)) {
  const scope = global
  scope.addEventListener('push', (event) => {
    const payload = Option.flatMap(Option.fromNullOr(event.data), (data) =>
      decodePushed(data.text()),
    )
    if (Option.isSome(payload)) event.waitUntil(Effect.runPromise(show(scope, payload.value)))
  })
  scope.addEventListener('notificationclick', (event) => {
    event.notification.close()
    const payload = decodeShown(event.notification.data)
    if (Option.isSome(payload)) event.waitUntil(Effect.runPromise(open(scope, payload.value)))
  })
}
