import { useAtomValue } from '@effect/atom-react'
import { PushDestination, PushPayload, type NotificationOpens } from '@vivid/contracts'
import { notifying, type makeLive } from '@vivid/state'
import { Effect, Layer, Option, Result, Schema, Struct } from 'effect'
import { PermissionStatus } from 'expo'
import Constants from 'expo-constants'
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
 * The token comes from Expo's push service for the app's Expo project (`PROJECT`) and, on
 * Android, the Firebase credentials it was built with. A build that names no project cannot be
 * given one, and the machine reads `Unsupported`; one whose credentials are missing says
 * `Unavailable` when the token is asked for.
 */

/** Where the Person's choice for this phone is kept: `off` once they turned notifications off. */
const CHOICE = 'vivid.notifications'

/** The channel Android shows them on. Android 13 asks for permission only once one exists. */
const CHANNEL = 'default'
/**
 * The channel a quiet notice arrives on: a Feed post Vivid made on its own is shown without a
 * sound (Konan, 27 October 2026: "Feed posts appear silently"). On Android the channel, not the
 * message, decides the sound, so the server names this channel for those (`push/adapter.ts`).
 */
const QUIET_CHANNEL = 'quiet'

const unavailable = () => new notifying.DeviceRefused({ reason: 'Unavailable' })

/**
 * The Expo project this build was made for, as Expo itself reads it when asked for a token
 * without one (`extra.eas.projectId`, `expo-notifications` `getExpoPushTokenAsync.ts`). Expo
 * refuses a token without a project, so none means this build cannot be notified while closed:
 * a build made before the project existed, or the browser preview, which has no push service.
 * The id is never made up here; a build is given it in its config (`app.config.ts`).
 */
const Project = Schema.Struct({
  extra: Schema.Struct({ eas: Schema.Struct({ projectId: Schema.NonEmptyString }) }),
})
const PROJECT =
  Platform.OS === 'web'
    ? Option.none<string>()
    : Option.map(
        Schema.decodeUnknownOption(Project)(Constants.expoConfig),
        (config) => config.extra.eas.projectId,
      )

const decodeToken = Schema.decodeUnknownEffect(
  PushDestination.cases.Phone.mapFields(Struct.pick(['token'])),
)

/** This phone's token, as the address the server takes. Expo's answer is its ingress. */
const tokenFor = (projectId: string) =>
  Effect.tryPromise({
    try: () => Notifications.getExpoPushTokenAsync({ projectId }),
    catch: unavailable,
  }).pipe(
    Effect.flatMap(({ data }) =>
      decodeToken({ token: data }).pipe(
        Effect.map((fields) => PushDestination.cases.Phone.make(fields)),
        Effect.mapError(unavailable),
      ),
    ),
  )

/**
 * Both of Vivid's Android channels, made again on every read: making a channel that exists only
 * updates it, and a phone that allowed notifications before the quiet channel existed gets it
 * here. A message naming a channel the phone lacks would arrive on Android's fallback, with sound.
 */
const channels = Effect.tryPromise({
  try: () =>
    Promise.all([
      Notifications.setNotificationChannelAsync(CHANNEL, {
        name: 'Vivid',
        importance: Notifications.AndroidImportance.HIGH,
      }),
      Notifications.setNotificationChannelAsync(QUIET_CHANNEL, {
        name: 'Vivid, quietly',
        importance: Notifications.AndroidImportance.DEFAULT,
        sound: null,
        enableVibrate: false,
      }),
    ]),
  catch: unavailable,
}).pipe(Effect.when(Effect.succeed(Platform.OS === 'android')))

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
    if (Option.isNone(PROJECT)) return notifying.Holding.cases.Unsupported.make({})
    const projectId = PROJECT.value
    const { status } = yield* permissions
    switch (status) {
      case PermissionStatus.DENIED:
        return notifying.Holding.cases.Blocked.make({})
      case PermissionStatus.UNDETERMINED:
        return notifying.Holding.cases.Unasked.make({})
      case PermissionStatus.GRANTED:
        yield* channels
        if (yield* turnedOff) return notifying.Holding.cases.Off.make({})
        return notifying.Holding.cases.Held.make({ destination: yield* tokenFor(projectId) })
    }
  }),
  open: Effect.gen(function* () {
    if (Option.isNone(PROJECT)) return yield* unavailable()
    const projectId = PROJECT.value
    yield* channels
    const { status } = yield* Effect.tryPromise({
      try: () => Notifications.requestPermissionsAsync(),
      catch: unavailable,
    })
    switch (status) {
      case PermissionStatus.DENIED:
        return yield* new notifying.DeviceRefused({ reason: 'Blocked' })
      case PermissionStatus.UNDETERMINED:
        return yield* new notifying.DeviceRefused({ reason: 'Dismissed' })
      case PermissionStatus.GRANTED: {
        const destination = yield* tokenFor(projectId)
        yield* choose('on')
        return destination
      }
    }
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
              onFailure: (failure) => Effect.fail(notifying.targetsRefused(failure)),
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
              onFailure: (failure) => Effect.fail(notifying.targetsRefused(failure)),
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

/** Where a pressed notification opens (`NotificationOpens`), as the server said in its payload. */
const pressedOf = (response: Notifications.NotificationResponse) =>
  Option.map(decodePressed(response.notification.request.content.data), (payload) => payload.opens)

/**
 * Hears each notification the Person presses and hands what it is about to `open`, once the
 * navigator can go there. A press that started the app is read once, at that moment, and cleared
 * so it is not opened again; later presses arrive as they happen.
 */
export const listenForPresses = (open: (opens: NotificationOpens) => void) => {
  Option.map(
    Option.flatMap(Option.fromNullOr(Notifications.getLastNotificationResponse()), pressedOf),
    (opens) => {
      Notifications.clearLastNotificationResponse()
      open(opens)
    },
  )
  const heard = Notifications.addNotificationResponseReceivedListener((response) => {
    Option.map(pressedOf(response), open)
  })
  return () => heard.remove()
}
