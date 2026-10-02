import { Result } from 'effect'
import { FileText, X } from 'lucide-react'
import { useState } from 'react'
import { run } from '../../data/app'
import { upload } from '../../data/library'
import { cn } from '../../ui/cn'

/**
 * Files a Person gives Vivid with what they say. A document (a PDF, a text or Markdown file) goes
 * to their own shelf of the Library, where Vivid can read it now and find it again later, and the
 * message names it; nothing is pasted into the conversation. Each file shows where it stands while
 * it is on its way, and one the server refuses says why and can be taken off.
 */

/** What can be attached: what the Library reads. */
export const ATTACHABLE = '.pdf,.md,.txt,application/pdf,text/markdown,text/plain'

/** Where one attached file stands. */
type Standing =
  | { readonly at: 'sending'; readonly percent: number }
  | { readonly at: 'kept' }
  | { readonly at: 'refused'; readonly why: string }

export interface Attachment {
  readonly key: string
  readonly name: string
  readonly standing: Standing
}

/** The line a message carries for each file that made it, so Vivid knows what to read. */
const mention = (attachment: Attachment) => `Attached: “${attachment.name}” (in my Library)`

/**
 * The files attached to the message being written. They live with the composer: sending the
 * message takes the kept ones with it and starts again from none.
 */
export function useAttachments() {
  const [files, setFiles] = useState<ReadonlyArray<Attachment>>([])

  /** Replaces one file's standing, leaving a file that was taken off meanwhile off. */
  const stand = (key: string, standing: Standing) =>
    setFiles((now) => now.map((file) => (file.key === key ? { ...file, standing } : file)))

  async function send(file: File) {
    const key = crypto.randomUUID()
    setFiles((now) => [...now, { key, name: file.name, standing: { at: 'sending', percent: 0 } }])
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
      for (const file of picked) void send(file)
    },
    remove: (key: string) => setFiles((now) => now.filter((file) => file.key !== key)),
    /** Still on its way: a message sent now would not carry it. */
    sending: files.some((file) => file.standing.at === 'sending'),
    /** What the message says about the files that made it, and forgets them. */
    take: () => {
      const lines = files.filter((file) => file.standing.at === 'kept').map(mention)
      setFiles([])
      return lines
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
          <FileText className="size-4 shrink-0 text-ink-3" />
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
