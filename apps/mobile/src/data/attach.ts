import { useAtomValue } from '@effect/atom-react'
import type { ThreadId } from '@vivid/contracts'
import { attaching } from '@vivid/state'
import { Effect, Layer, Option } from 'effect'
import { AsyncResult, Atom } from 'effect/reactivity'
import { randomUUID } from 'expo-crypto'
import { File } from 'expo-file-system'
import { chooseAttachments, uploadDocument, type Attached } from './documents'
import type { LiveData } from './live'

/**
 * The phone's side of attaching files to a message (`attaching` in `@vivid/state`): the system's
 * picker, reading a picture into a message, and sending a document to the Person's Library.
 *
 * One tray per Thread for the session, made the first time the Person attaches something there
 * and kept while the app runs, so a picture chosen and left in the composer is still there when
 * the Thread is opened again. Registry disposal ends any reading or upload still running.
 */

/** The server takes pictures up to five megabytes (as on the web). */
const LARGEST_PICTURE = 5 * 1024 * 1024

const trays = Atom.keepAlive(Atom.make<ReadonlyMap<ThreadId, attaching.TrayAtoms>>(new Map()))

const EMPTY: attaching.Tray = { items: [], choosing: false, preparing: false }

/** Every Thread's tray as the composer reads it; a Thread never attached to has an empty one. */
const shown = Atom.make((get): ReadonlyMap<ThreadId, attaching.Tray> => {
  const out = new Map<ThreadId, attaching.Tray>()
  for (const [thread, machine] of get(trays)) {
    const result = get(machine.result)
    if (AsyncResult.isSuccess(result)) out.set(thread, attaching.trayOf(result.value))
  }
  return out
})

/** This Thread's tray, for the composer. */
export const useTray = (thread: ThreadId): attaching.Tray =>
  Option.getOrElse(Option.fromUndefinedOr(useAtomValue(shown).get(thread)), () => EMPTY)

const chosenOf = (file: Attached): attaching.Chosen => ({
  key: randomUUID(),
  name: file.name,
  uri: file.uri,
  mimeType: file.mimeType,
  size: file.size,
})

const refused = (file: attaching.Chosen, why: string) =>
  attaching.Item.cases.Refused.make({ file, why })

/**
 * Reads a picture into what a message carries, or sends a document to the Library. A shared
 * Thread takes no pictures yet, as on the web: its messages go through the server, which carries
 * words only.
 */
const prepare =
  (data: LiveData, shared: boolean) =>
  (file: attaching.Chosen): Effect.Effect<attaching.Item> => {
    if (!file.mimeType.startsWith('image/')) {
      return uploadDocument(
        data.session,
        { name: file.name, uri: file.uri },
        {
          shelf: 'Mine',
          folderId: null,
        },
      ).pipe(
        Effect.as(attaching.Item.cases.Document.make({ file })),
        Effect.orElseSucceed(() => refused(file, 'It did not upload. Take it off and try again.')),
      )
    }
    if (shared)
      return Effect.succeed(refused(file, 'Pictures can only be sent in a private thread for now.'))
    if (Option.exists(file.size, (size) => size > LARGEST_PICTURE))
      return Effect.succeed(refused(file, 'Too large. Pictures can be up to 5 MB.'))
    return Effect.tryPromise({
      try: () => new File(file.uri).base64(),
      catch: () => refused(file, 'It could not be read. Try another file.'),
    }).pipe(
      Effect.map((data64) =>
        attaching.Item.cases.Picture.make({
          file,
          picture: { type: 'image', mimeType: file.mimeType, data: data64, filename: file.name },
        }),
      ),
      // A picture that could not be read answers Refused, the same as one that is too large.
      Effect.catch(Effect.succeed),
    )
  }

const services = (data: LiveData, shared: boolean) =>
  Layer.succeed(attaching.Attaching, {
    // A picker that cannot open leaves the tray as it was; there is nothing chosen to show.
    choose: chooseAttachments().pipe(
      Effect.map((files) => files.map(chosenOf)),
      Effect.catchTag('DocumentUnavailable', () => Effect.succeed([])),
    ),
    prepare: prepare(data, shared),
  })

/** This Thread's tray machine, made on first use. */
const trayFor = (data: LiveData, thread: ThreadId, shared: boolean) => {
  const known = data.registry.get(trays)
  const existing = known.get(thread)
  if (existing !== undefined) return existing
  const machine = attaching.makeTray(services(data, shared))
  data.registry.set(trays, new Map(known).set(thread, machine))
  data.registry.mount(machine.snapshot)
  return machine
}

/** The attach button: opens the picker. */
export const chooseFiles = (data: LiveData, thread: ThreadId, shared: boolean): void =>
  data.registry.set(
    trayFor(data, thread, shared).send,
    attaching.TrayEvents.Choose({ attempt: randomUUID() }),
  )

/** Pictures pasted into the composer join the tray as if chosen. */
export const pastePictures = (
  data: LiveData,
  thread: ThreadId,
  shared: boolean,
  uris: ReadonlyArray<string>,
): void =>
  data.registry.set(
    trayFor(data, thread, shared).send,
    attaching.TrayEvents.Add({
      files: uris.map((uri) => ({
        key: randomUUID(),
        name: 'Pasted picture.png',
        uri,
        mimeType: 'image/png',
        size: Option.none(),
      })),
    }),
  )

/** Takes one file off. */
export const removeFile = (data: LiveData, thread: ThreadId, shared: boolean, key: string) =>
  data.registry.set(trayFor(data, thread, shared).send, attaching.TrayEvents.Remove({ key }))

/** The message went with what was kept. */
export const clearTray = (data: LiveData, thread: ThreadId, shared: boolean) =>
  data.registry.set(trayFor(data, thread, shared).send, attaching.TrayEvents.Clear())
