import { useAtomValue } from '@effect/atom-react'
import type { ThreadId } from '@vivid/contracts'
import { attaching } from '@vivid/state'
import { Effect, Layer, Option, Stream } from 'effect'
import { AsyncResult, Atom, AtomRegistry } from 'effect/reactivity'
import { randomUUID } from 'expo-crypto'
import { manipulateAsync, SaveFormat } from 'expo-image-manipulator'
import * as ImagePicker from 'expo-image-picker'
import { AssetField, MediaType, Query, requestPermissionsAsync } from 'expo-media-library'
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

/**
 * The longest side a picture is sent at, in pixels. A phone's photo is 4000 or more and over the
 * server's five megabytes (as on the web); at this size it reads the same to Vivid and is a few
 * hundred kilobytes. Every picture is also turned into a JPEG here, so a library photo stored as
 * HEIC, which the server does not take, goes as one.
 */
const LONGEST_SIDE = 2048

/** How many recent photos the sheet's strip offers. */
const RECENT = 12

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
        Effect.withErrorReporting,
        Effect.as(attaching.Item.cases.Document.make({ file })),
        Effect.orElseSucceed(() => refused(file, 'It did not upload. Take it off and try again.')),
      )
    }
    if (shared)
      return Effect.succeed(refused(file, 'Pictures can only be sent in a private thread for now.'))
    return Effect.tryPromise(() =>
      manipulateAsync(file.uri, [{ resize: { width: LONGEST_SIDE } }], {
        compress: 0.8,
        format: SaveFormat.JPEG,
        base64: true,
      }),
    ).pipe(
      Effect.withErrorReporting,
      Effect.mapError(() => refused(file, 'It could not be read. Try another file.')),
      Effect.flatMap((image) =>
        Option.match(Option.fromUndefinedOr(image.base64), {
          onNone: () => Effect.fail(refused(file, 'It could not be read. Try another file.')),
          onSome: (data64) =>
            Effect.succeed(
              attaching.Item.cases.Picture.make({
                file,
                picture: {
                  type: 'image',
                  mimeType: 'image/jpeg',
                  data: data64,
                  filename: file.name.replace(/\.[^.]+$/u, '') + '.jpg',
                },
              }),
            ),
        }),
      ),
      // A picture that could not be read answers Refused, as any file that cannot go does.
      Effect.catch(Effect.succeed),
    )
  }

/** A photo the picker or the camera handed back, as the tray takes it. */
const fromPicker = (asset: ImagePicker.ImagePickerAsset): attaching.Chosen => ({
  key: randomUUID(),
  name: Option.getOrElse(Option.fromNullishOr(asset.fileName), () => 'Photo.jpg'),
  uri: asset.uri,
  mimeType: Option.getOrElse(Option.fromNullishOr(asset.mimeType), () => 'image/jpeg'),
  size: Option.fromUndefinedOr(asset.fileSize),
})

/** What a picker answered: the chosen photos, or none when it was closed. */
const pickedOf = (result: ImagePicker.ImagePickerResult) =>
  result.canceled ? [] : result.assets.map(fromPicker)

/**
 * Opens a source's picker. Photos is the system's photo picker, which needs no library access;
 * Camera asks for the camera the first time. A picker that cannot open, or a camera that is not
 * allowed, leaves the tray as it was: there is nothing chosen to show.
 */
const choose = (source: attaching.Source): Effect.Effect<ReadonlyArray<attaching.Chosen>> => {
  const nothing = () => Effect.succeed<ReadonlyArray<attaching.Chosen>>([])
  if (source === 'Files')
    return chooseAttachments().pipe(
      Effect.map((files) => files.map(chosenOf)),
      Effect.catchTag('DocumentUnavailable', nothing),
    )
  if (source === 'Photos')
    return Effect.tryPromise(() =>
      ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        allowsMultipleSelection: true,
        selectionLimit: attaching.MOST_PICTURES,
      }),
    ).pipe(Effect.map(pickedOf), Effect.withErrorReporting, Effect.catch(nothing))
  return Effect.gen(function* () {
    const allowed = yield* Effect.tryPromise(() => ImagePicker.requestCameraPermissionsAsync())
    if (!allowed.granted) return []
    return pickedOf(
      yield* Effect.tryPromise(() => ImagePicker.launchCameraAsync({ mediaTypes: ['images'] })),
    )
  }).pipe(Effect.withErrorReporting, Effect.catch(nothing))
}

const services = (data: LiveData, shared: boolean) =>
  Layer.succeed(attaching.Attaching, { choose, prepare: prepare(data, shared) })

/**
 * The Person's newest photos, for the strip in the attach sheet. Reading it asks for the photo
 * library the first time; a library that is not allowed is no photos, and the sheet keeps its
 * Photos tile, which needs no access.
 */
export const recentPhotos = Atom.make(
  Effect.gen(function* () {
    const allowed = yield* Effect.tryPromise(() => requestPermissionsAsync(false, ['photo']))
    if (!allowed.granted) return []
    const assets = yield* Effect.tryPromise(() =>
      new Query()
        .eq(AssetField.MEDIA_TYPE, MediaType.IMAGE)
        .orderBy({ key: AssetField.CREATION_TIME, ascending: false })
        .limit(RECENT)
        .exe(),
    )
    return yield* Effect.forEach(assets, (asset) =>
      Effect.all({
        name: Effect.tryPromise(() => asset.getFilename()),
        uri: Effect.tryPromise(() => asset.getUri()),
      }).pipe(
        Effect.map(({ name, uri }): attaching.Chosen => ({
          key: asset.id,
          name,
          uri,
          mimeType: 'image/jpeg',
          size: Option.none(),
        })),
      ),
    )
  }).pipe(
    Effect.withErrorReporting,
    Effect.orElseSucceed((): ReadonlyArray<attaching.Chosen> => []),
  ),
)

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

/** Whether the tray is up in this opening of the picker. */
const choosingIn = (
  result: AsyncResult.AsyncResult<attaching.TrayState, unknown>,
  attempt: string,
) =>
  AsyncResult.isSuccess(result) &&
  Option.exists(attaching.TrayStates.get(result.value, 'Choosing'), (up) => up.attempt === attempt)

/**
 * A source in the attach sheet: opens its picker, and ends when the picker has answered. The
 * sheet stays up under the picker and closes when this ends. Closing it first would ask iOS to
 * present the picker over a sheet that is being dismissed, which UIKit refuses with only a log
 * line, and the picker's promise would never settle (expo-image-picker presents from
 * `currentViewController()`, the topmost presented controller).
 *
 * The end is read from the machine, not from the picker: first the tray entering Choosing for this
 * attempt, then leaving it.
 */
export const chooseFrom = (
  data: LiveData,
  thread: ThreadId,
  shared: boolean,
  source: attaching.Source,
): Effect.Effect<void> => {
  const machine = trayFor(data, thread, shared)
  const attempt = randomUUID()
  data.registry.set(machine.send, attaching.TrayEvents.Choose({ attempt, source }))
  return AtomRegistry.toStream(data.registry, machine.result).pipe(
    Stream.dropWhile((result) => !choosingIn(result, attempt)),
    Stream.dropWhile((result) => choosingIn(result, attempt)),
    Stream.take(1),
    Stream.runDrain,
  )
}

/** A photo tapped in the sheet's recent strip joins the tray as if chosen. */
export const addRecent = (
  data: LiveData,
  thread: ThreadId,
  shared: boolean,
  photo: attaching.Chosen,
): void =>
  data.registry.set(
    trayFor(data, thread, shared).send,
    attaching.TrayEvents.Add({
      files: [
        {
          key: randomUUID(),
          name: photo.name,
          uri: photo.uri,
          mimeType: photo.mimeType,
          size: photo.size,
        },
      ],
    }),
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
