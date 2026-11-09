import { VividRpcClient } from '@vivid/client-runtime'
import {
  NotificationOpens,
  PushAnswer,
  PushAsk,
  PushPayload,
  type DecideApprovalRequest,
} from '@vivid/contracts'
import { answeredOf, refusalOf, refusalWords, requestOf } from '@vivid/state/responding'
import { Effect, Layer, Option, Result, Schema } from 'effect'
import * as FetchHttpClient from 'effect/http/FetchHttpClient'

/**
 * The web app's service worker: it shows what the server pushes while no Vivid tab is in front,
 * and opens what a notification is about when the Person presses it.
 *
 * The server sends one `PushPayload` per notification, as JSON (`apps/server/src/push/adapter.ts`
 * `sendBrowser`). One that asks the Person to decide an Approval (`PushAsk`) carries its buttons,
 * and a press on Allow or Decline answers it from here, without opening Vivid. It is registered by `data/notifying.ts` from wherever the bundler puts it
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
    listener: (
      event: Waited & {
        readonly notification: Notification
        /** The pressed button's `action`; empty for a press on the notification itself. */
        readonly action: string
      },
    ) => void,
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
const decodeAnswer = Schema.decodeUnknownOption(PushAnswer)

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

/** One button, as the Notifications API takes it: what it says, and what a press hands back. */
interface Button {
  readonly action: PushAnswer
  readonly title: string
}

/** The options this worker shows a notification with; the DOM's own type has no `actions`. */
interface Shown extends NotificationOptions {
  readonly actions: ReadonlyArray<Button>
}

/**
 * The buttons a notice carries: Allow and Decline on an Approval; Review and Decline on a draft,
 * which is never allowed unread (`PushAsk`). A browser that shows no buttons ignores them, and a
 * press on the notification opens it as before.
 */
const buttonsOf = (asks: PushAsk): ReadonlyArray<Button> =>
  PushAsk.match(asks, {
    Nothing: (): ReadonlyArray<Button> => [],
    Approval: (): ReadonlyArray<Button> => [
      { action: 'allow', title: 'Allow' },
      { action: 'decline', title: 'Decline' },
    ],
    Draft: (): ReadonlyArray<Button> => [
      { action: 'review', title: 'Review' },
      { action: 'decline', title: 'Decline' },
    ],
  })

/** Shows one pushed notification, unless a Vivid window is in front. */
const show = Effect.fn('Worker.show')(function* (scope: WorkerScope, payload: PushPayload) {
  const windows = yield* windowsOf(scope)
  if (windows.some((window) => window.focused)) return
  const shown: Shown = {
    body: payload.body,
    // One notification per notice: the same one pushed twice replaces itself.
    tag: payload.notificationId,
    // A Feed post Vivid made on its own arrives without a sound (`PushSound`).
    silent: payload.sound === 'Quiet',
    data: yield* encodePayload(payload),
    actions: buttonsOf(payload.asks),
  }
  yield* Effect.promise(() => scope.registration.showNotification(payload.title, shown))
})

/**
 * The product's calls as one HTTP request from this origin. The browser sends the session's
 * cookie with it, as it does for the page's own one-shot calls (`data/account.ts`).
 */
const oneShot = VividRpcClient.layer({ url: '/api/rpc' }).pipe(Layer.provide(FetchHttpClient.layer))

/** One decision over `oneShot`, the worker's own entry to the server. */
const decide = (request: DecideApprovalRequest) =>
  // @effect-diagnostics-next-line strictEffectProvide:off -- the service worker is its own program with no app runtime; this one-shot HTTP client lives for this one call
  Effect.provide(
    VividRpcClient.use((client) => client.DecideApproval(request)),
    oneShot,
  )

/**
 * Answers an Approval from a button, with the same `DecideApproval` the Feed sends. Nothing is
 * said when the server takes it; a refusal is shown as a notification of its own, in the
 * Person's words, with the action's words as its title. It opens the notice, with no buttons.
 */
const answer = Effect.fn('Worker.answer')(function* (
  scope: WorkerScope,
  payload: PushPayload,
  request: DecideApprovalRequest,
) {
  const result = yield* Effect.result(decide(request))
  if (Result.isSuccess(result)) return
  const data = yield* encodePayload(answeredOf(payload))
  yield* Effect.promise(() =>
    scope.registration.showNotification(payload.body, {
      body: refusalWords[refusalOf(result.failure)],
      tag: payload.notificationId,
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
    if (Option.isNone(payload)) return
    // Allow and Decline answer here; Review and a press on the notification open it.
    const request = Option.flatMap(decodeAnswer(event.action), (pressed) =>
      requestOf(payload.value.asks, pressed),
    )
    event.waitUntil(
      Effect.runPromise(
        Option.isSome(request)
          ? answer(scope, payload.value, request.value)
          : open(scope, payload.value),
      ),
    )
  })
}
