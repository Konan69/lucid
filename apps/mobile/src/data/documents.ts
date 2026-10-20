import type { LibraryFolderId, LibraryShelf } from '@vivid/contracts'
import { Effect, Option, Schema } from 'effect'
import { randomUUID } from 'expo-crypto'
import * as DocumentPicker from 'expo-document-picker'
import { File, Paths } from 'expo-file-system'
import * as Sharing from 'expo-sharing'
import { Platform } from 'react-native'
import { uploadOutcome } from '../../../web/src/data/library'
import { libraryAddress } from './server'
import type { SignedIn } from './session'
import { bearer, request } from './transport'

/**
 * The Library's bytes: adding a file from the phone and opening the original of one. Bytes travel
 * over plain HTTP beside the live socket, so each request carries the session's bearer token
 * itself. What is on a shelf is still a live query; nothing here keeps a copy of it.
 */

/** The file could not be fetched or handed to another app, in a sentence the screen can show. */
export class DocumentUnavailable extends Schema.TaggedError<DocumentUnavailable>()(
  'DocumentUnavailable',
  { message: Schema.String },
  { title: 'Document unavailable' },
) {}

const UNAVAILABLE = 'That file could not be opened. Try again.'
const NOWHERE = 'This device has nowhere to open that file.'

/** A name the device's file system accepts, keeping the extension other apps choose by. */
const safeName = (name: string) => name.replace(/[^a-zA-Z0-9._-]/gu, '_')

/**
 * On a device the file is downloaded to the cache and handed to the share sheet, which is how a
 * phone opens a PDF or sends it on.
 */
const openOnDevice = Effect.fn('Documents.openOnDevice')(function* (
  session: SignedIn,
  path: string,
  name: string,
) {
  const file = yield* Effect.tryPromise({
    try: () =>
      File.downloadFileAsync(
        libraryAddress(session.server, path),
        new File(Paths.cache, `${randomUUID()}-${safeName(name)}`),
        { headers: bearer(session.token) },
      ),
    catch: () => new DocumentUnavailable({ message: UNAVAILABLE }),
  })
  const shareable = yield* Effect.tryPromise({
    try: () => Sharing.isAvailableAsync(),
    catch: () => new DocumentUnavailable({ message: NOWHERE }),
  })
  if (!shareable) return yield* new DocumentUnavailable({ message: NOWHERE })
  return yield* Effect.tryPromise({
    try: () => Sharing.shareAsync(file.uri),
    catch: () => new DocumentUnavailable({ message: UNAVAILABLE }),
  })
})

/** In the browser preview the file is fetched and saved through a link, as a browser downloads. */
const openInBrowser = Effect.fn('Documents.openInBrowser')(function* (
  session: SignedIn,
  path: string,
  name: string,
) {
  const response = yield* Effect.tryPromise({
    try: () =>
      request(libraryAddress(session.server, path), {
        method: 'GET',
        headers: bearer(session.token),
      }),
    catch: () => new DocumentUnavailable({ message: UNAVAILABLE }),
  })
  if (!response.ok) return yield* new DocumentUnavailable({ message: UNAVAILABLE })
  const blob = yield* Effect.tryPromise({
    try: () => response.blob(),
    catch: () => new DocumentUnavailable({ message: UNAVAILABLE }),
  })
  return yield* Effect.sync(() => {
    const address = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = address
    anchor.download = name
    anchor.click()
    // The download reads the address after the click returns; a minute is ample for it to start.
    setTimeout(() => URL.revokeObjectURL(address), 60_000)
  })
})

// ── Adding a file ──────────────────────────────────────────────────────────

/** What the Library reads. The picker only offers these, and the server refuses anything else. */
const READABLE = ['application/pdf', 'text/plain', 'text/markdown'] as const

/** The largest file the server takes; checked here so a refusal does not cost an upload. */
const LARGEST = 10 * 1024 * 1024

/** A file the Person chose on this device, not yet sent anywhere. */
export interface Chosen {
  readonly name: string
  readonly uri: string
}

const UNPICKABLE = 'This device could not open its files. Try again.'
const TOO_LARGE = 'Choose a file smaller than 10 MB.'
const UNSENT = 'That file did not reach Vivid. Check your connection and try again.'

/**
 * Whether the system's file picker is open. On Android the picker is another app's screen, so the
 * phone reports Vivid as in the background while the Person is still in the middle of something
 * here. A restart into a downloaded update waits for a real backgrounding (`update.ts`).
 */
let choosing = false
export const isChoosing = (): boolean => choosing

/**
 * Asks the Person for one file. Closing the picker without choosing is not a failure: it is
 * nothing chosen.
 */
export const chooseDocument = Effect.fn('Documents.choose')(function* () {
  choosing = true
  const picked = yield* Effect.tryPromise({
    try: () => DocumentPicker.getDocumentAsync({ type: [...READABLE], copyToCacheDirectory: true }),
    catch: () => new DocumentUnavailable({ message: UNPICKABLE }),
  }).pipe(
    Effect.ensuring(
      Effect.sync(() => {
        choosing = false
      }),
    ),
  )
  const asset = picked.canceled ? undefined : picked.assets[0]
  if (asset === undefined) return Option.none<Chosen>()
  if (asset.size !== undefined && asset.size > LARGEST) {
    return yield* new DocumentUnavailable({ message: TOO_LARGE })
  }
  return Option.some<Chosen>({ name: asset.name, uri: asset.uri })
})

/**
 * Sends a chosen file to a shelf, into a folder or to the top of the shelf. The server answers
 * once it has stored the file; reading it continues after that, and the shelf's live query shows
 * the item move from "reading" to ready. The answer is decoded by the same function the web uses.
 */
export const uploadDocument = Effect.fn('Documents.upload')(function* (
  session: SignedIn,
  chosen: Chosen,
  destination: { readonly shelf: LibraryShelf; readonly folderId: LibraryFolderId | null },
) {
  const answer = yield* Effect.tryPromise({
    // Building the form is inside the attempt: a file that cannot be read is a file not sent. The
    // body is read inside it too, so the one abort signal covers the whole upload and its answer.
    try: (signal) => {
      const form = new FormData()
      // `expo-file-system`'s File is a Blob read from disk, which is what Expo's fetch sends.
      form.append('file', new File(chosen.uri), chosen.name)
      form.append('shelf', destination.shelf)
      if (destination.folderId !== null) form.append('folderId', destination.folderId)
      return request(libraryAddress(session.server, ''), {
        method: 'POST',
        headers: bearer(session.token),
        body: form,
        signal,
      }).then((response) => response.text().then((body) => ({ status: response.status, body })))
    },
    catch: () => new DocumentUnavailable({ message: UNSENT }),
  })
  return yield* Effect.fromResult(uploadOutcome(answer.status, answer.body))
})

/**
 * The whole of adding a file: ask for one, and send it if one was chosen. It answers with
 * nothing when the Person closed the picker, which is not something to report.
 */
export const addDocument = Effect.fn('Documents.add')(function* (
  session: SignedIn,
  destination: { readonly shelf: LibraryShelf; readonly folderId: LibraryFolderId | null },
) {
  const chosen = yield* chooseDocument()
  if (Option.isNone(chosen)) return Option.none()
  return Option.some(yield* uploadDocument(session, chosen.value, destination))
})

/** Opens the original of a Library item: `path` is its address under the Library's byte routes. */
export const openDocument = (session: SignedIn, path: string, name: string) =>
  Platform.OS === 'web' ? openInBrowser(session, path, name) : openOnDevice(session, path, name)

/** The address a citation in Vivid's reply points at, which the Thread opens through the Library. */
export const CITATION_ADDRESS = 'https://vivid-library.invalid/source'

/**
 * Turns Vivid's bracketed citations (`[brief.pdf, p.3]`) into links the Thread can open. The
 * address is one no network will ever resolve; the Thread recognises it and asks the Library for
 * the named source instead of following it.
 */
export function linkCitations(text: string) {
  return text.replace(
    /\[([^\]\n]+?\.(?:pdf|md|markdown|txt))(?:,\s*p\.(\d+))?\](?!\()/giu,
    (_, name: string, page?: string) =>
      `[${name}${page ? `, p.${page}` : ''}](${CITATION_ADDRESS}?name=${encodeURIComponent(name)})`,
  )
}
