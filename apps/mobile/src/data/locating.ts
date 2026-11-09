import { useAtomValue } from '@effect/atom-react'
import { LocationPlace, LocationReading, LocationSharing, Settings } from '@vivid/contracts'
import { locating, type LiveQuery, type makeLive } from '@vivid/state'
import { Array as Arr, Effect, Layer, Option, Result, Schema } from 'effect'
import { randomUUID } from 'expo-crypto'
import * as Location from 'expo-location'
import * as AsyncResult from 'effect/reactivity/AsyncResult'
import * as Atom from 'effect/reactivity/Atom'
import { AppState } from 'react-native'
import { start } from './app'
import { useLiveData, type LiveData } from './live'

/**
 * Sharing where the Person is, on a phone: this phone's side of the session's machine
 * (`@vivid/state` `locating.ts`), and the moments it sends where it is.
 *
 * The binary has carried `expo-location` 57.0.22 since runtime 0.3.13 with the "while using"
 * purpose string and no background modes (`app.json`), so this is JavaScript only. Every call here
 * exists in that version: `requestForegroundPermissionsAsync`, `getForegroundPermissionsAsync`,
 * `getLastKnownPositionAsync`, `getCurrentPositionAsync` and `reverseGeocodeAsync`. Nothing runs in
 * the background: a place is read when the app comes to the front and when the Person sends a
 * message, and only while their Settings say sharing is on.
 */

const unavailable = () => new locating.Refused({ reason: 'Unavailable' })

/** A reading this recent is used as it is, rather than waking the location service again. */
const RECENT = 5 * 60_000

/** Coarse is enough for nearby work, and it is what the phone can answer quickly. */
const COARSE = 3_000

/** Asks the Person, unless they already answered. Android may ask again after one refusal. */
const allow = Effect.fn('Locating.allow')(function* () {
  const answer = yield* Effect.tryPromise({
    try: () => Location.requestForegroundPermissionsAsync(),
    catch: unavailable,
  })
  if (answer.status === Location.PermissionStatus.GRANTED) return yield* Effect.void
  // Refused for good only when the phone will not ask again; otherwise the next press asks.
  const blocked = answer.status === Location.PermissionStatus.DENIED && !answer.canAskAgain
  return yield* new locating.Refused({ reason: blocked ? 'Blocked' : 'Dismissed' })
})

/** Where the phone is: a recent fix it already holds, or a new coarse one. */
const position = Effect.fn('Locating.position')(function* () {
  const recent = yield* Effect.tryPromise({
    try: () => Location.getLastKnownPositionAsync({ maxAge: RECENT, requiredAccuracy: COARSE }),
    catch: unavailable,
  })
  if (recent !== null) return recent
  return yield* Effect.tryPromise({
    try: () => Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Low }),
    catch: unavailable,
  })
})

const decodePlace = Schema.decodeUnknownOption(LocationPlace)
const decodeReading = Schema.decodeUnknownEffect(LocationReading)

/**
 * The place in words, coarse: the district, the town and the country ("Lekki, Lagos, Nigeria"),
 * from the phone's own geocoder, which needs no key of Vivid's. No street or number is kept. When
 * the geocoder has no answer the reading goes without a name and Vivid is given the coordinates.
 */
const placeOf = (coords: Location.LocationObjectCoords) =>
  Effect.tryPromise(() =>
    Location.reverseGeocodeAsync({ latitude: coords.latitude, longitude: coords.longitude }),
  ).pipe(
    Effect.map((found) =>
      Option.flatMap(Arr.head(found), (address) =>
        decodePlace(
          Arr.dedupe(
            Arr.filter(
              [address.district, address.city ?? address.subregion, address.country],
              (part): part is string => part !== null && part.trim() !== '',
            ),
          ).join(', '),
        ),
      ),
    ),
    Effect.orElseSucceed(() => Option.none<LocationPlace>()),
  )

/** Asks nothing: a phone that was not allowed fails here and nothing is read. */
const read = Effect.fn('Locating.read')(function* () {
  const { status } = yield* Effect.tryPromise({
    try: () => Location.getForegroundPermissionsAsync(),
    catch: unavailable,
  })
  if (status !== Location.PermissionStatus.GRANTED)
    return yield* new locating.Refused({ reason: 'Blocked' })
  const fix = yield* position()
  const place = yield* placeOf(fix.coords)
  return yield* decodeReading({
    latitude: fix.coords.latitude,
    longitude: fix.coords.longitude,
    accuracy: fix.coords.accuracy,
    takenAt: fix.timestamp,
    place: Option.getOrNull(place),
  }).pipe(Effect.mapError(unavailable))
})

const phone = locating.Device.of({ allow: allow(), read: read() })

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

/**
 * The server's side, over the session's own connection. Turning on or off shows at once in
 * Settings, so the switch does not fall back for a moment between the answer and the live update.
 */
const serverOf = (engine: ReturnType<typeof makeLive>, settings: LiveQuery<Settings>) =>
  locating.Server.of({
    turn: (on) =>
      engine
        .change(
          (client) => client.PatchSettings({ location: on }),
          () =>
            settings.expect((current) =>
              sharingAs(
                current,
                !on
                  ? LocationSharing.cases.Off.make({})
                  : LocationSharing.guards.Off(current.location)
                    ? LocationSharing.cases.Waiting.make({})
                    : current.location,
              ),
            ),
        )
        .pipe(Effect.flatMap(answered)),
    // Sharing was turned off on another device a moment ago: the reading is dropped, as asked.
    share: (reading) =>
      engine
        .change((client) =>
          client
            .ShareLocation({ reading })
            .pipe(Effect.catchTag('LocationNotShared', () => Effect.void)),
        )
        .pipe(Effect.flatMap(answered)),
  })

/** Whether the Person's Settings, as this session last heard them, say sharing is on. */
const sharing = (engine: ReturnType<typeof makeLive>, settings: LiveQuery<Settings>) => {
  const result = engine.registry.get(settings.atom)
  return AsyncResult.isSuccess(result) && !LocationSharing.guards.Off(result.value.location)
}

/**
 * The session's machine and its moments to send, made where its registry and socket are
 * (`live.ts`). The moments are the app coming to the front, the first time the session hears the
 * Person's Settings (a launch is coming to the front too), and each message sent (`shareLocation`).
 * Each is dropped while sharing is off; a reading that fails is dropped too, and the next moment
 * tries again.
 */
export const makeLocating = (
  engine: ReturnType<typeof makeLive>,
  settings: LiveQuery<Settings>,
) => {
  const server = serverOf(engine, settings)
  const machine = locating.make(
    Layer.mergeAll(Layer.succeed(locating.Device, phone), Layer.succeed(locating.Server, server)),
  )
  engine.registry.mount(machine.reading)
  const share = () => {
    if (sharing(engine, settings))
      void start(phone.read.pipe(Effect.flatMap(server.share), Effect.ignore))
  }
  // Held for the life of the session's registry, and let go with it.
  const fronted = Atom.make((get) => {
    const heard = AppState.addEventListener('change', (state) => {
      if (state === 'active') share()
    })
    get.addFinalizer(() => heard.remove())
  })
  engine.registry.mount(fronted)
  let launched = false
  engine.registry.subscribe(
    settings.atom,
    (result) => {
      if (launched || !AsyncResult.isSuccess(result)) return
      launched = true
      share()
    },
    { immediate: true },
  )
  return { ...machine, share }
}

/** Settings' row reads the session's machine. */
export const useLocating = () => useAtomValue(useLiveData().locating.reading)

/** A fresh attempt for each press: its outcome is told apart from an earlier one's. */
const attempt = () => locating.AttemptId.make(randomUUID())

export const turnLocationOn = (data: LiveData) =>
  data.registry.set(data.locating.send, data.locating.turnOn({ attempt: attempt() }))

export const turnLocationOff = (data: LiveData) =>
  data.registry.set(data.locating.send, data.locating.turnOff({ attempt: attempt() }))

/** A message is on its way: Vivid is about to answer, so it is told where the Person is now. */
export const shareLocation = (data: LiveData) => data.locating.share()
