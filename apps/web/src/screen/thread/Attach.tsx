import { Option, Result } from 'effect'
import { FileText, X } from 'lucide-react'
import { useState } from 'react'
import { run } from '../../data/app'
import { upload } from '../../data/library'
import { cn } from '../../ui/cn'

/**
 * Files a Person gives Vivid with what they say. A document (a PDF, a text or Markdown file) goes
 * to their own shelf of the Library, where Vivid can read it now and find it again later, and the
 * message names it; nothing is pasted into the conversation. A picture travels with the message
 * itself, so Vivid sees it. Each file shows where it stands while it is on its way, and one that
 * cannot go says why and can be taken off.
 */

/** Documents: what the Library reads. */
const DOCUMENTS = '.pdf,.md,.txt,application/pdf,text/markdown,text/plain'
/** Pictures: what a message can carry. */
const PICTURES = 'image/png,image/jpeg,image/webp,image/gif'

/** What the file picker offers, with or without pictures. */
export const attachable = (pictures: boolean) => (pictures ? `${DOCUMENTS},${PICTURES}` : DOCUMENTS)

/** The server takes at most four pictures a message, each up to five megabytes. */
const MOST_PICTURES = 4
const LARGEST_PICTURE = 5 * 1024 * 1024

/** A picture as a message carries it: its bytes in base64, and what kind of image they are. */
export interface Picture {
  readonly type: 'image'
  readonly mimeType: string
  readonly data: string
  readonly filename: string
}

/** Where one attached file stands. */
type Standing =
  | { readonly at: 'sending'; readonly percent: number }
  | { readonly at: 'kept' }
  | { readonly at: 'refused'; readonly why: string }

export interface Attachment {
  readonly key: string
  readonly name: string
  readonly standing: Standing
  /** Present when the file is a picture that will travel with the message. */
  readonly picture: Option.Option<Picture & { readonly preview: string }>
}

/** Reads a picture into what a message carries. The preview is the same bytes as a `data:` URL. */
const readPicture = (file: File) =>
  new Promise<Option.Option<Picture & { readonly preview: string }>>((resolve) => {
    const reader = new FileReader()
    reader.addEventListener('error', () => resolve(Option.none()))
    reader.addEventListener('load', () => {
      const preview = String(reader.result)
      resolve(
        Option.some({
          type: 'image',
          mimeType: file.type,
          // A data URL is "data:<type>;base64,<bytes>"; the message wants the bytes alone.
          data: preview.slice(preview.indexOf(',') + 1),
          filename: file.name,
          preview,
        }),
      )
    })
    reader.readAsDataURL(file)
  })

/** The line a message carries for each file that made it, so Vivid knows what to read. */
const mention = (attachment: Attachment) => `Attached: “${attachment.name}” (in my Library)`

/**
 * The files attached to the message being written. They live with the composer: sending the
 * message takes the kept ones with it and starts again from none.
 */
export function useAttachments(pictures: boolean) {
  const [files, setFiles] = useState<ReadonlyArray<Attachment>>([])

  /** Replaces one file's standing, leaving a file that was taken off meanwhile off. */
  const stand = (key: string, standing: Standing) =>
    setFiles((now) => now.map((file) => (file.key === key ? { ...file, standing } : file)))

  /** A picture is read here and waits with the message; nothing is uploaded until it is sent. */
  async function hold(file: File) {
    const key = crypto.randomUUID()
    const refused = (why: string) =>
      setFiles((now) => [
        ...now,
        { key, name: file.name, standing: { at: 'refused', why }, picture: Option.none() },
      ])
    if (!pictures) return refused('Pictures can only be sent in a private thread for now.')
    if (file.size > LARGEST_PICTURE) return refused('Too large. Pictures can be up to 5 MB.')
    const picture = await readPicture(file)
    if (Option.isNone(picture)) return refused('It could not be read. Try another file.')
    return setFiles((now) =>
      now.filter((one) => Option.isSome(one.picture)).length >= MOST_PICTURES
        ? [
            ...now,
            {
              key,
              name: file.name,
              standing: { at: 'refused', why: 'A message can carry four pictures.' },
              picture: Option.none(),
            },
          ]
        : [...now, { key, name: file.name, standing: { at: 'kept' }, picture }],
    )
  }

  async function send(file: File) {
    const key = crypto.randomUUID()
    setFiles((now) => [
      ...now,
      { key, name: file.name, standing: { at: 'sending', percent: 0 }, picture: Option.none() },
    ])
    const result = await run(
      upload(file, { shelf: 'Mine', folderId: null }, (percent) =>
        stand(key, { at: 'sending', percent }),
      ),
    )
    stand(
      key,
      Result.isSuccess(result)
        ? { at: 'kept' }
        : { at: 'refused', why: 'It did not upload. Take it off and try again.' },
    )
  }

  return {
    files,
    add: (picked: ReadonlyArray<File>) => {
      for (const file of picked) void (file.type.startsWith('image/') ? hold(file) : send(file))
    },
    remove: (key: string) => setFiles((now) => now.filter((file) => file.key !== key)),
    /** Still on its way: a message sent now would not carry it. */
    sending: files.some((file) => file.standing.at === 'sending'),
    /** What the message carries for the files that made it, and forgets them. */
    take: () => {
      const kept = files.filter((file) => file.standing.at === 'kept')
      setFiles([])
      return {
        // Documents are named in the words; pictures travel beside them.
        lines: kept.filter((file) => Option.isNone(file.picture)).map(mention),
        pictures: kept.flatMap((file) =>
          Option.match(file.picture, {
            onNone: () => [],
            onSome: ({ type, mimeType, data, filename }): ReadonlyArray<Picture> => [
              { type, mimeType, data, filename },
            ],
          }),
        ),
      }
    },
    kept: files.filter((file) => file.standing.at === 'kept').length,
  }
}

/** The attached files as chips above what is being written. */
export function Attached({
  files,
  onRemove,
}: {
  files: ReadonlyArray<Attachment>
  onRemove: (key: string) => void
}) {
  if (files.length === 0) return null
  return (
    <ul className="flex flex-wrap gap-1.5 px-4 pt-3">
      {files.map((file) => (
        <li
          key={file.key}
          className={cn(
            'flex h-8 max-w-64 items-center gap-2 rounded-control pr-1 pl-2.5 text-label',
            file.standing.at === 'refused' ? 'bg-danger-soft text-danger' : 'bg-surface-2 text-ink',
          )}
        >
          {Option.match(file.picture, {
            onNone: () => <FileText className="size-4 shrink-0 text-ink-3" />,
            onSome: (picture) => (
              <img
                src={picture.preview}
                alt=""
                className="size-6 shrink-0 rounded-xs object-cover picture-edge"
              />
            ),
          })}
          <span className="truncate">{file.name}</span>
          <span className="shrink-0 text-meta font-meta text-ink-3 tabular-nums">
            {caption(file.standing)}
          </span>
          <button
            type="button"
            aria-label={`Take off ${file.name}`}
            onClick={() => onRemove(file.key)}
            className="inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-xs text-ink-3 hover:bg-wash-pressed hover:text-ink"
          >
            <X className="size-3.5" />
          </button>
        </li>
      ))}
    </ul>
  )
}

const caption = (standing: Standing) => {
  if (standing.at === 'sending') return `${standing.percent}%`
  return standing.at === 'refused' ? standing.why : ''
}
