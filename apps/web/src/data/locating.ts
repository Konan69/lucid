import { useAtomValue } from '@effect/atom-react'
import { LocationReading, LocationSharing, Settings } from '@vivid/contracts'
import { locating } from '@vivid/state'
import { Effect, Layer, Result, Schema } from 'effect'
import * as AsyncResult from 'effect/reactivity/AsyncResult'
import { act, changing } from './app'
import { live } from './live'
import { engine } from './runtime'

/**
 * Sharing where the Person is, in a browser: this browser's side of the session's machine
 * (`@vivid/state` `locating.ts`), through the browser's own permission and `navigator.geolocation`.
 * The phone does the same with its location service (`apps/mobile/src/data/locating.ts`).
 *
 * A browser has no geocoder, so its readings carry coordinates and no place name; Vivid is told
 * the coordinates. The desktop app does not offer it: Electron's geolocation needs a provider key
 * Vivid does not ship, so the row is not shown there (`General.tsx`).
 */

const unavailable = () => new locating.Refused({ reason: 'Unavailable' })

/**
 * A fix this recent is reused, and a coarse one is asked for. The timeout bounds the device's
 * search for a fix, which a browser otherwise lets run with no end; the switch waits on it.
 */
const OPTIONS: PositionOptions = {
  enableHighAccuracy: false,
  maximumAge: 5 * 60_000,
  timeout: 30_000,
}

/** The browser's answer, as the domain's refusal: refused by the Person, or not found. */
const positionError = (error: GeolocationPositionError) =>
  new locating.Refused({
    reason: error.code === error.PERMISSION_DENIED ? 'Blocked' : 'Unavailable',
  })

/** Asks for one fix. The first one is what makes the browser ask the Person. */
const position = Effect.callback<GeolocationPosition, locating.Refused>((resume) => {
  navigator.geolocation.getCurrentPosition(
    (found) => resume(Effect.succeed(found)),
    (error) => resume(Effect.fail(positionError(error))),
    OPTIONS,
  )
})

const decodeReading = Schema.decodeUnknownEffect(LocationReading)

const readingOf = (found: GeolocationPosition) =>
  decodeReading({
    latitude: found.coords.latitude,
    longitude: found.coords.longitude,
    accuracy: found.coords.accuracy,
    takenAt: found.timestamp,
    place: null,
  }).pipe(Effect.mapError(unavailable))

/** Whether the browser already allows it, without asking. A browser that cannot say has not. */
const allowed = Effect.tryPromise({
  try: () => navigator.permissions.query({ name: 'geolocation' }),
  catch: unavailable,
}).pipe(Effect.map((status) => status.state === 'granted'))

const browser = locating.Device.of({
  // A fix the Person refused is a refusal; any other failure means they allowed it and the
  // browser could not find where it is yet, which the next moment to send tries again.
  allow: position.pipe(
    Effect.asVoid,
    Effect.catchIf(
      (refused) => refused.reason !== 'Blocked',
      () => Effect.void,
    ),
  ),
  read: Effect.gen(function* () {
    if (!(yield* allowed)) return yield* new locating.Refused({ reason: 'Blocked' })
    return yield* readingOf(yield* position)
  }),
})

/** Settings as they are, with sharing as it will be once the server has the change. */
const sharingAs = (current: Settings, location: LocationSharing) =>
  new Settings({
    personId: current.personId,
    theme: current.theme,
    timezone: current.timezone,
    notify: current.notify,
    egress: current.egress,
    location,
  })

/** The answer of a change, as the machine's refusal when the server did not take it. */
const answered = Result.match({
  onFailure: (failure: Parameters<typeof locating.serverRefused>[0]) =>
    Effect.fail(locating.serverRefused(failure)),
  onSuccess: () => Effect.void,
})

const server = locating.Server.of({
  turn: (on) =>
    changing(
      (client) => client.PatchSettings({ location: on }),
      () =>
        live.settings.expect((current) =>
          sharingAs(
            current,
            !on
              ? LocationSharing.cases.Off.make({})
              : LocationSharing.guards.Off(current.location)
                ? LocationSharing.cases.Waiting.make({})
                : current.location,
          ),
        ),
    ).pipe(Effect.flatMap(answered)),
  // Sharing was turned off on another device a moment ago: the reading is dropped, as asked.
  share: (reading) =>
    changing((client) =>
      client
        .ShareLocation({ reading })
        .pipe(Effect.catchTag('LocationNotShared', () => Effect.void)),
    ).pipe(Effect.flatMap(answered)),
})

const machine = locating.make(
  Layer.mergeAll(Layer.succeed(locating.Device, browser), Layer.succeed(locating.Server, server)),
)

/** Sends where this browser is, while the Person's Settings say sharing is on. Asks nothing. */
export const shareLocation = () => {
  const settings = engine.registry.get(live.settings.atom)
  if (AsyncResult.isSuccess(settings) && !LocationSharing.guards.Off(settings.value.location))
    void act(browser.read.pipe(Effect.flatMap(server.share), Effect.ignore))
}

/**
 * Starts the machine and the moments to send: the first time the page hears the Person's
 * Settings, which is the session beginning, and each time this window comes back to the front.
 * Called once it is known who is signed in (`App.tsx`), for the life of the page.
 */
export const startLocating = () => {
  engine.registry.mount(machine.reading)
  let begun = false
  engine.registry.subscribe(
    live.settings.atom,
    (settings) => {
      if (begun || !AsyncResult.isSuccess(settings)) return
      begun = true
      shareLocation()
    },
    { immediate: true },
  )
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') shareLocation()
  })
}

/** Settings' row reads the session's machine. */
export const useLocating = () => useAtomValue(machine.reading)

/** A fresh attempt for each press: its outcome is told apart from an earlier one's. */
const attempt = () => locating.AttemptId.make(crypto.randomUUID())

export const turnLocationOn = () =>
  engine.registry.set(machine.send, machine.turnOn({ attempt: attempt() }))

export const turnLocationOff = () =>
  engine.registry.set(machine.send, machine.turnOff({ attempt: attempt() }))
