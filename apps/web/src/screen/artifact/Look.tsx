import { ArtifactContent, ArtifactHolds, type ArtifactDetail } from '@vivid/contracts'
import { artifacts } from '@vivid/state'
import { File, FileImage, FileText, Hash } from 'lucide-react'
import { Option } from 'effect'
import type { ReactNode } from 'react'
import { cn } from '../../ui/cn'
import { Emblem, type Hue } from '../Emblem'

/**
 * How an Artifact looks before it is opened: its kind as a mark, and its first page.
 *
 * The marks follow the Library's (`screen/Library.tsx` `KIND`): a kind of thing has one hue from
 * the face colours and one glyph, so a PDF made by Vivid and a PDF the Person uploaded are known
 * by the same red square. A document is Vivid's Markdown, the Library's blue `#`.
 */

type Kind = 'document' | 'pdf' | 'word' | 'picture' | 'other'

const KIND = {
  document: { hue: 'blue', icon: <Hash /> },
  pdf: { hue: 'red', icon: <FileText /> },
  word: { hue: 'cyan', icon: <FileText /> },
  picture: { hue: 'magenta', icon: <FileImage /> },
  other: { hue: 'gray', icon: <File /> },
} as const satisfies Record<Kind, { hue: Hue; icon: ReactNode }>

/** The kind a file's type makes it, for its mark. */
const fileKind = (mimeType: string): Kind => {
  if (mimeType === 'application/pdf') return 'pdf'
  if (mimeType.includes('wordprocessingml') || mimeType === 'application/msword') return 'word'
  if (mimeType.startsWith('image/')) return 'picture'
  return 'other'
}

/** The kind of a shelf row, from its newest holds. */
export const kindOfHolds = (holds: ArtifactHolds): Kind =>
  ArtifactHolds.match(holds, {
    Document: () => 'document',
    File: ({ output }) => fileKind(output.mimeType),
  })

/** A kind's mark: its glyph in white on its hue. */
export function Mark({ kind, size }: { kind: Kind; size: number }) {
  return (
    <Emblem hue={KIND[kind].hue} size={size}>
      {KIND[kind].icon}
    </Emblem>
  )
}

/**
 * The first page of a version, in a frame of the given holds. A picture is the file's own (the
 * PNG) or its rendered first page (PDF, Word); a document is its opening lines on a sheet, as the
 * Library draws a read file (`Sheet`); a file with no picture is an empty sheet under its mark.
 */
export function FirstPage({ detail, className }: { detail: ArtifactDetail; className: string }) {
  const { artifact, shown, content } = detail
  const picture = artifacts.pictureRole(content)
  return (
    <span className={cn('relative block overflow-hidden rounded-control bg-surface-2', className)}>
      {Option.isSome(picture) ? (
        <img
          src={artifacts.artifactAddress(artifact.id, shown.number, picture.value)}
          alt=""
          // A page is read from its top, so a rendered page fills the frame from its head. A
          // picture is shown whole: cropping it would cut off what it is a picture of.
          className={cn(
            'absolute inset-0 size-full picture-edge',
            picture.value === 'preview' ? 'object-cover object-top' : 'object-contain',
          )}
          draggable={false}
        />
      ) : (
        <span
          aria-hidden
          className="absolute inset-x-5 top-3 -bottom-2 flex flex-col gap-1.5 overflow-hidden rounded-t-sm bg-surface-3 px-3 pt-3 edge"
        >
          {ArtifactContent.match(content, {
            Document: ({ body }) => (
              <span className="line-clamp-8 text-meta wrap-break-word whitespace-pre-line text-ink-3">
                {artifacts.openingLines(body)}
              </span>
            ),
            File: () => (
              <span className="flex flex-1 items-center justify-center pb-3">
                <Mark kind={kindOfHolds(artifacts.holdsOf(content))} size={36} />
              </span>
            ),
          })}
        </span>
      )}
    </span>
  )
}
