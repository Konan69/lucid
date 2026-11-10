import {
  ArtifactAuthor,
  ArtifactContent,
  ArtifactMessage,
  ArtifactPreview,
  ArtifactHolds,
  type ArtifactFile,
  type ArtifactFileRole,
  type ArtifactId,
} from '@vivid/contracts'
import { Option, Schema } from 'effect'
import { formatBytes } from './library.js'

/**
 * Artifacts as every surface draws them: where a version's bytes are read, what kind of thing a
 * file is in a Person's words, which picture stands for it, and which reply delivered one.
 *
 * Vivid delivers an Artifact with `write_document` or `publish_file`; both tools leave the
 * Artifact and version they made as the tool's output (`ArtifactMessage`, written by the runtime
 * in `packages/agent/runtime/src/tools/documents.ts` `delivered`). The bytes are served by the
 * server at one address per version and role (`apps/server/src/artifacts/bytes.ts`), to whoever
 * may read the Thread, with the app's own credentials: a browser's session cookie, a phone's
 * bearer token.
 */

const decodeDelivered = Schema.decodeUnknownOption(ArtifactMessage)

/**
 * The Artifact a tool call delivered, when its output is one. Any other output is not. A tool's
 * output arrives undecoded in the conversation (`ConversationPart`), so it is read here, once.
 */
export const deliveredArtifact = (output: Parameters<typeof decodeDelivered>[0]) =>
  Option.map(decodeDelivered(output), (message) => message.artifact)

/** Where one version's file of one role is read, as a path on the app's own server. */
export const artifactAddress = (id: ArtifactId, version: number, role: ArtifactFileRole) =>
  `/api/artifacts/${encodeURIComponent(id)}/versions/${version}/files/${role}`

/**
 * What a file is, in a Person's words. The common ones by their type; anything else by its
 * extension, which is what a Person sees in their own files.
 */
const KNOWN = new Map([
  ['application/pdf', 'PDF'],
  ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'Word document'],
  ['application/msword', 'Word document'],
  ['image/png', 'PNG image'],
  ['image/jpeg', 'JPEG image'],
])

/** A file's type in words: "PDF", "Word document", or its extension ("XLSX file"). */
export const fileKind = (file: ArtifactFile): string => {
  const known = KNOWN.get(file.mimeType)
  if (known !== undefined) return known
  const dot = file.name.lastIndexOf('.')
  return dot > 0 && dot < file.name.length - 1
    ? `${file.name.slice(dot + 1).toUpperCase()} file`
    : 'File'
}

/** What a shelf row or a card says the thing is. A document is Vivid's own Markdown text. */
const holdsKind = (holds: ArtifactHolds): string =>
  ArtifactHolds.match(holds, { Document: () => 'Document', File: ({ output }) => fileKind(output) })

/** What an opened version's holds is, as a shelf row knows it. */
export const holdsOf = (content: ArtifactContent): ArtifactHolds =>
  ArtifactContent.match<ArtifactHolds>(content, {
    Document: () => ArtifactHolds.cases.Document.make({}),
    File: ({ output }) => ArtifactHolds.cases.File.make({ output }),
  })

/**
 * The bytes that stand for a file as a picture, when there is one: the rendered first page of a
 * PDF or Word file (`preview`), or the output itself when it is the picture (a PNG). A document is
 * text and is drawn as text.
 */
export const pictureRole = (content: ArtifactContent): Option.Option<ArtifactFileRole> =>
  ArtifactContent.match(content, {
    Document: () => Option.none(),
    File: ({ preview, output }) =>
      ArtifactPreview.match(preview, {
        Separate: () => Option.some<ArtifactFileRole>('preview'),
        Output: () =>
          output.mimeType.startsWith('image/')
            ? Option.some<ArtifactFileRole>('output')
            : Option.none(),
      }),
  })

/**
 * Whether a browser can show the file itself. The server serves only inert pictures and PDFs
 * inline and sends everything else as a download (`bytes.ts`), so only these get "Open".
 */
export const opensInline = (file: ArtifactFile) =>
  ['image/png', 'image/jpeg', 'application/pdf'].includes(file.mimeType)

/** Who made a version, as its row says it. */
export const madeByWords = (author: ArtifactAuthor) =>
  ArtifactAuthor.match(author, { Vivid: () => 'Vivid', Person: ({ person }) => person.name })

/**
 * The name a document is saved under when a Person downloads it: its title, with what a file
 * system refuses taken out, as Markdown.
 */
export const documentFileName = (title: string) =>
  `${title.replace(/[\\/:*?"<>|]/gu, '-').trim()}.md`

/** The line under an Artifact's name: what it is, how big when it is a file, and which version. */
export const holdsLine = (holds: ArtifactHolds, version: number) =>
  ArtifactHolds.match(holds, {
    Document: () => `Document · Version ${version}`,
    File: ({ output }) =>
      `${fileKind(output)} · ${formatBytes(output.byteLength)} · Version ${version}`,
  })

/**
 * A document's opening lines as a page shows them small: the Markdown marks that would read as
 * noise at that size (a heading's `#`, emphasis stars) are left out, and the words kept.
 */
export const openingLines = (body: string) =>
  body
    .slice(0, 600)
    .replace(/^#{1,6}\s+/gmu, '')
    .replace(/[*_`]{1,3}/gu, '')
