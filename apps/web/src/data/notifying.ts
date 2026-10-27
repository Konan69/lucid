import { useAtomValue } from '@effect/atom-react'
import { VividRpcClient } from '@vivid/client-runtime'
import {
  PushDestination,
  PushPayload,
  ThreadId,
  type Notification as Notice,
} from '@vivid/contracts'
import { notifying } from '@vivid/state'
import { Effect, Layer, Option, Result, Schema } from 'effect'
import workerAddress from '../worker.ts?worker&url'
import { router } from '../router'
import { changing, running } from './app'
import { engine } from './runtime'

/**
 * Notifications while Vivid is closed, in a browser: this browser's side of the session's
 * machine (`@vivid/state` `notifying.ts`), and the desktop app's own notices.
 *
 * A browser has an address when its service worker (`src/worker.ts`) holds a push subscription
 * made against the server's key. The subscription is the browser's own record that the Person
 * turned notifications on here: turning off unsubscribes it, so a launch that finds one registers
 * it again and a launch that finds none leaves it off.
 *
 * The desktop app is a browser without a push service (Electron has none), so there the machine
 * reads `Unsupported` and the shell shows a system notice itself while it runs (`showOnDesktop`).
 */

/** The bridge the desktop app's shell puts on the window. A shell older than notices has none. */
const desktop =
  'vivid' in globalThis && 'notifications' in globalThis.vivid
    ? Option.some(globalThis.vivid.notifications)
    : Option.none()

/** Whether this browser can be sent a notification while no Vivid tab is open. */
const pushable =
  !('vivid' in globalThis) &&
  'serviceWorker' in navigator &&
  'PushManager' in globalThis &&
  'Notification' in globalThis

const unavailable = () => new notifying.DeviceRefused({ reason: 'Unavailable' })

/**
 * The worker, registered (again: the browser keeps one registration per script scope and updates
 * it when the script changes). A build bundles it as a classic script; the development server
 * serves it as a module.
 */
const registered = Effect.tryPromise({
  try: () =>
    navigator.serviceWorker.register(workerAddress, {
      type: import.meta.env.DEV ? 'module' : 'classic',
    }),
  catch: unavailable,
})

/**
 * Waits until the registration has an active worker: a browser subscribes only through one. The
 * page is outside the worker's scope, so `navigator.serviceWorker.ready`, which waits for the
 * page's own controller, would never answer here. A worker that fails to install ends redundant.
 */
const activeIn = (registration: ServiceWorkerRegistration) =>
  Effect.callback<void, notifying.DeviceRefused>((resume) => {
    const worker = registration.installing ?? registration.waiting
    if (registration.active !== null || worker === null) {
      resume(Effect.void)
      return
    }
    const heard = () => {
      if (worker.state === 'activated') resume(Effect.void)
      if (worker.state === 'redundant') resume(Effect.fail(unavailable()))
    }
    worker.addEventListener('statechange', heard)
    return Effect.sync(() => worker.removeEventListener('statechange', heard))
  })

/** The server's public key, as the bytes a subscription is made against (base64url, unpadded). */
const keyBytes = (key: string) => {
  const text = atob(key.replaceAll('-', '+').replaceAll('_', '/'))
  return Uint8Array.from(text, (character) => character.charCodeAt(0))
}

const decodeDestination = Schema.decodeUnknownEffect(PushDestination)

/** A subscription as the address the server takes. The browser's own JSON is its ingress. */
const destinationOf = (subscription: PushSubscription) =>
  decodeDestination({ _tag: 'Browser', ...subscription.toJSON() }).pipe(
    Effect.mapError(unavailable),
  )

/** The subscription this browser holds, if it holds one. */
const subscriptionIn = (registration: ServiceWorkerRegistration) =>
  Effect.tryPromise({
    try: () => registration.pushManager.getSubscription(),
    catch: unavailable,
  }).pipe(Effect.map(Option.fromNullOr))

const browser = notifying.Device.of({
  read: Effect.gen(function* () {
    if (!pushable) return notifying.Holding.cases.Unsupported.make({})
    if (Notification.permission === 'denied') return notifying.Holding.cases.Blocked.make({})
    if (Notification.permission === 'default') return notifying.Holding.cases.Unasked.make({})
    // Only a browser that allowed notifications installs the worker, and each launch registers
    // it again so a new build's worker replaces the old one.
    const subscription = yield* subscriptionIn(yield* registered)
    if (Option.isNone(subscription)) return notifying.Holding.cases.Off.make({})
    const destination = yield* destinationOf(subscription.value)
    return notifying.Holding.cases.Held.make({ destination })
  }),
  open: Effect.gen(function* () {
    if (!pushable) return yield* unavailable()
    // First, in the turn of the press: a browser asks only while the press's activation lasts.
    const answer = yield* Effect.tryPromise({
      try: () => Notification.requestPermission(),
      catch: unavailable,
    })
    if (answer === 'denied') return yield* new notifying.DeviceRefused({ reason: 'Blocked' })
    if (answer === 'default') return yield* new notifying.DeviceRefused({ reason: 'Dismissed' })
    const registration = yield* registered
    yield* activeIn(registration)
    const key = yield* running(VividRpcClient.use((client) => client.GetPushKey()))
    if (Result.isFailure(key)) return yield* unavailable()
    const subscription = yield* Effect.tryPromise({
      try: () =>
        registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: keyBytes(key.success.publicKey),
        }),
      catch: unavailable,
    })
    return yield* destinationOf(subscription)
  }),
  close: () =>
    Effect.gen(function* () {
      const subscription = yield* subscriptionIn(yield* registered)
      if (Option.isNone(subscription)) return
      yield* Effect.tryPromise({ try: () => subscription.value.unsubscribe(), catch: unavailable })
    }),
})

const targets = notifying.Targets.of({
  register: (destination) =>
    changing((client) => client.RegisterPushTarget({ destination })).pipe(
      Effect.flatMap(
        Result.match({
          onFailure: () => Effect.fail(new notifying.TargetsRefused({})),
          onSuccess: ({ target }) => Effect.succeed(target),
        }),
      ),
    ),
  remove: (target) =>
    changing((client) => client.RemovePushTarget({ id: target.id })).pipe(
      Effect.flatMap(
        Result.match({
          onFailure: () => Effect.fail(new notifying.TargetsRefused({})),
          onSuccess: () => Effect.void,
        }),
      ),
    ),
})

const machine = notifying.make(
  Layer.mergeAll(
    Layer.succeed(notifying.Device, browser),
    Layer.succeed(notifying.Targets, targets),
  ),
)

/**
 * Starts the machine, which reads this browser and registers an address it already holds. Called
 * once it is known who is signed in (`App.tsx`): an address is the Person's, and registering it
 * needs their session.
 */
export const startNotifying = () => {
  engine.registry.mount(machine.reading)
}

/** Settings' row reads the same machine the first message offers through. */
export const useNotifying = () => useAtomValue(machine.reading)

/** A fresh attempt for each press: its outcome is told apart from an earlier one's. */
const attempt = () => notifying.AttemptId.make(crypto.randomUUID())

export const turnNotificationsOn = () =>
  engine.registry.set(machine.send, machine.turnOn({ attempt: attempt() }))

export const turnNotificationsOff = () =>
  engine.registry.set(machine.send, machine.turnOff({ attempt: attempt() }))

/**
 * Offers notifications after the Person has sent a message, the first moment there is something
 * Vivid may need to tell them later. It is sent in the press itself, so the browser's question
 * comes while the press still counts as one; the machine takes it only while the Person was never
 * asked.
 */
export const offerNotifications = () =>
  engine.registry.set(machine.send, machine.offer({ attempt: attempt() }))

/** Where a notification is about: its Thread, or the Feed when it is about none. */
const go = (threadId: PushPayload['threadId']) =>
  threadId === null
    ? void router.navigate({ to: '/feed' })
    : void router.navigate({ to: '/t/$id', params: { id: threadId } })

const decodePressed = Schema.decodeUnknownOption(PushPayload)

// The worker hands a pressed notification to the window it brought forward, which goes there
// without loading again (`worker.ts` `open`). It is the worker's only message.
if (pushable) {
  navigator.serviceWorker.addEventListener('message', (event) => {
    Option.map(decodePressed(event.data), (payload) => go(payload.threadId))
  })
}

/**
 * Shows a system notice for one notification in the desktop app; the shell shows it only while
 * its window is not in front, where the page says it itself (`data/live.ts`). In a browser it
 * does nothing: there the push service and the worker carry it.
 */
export const showOnDesktop = (notice: Notice) =>
  Option.map(desktop, (notices) => {
    void notices.show({ title: notice.title, body: notice.body, threadId: notice.threadId })
  })

const decodeOpened = Schema.decodeUnknownOption(Schema.NullOr(ThreadId))

// The shell says which notice was pressed after it has brought its window forward. The shell
// carries the Thread as plain text (its preload cannot load the contracts), so it is read here.
Option.map(desktop, (notices) =>
  notices.onOpened(({ threadId }) => Option.map(decodeOpened(threadId), go)),
)
