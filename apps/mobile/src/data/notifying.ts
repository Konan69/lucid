import { useAtomValue } from '@effect/atom-react'
import { PushDestination, PushPayload, type ThreadId } from '@vivid/contracts'
import { notifying, type makeLive } from '@vivid/state'
import { Effect, Layer, Option, Result, Schema } from 'effect'
import { randomUUID } from 'expo-crypto'
import * as Notifications from 'expo-notifications'
import { Platform } from 'react-native'
import { useLiveData, type LiveData } from './live'
import { keep, recall } from './storage'

/**
 * Notifications while Vivid is closed, on a phone: this phone's side of the session's machine
 * (`@vivid/state` `notifying.ts`), the way a pressed notification opens what it is about, and how
 * one that arrives while the app is open is shown.
 *
 * A phone's address is its Expo push token. Unlike a browser's subscription the token outlives
 * turning notifications off, so the phone keeps the Person's choice itself (`CHOICE`): a launch
 * registers the token again only when they have not turned notifications off here.
 *
 * The token comes from Expo's push service and needs the app's Expo project and, on Android, the
 * Firebase credentials it was built with; a build without them cannot be given one, and the
 * machine says `Unavailable`.
 */

/** Where the Person's choice for this phone is kept: `off` once they turned notifications off. */
const CHOICE = 'vivid.notifications'

/** The channel Android shows them on. Android 13 asks for permission only once one exists. */
const CHANNEL = 'default'

const unavailable = () => new notifying.DeviceRefused({ reason: 'Unavailable' })

const decodeDestination = Schema.decodeUnknownEffect(PushDestination)

/** This phone's token, as the address the server takes. Expo's answer is its ingress. */
const token = Effect.tryPromise({
  try: () => Notifications.getExpoPushTokenAsync(),
  catch: unavailable,
}).pipe(
  Effect.flatMap(({ data }) =>
    decodeDestination({ _tag: 'Phone', token: data }).pipe(Effect.mapError(unavailable)),
  ),
)

const permissions = Effect.tryPromise({
  try: () => Notifications.getPermissionsAsync(),
  catch: unavailable,
})

/** Whether the Person turned notifications off on this phone. An unreadable store says not. */
const turnedOff = recall(CHOICE).pipe(
  Effect.map((kept) => Option.contains(kept, 'off')),
  Effect.mapError(unavailable),
)

/** The choice, kept for the next launch. */
const choose = (choice: 'on' | 'off') => keep(CHOICE, choice).pipe(Effect.mapError(unavailable))

const phone = notifying.Device.of({
  read: Effect.gen(function* () {
    // The browser preview has no push service of its own.
    if (Platform.OS === 'web') return notifying.Holding.cases.Unsupported.make({})
    const { status } = yield* permissions
    if (status === 'denied') return notifying.Holding.cases.Blocked.make({})
    if (status === 'undetermined') return notifying.Holding.cases.Unasked.make({})
    if (yield* turnedOff) return notifying.Holding.cases.Off.make({})
    return notifying.Holding.cases.Held.make({ destination: yield* token })
  }),
  open: Effect.gen(function* () {
    if (Platform.OS === 'web') return yield* unavailable()
    if (Platform.OS === 'android') {
      yield* Effect.tryPromise({
        try: () =>
          Notifications.setNotificationChannelAsync(CHANNEL, {
            name: 'Vivid',
            importance: Notifications.AndroidImportance.HIGH,
          }),
        catch: unavailable,
      })
    }
    const { status } = yield* Effect.tryPromise({
      try: () => Notifications.requestPermissionsAsync(),
      catch: unavailable,
    })
    if (status === 'denied') return yield* new notifying.DeviceRefused({ reason: 'Blocked' })
    if (status === 'undetermined') {
      return yield* new notifying.DeviceRefused({ reason: 'Dismissed' })
    }
    const destination = yield* token
    yield* choose('on')
    return destination
  }),
  close: () => choose('off'),
})

/** The server's side, over the session's own connection. */
const targetsOf = (engine: ReturnType<typeof makeLive>) =>
  notifying.Targets.of({
    register: (destination) =>
      engine
        .change((client) => client.RegisterPushTarget({ destination }))
        .pipe(
          Effect.flatMap(
            Result.match({
              onFailure: () => Effect.fail(new notifying.TargetsRefused({})),
              onSuccess: ({ target }) => Effect.succeed(target),
            }),
          ),
        ),
    remove: (target) =>
      engine
        .change((client) => client.RemovePushTarget({ id: target.id }))
        .pipe(
          Effect.flatMap(
            Result.match({
              onFailure: () => Effect.fail(new notifying.TargetsRefused({})),
              onSuccess: () => Effect.void,
            }),
          ),
        ),
  })

/**
 * The session's machine, made where its registry and socket are (`live.ts`) and started at once:
 * the session exists only once the Person is signed in, and the launch registers a token this
 * phone already gave them.
 */
export const makeNotifying = (engine: ReturnType<typeof makeLive>) => {
  const machine = notifying.make(
    Layer.mergeAll(
      Layer.succeed(notifying.Device, phone),
      Layer.succeed(notifying.Targets, targetsOf(engine)),
    ),
  )
  engine.registry.mount(machine.reading)
  return machine
}

/** Settings' row reads the same machine the first message offers through. */
export const useNotifying = () => useAtomValue(useLiveData().notifying.reading)

/** A fresh attempt for each press: its outcome is told apart from an earlier one's. */
const attempt = () => notifying.AttemptId.make(randomUUID())

export const turnNotificationsOn = (data: LiveData) =>
  data.registry.set(data.notifying.send, data.notifying.turnOn({ attempt: attempt() }))

export const turnNotificationsOff = (data: LiveData) =>
  data.registry.set(data.notifying.send, data.notifying.turnOff({ attempt: attempt() }))

/**
 * Offers notifications after the Person has sent a message, the first moment there is something
 * Vivid may need to tell them later. The machine takes it only while they were never asked.
 */
export const offerNotifications = (data: LiveData) =>
  data.registry.set(data.notifying.send, data.notifying.offer({ attempt: attempt() }))

// A notification that arrives while the app is open is shown as the system's banner too: the
// Person may be in another Thread or another app's sheet. It is set once, for the whole app.
Notifications.setNotificationHandler({
  handleNotification: () =>
    Promise.resolve({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: false,
      shouldSetBadge: false,
    }),
})

const decodePressed = Schema.decodeUnknownOption(PushPayload)

/** What a pressed notification is about: its Thread, or none (the Feed). */
const pressedOf = (response: Notifications.NotificationResponse) =>
  Option.map(decodePressed(response.notification.request.content.data), (payload) =>
    Option.fromNullOr(payload.threadId),
  )

/**
 * Hears each notification the Person presses and hands what it is about to `open`, once the
 * navigator can go there. A press that started the app is read once, at that moment, and cleared
 * so it is not opened again; later presses arrive as they happen.
 */
export const listenForPresses = (open: (thread: Option.Option<ThreadId>) => void) => {
  Option.map(
    Option.flatMap(Option.fromNullOr(Notifications.getLastNotificationResponse()), pressedOf),
    (thread) => {
      Notifications.clearLastNotificationResponse()
      open(thread)
    },
  )
  const heard = Notifications.addNotificationResponseReceivedListener((response) => {
    Option.map(pressedOf(response), open)
  })
  return () => heard.remove()
}
