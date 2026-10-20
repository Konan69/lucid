import { library } from '@vivid/state'
import { Effect } from 'effect'

/**
 * The browser's half of the Library: sending a file's bytes. Everything a surface shares (the
 * shelves, the levels, the reads, how the upload route's answer is read) is `library` in
 * `@vivid/state`; only the platform API that carries the bytes lives here.
 */

/**
 * Sends one file to the shelf in view and reports how much of it has left the browser.
 *
 * This is `XMLHttpRequest` because it is the only browser API that reports upload progress; it is
 * wrapped here once and nowhere else. The path is relative, so the request goes to the origin the
 * page came from and carries the session cookie. Interrupting the Effect aborts the request.
 */
export const upload = Effect.fn('Library.upload')(function* (
  file: File,
  destination: library.UploadDestination,
  onProgress: (percent: number) => void,
) {
  return yield* Effect.callback<library.Uploaded, library.UploadRefused>((resume) => {
    const form = new FormData()
    form.set('file', file)
    form.set('shelf', destination.shelf)
    if (destination.folderId !== null) form.set('folderId', destination.folderId)
    const request = new XMLHttpRequest()
    request.open('POST', '/api/library')
    request.responseType = 'text'
    request.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable) onProgress(Math.round((event.loaded / event.total) * 100))
    })
    request.addEventListener('error', () =>
      resume(
        Effect.fail(
          new library.UploadRefused({ message: 'Vivid could not be reached. Try again.' }),
        ),
      ),
    )
    request.addEventListener('load', () =>
      resume(Effect.fromResult(library.uploadOutcome(request.status, request.responseText))),
    )
    request.send(form)
    return Effect.sync(() => request.abort())
  })
})
