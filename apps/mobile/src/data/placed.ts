import { Effect, Option } from 'effect'
import * as AsyncResult from 'effect/reactivity/AsyncResult'
import * as Atom from 'effect/reactivity/Atom'
import { launch } from './app'
import { door } from './door'
import { decodePlaces, encodePlaces, placeAt, withPlace, type Place, type Places } from './place'
import { forgetFile, keepFile, recallFile } from './storage'

/**
 * Where the Person was (`data/place.ts`), as this phone keeps it: one file of the app's own, like
 * the drafts and the snapshot (`storage.ts`), read once at launch and written whole each time the
 * place changes. It is a few ids and names. It is erased with the session (`live.ts`), so nothing
 * of one Person's is opened for the next.
 */
const FILE = 'place.json'

/**
 * What the file held at launch. A file that is missing, unreadable or in a shape this build does
 * not know is nothing kept: the app opens at the greeting, which is what it did before.
 */
const recalled = Atom.keepAlive(
  Atom.make(
    recallFile(FILE).pipe(
      Effect.map(Option.flatMap(decodePlaces)),
      Effect.catchTag('StorageUnavailable', () => Effect.succeed(Option.none<Places>())),
    ),
  ),
)
// Read as the app starts, beside the session (`data/held.ts`), so it has answered before the
// shell is ready to ask.
door.mount(recalled)

/** What has been kept since launch. It stands over what the file held from the first change on. */
const changed = Atom.keepAlive(Atom.make(Option.none<Places>()))

/**
 * Whether the file has answered. The shell is not drawn before it has (`App.tsx`): drawing the
 * greeting first and the Person's Thread a moment later would be the reset this removes.
 */
export const placesReadAtom = Atom.make((get) => !AsyncResult.isInitial(get(recalled)))

/** Everything kept, as it stands now: nothing, until the file has answered or a place is kept. */
const standing = (): Places =>
  Option.getOrElse(
    Option.orElse(door.get(changed), () => Option.flatten(AsyncResult.value(door.get(recalled)))),
    (): Places => ({}),
  )

/** Where the Person was in a workspace on a server, or `NOWHERE` when nothing was kept for it. */
export const placeIn = (origin: string, workspace: string): Place =>
  placeAt(standing(), origin, workspace)

/**
 * Keeps where the Person is in a workspace. The write is the small synchronous one (`keepFile`),
 * as a draft's is: it must be down before the app can be ended, and it is a few hundred bytes. A
 * store that refuses has simply not kept it, and no screen says anything about that.
 */
export const keepPlace = (origin: string, workspace: string, place: Place): void => {
  const next = withPlace(standing(), origin, workspace, place)
  door.set(changed, Option.some(next))
  launch(
    Option.match(encodePlaces(next), {
      onNone: () => Effect.void,
      onSome: (text) =>
        keepFile(FILE, text).pipe(Effect.catchTag('StorageUnavailable', () => Effect.void)),
    }),
  )
}

/** The session ended: where its Person was leaves the phone, in memory and in the file. */
export const forgetPlaces = Effect.suspend(() => {
  door.set(changed, Option.some<Places>({}))
  return forgetFile(FILE).pipe(Effect.catchTag('StorageUnavailable', () => Effect.void))
})
