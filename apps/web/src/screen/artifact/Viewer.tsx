import {
  ArtifactContent,
  type ArtifactDetail,
  type ArtifactFile,
  type ArtifactId,
  type ArtifactVersion,
} from '@vivid/contracts'
import { artifacts, LiveState, makeWhen, revising, thisReader } from '@vivid/state'
import { Option, Predicate } from 'effect'
import { Download, ExternalLink, PencilLine } from 'lucide-react'
import { useState } from 'react'
import {
  artifactLive,
  closeEditor,
  downloadDocument,
  editDocument,
  saveDocument,
  useRevising,
  type Asked,
} from '../../data/artifact'
import { useLive } from '../../data/live'
import { engine } from '../../data/runtime'
import { Alert } from '../../ui/alert'
import { Button, buttonVariants } from '../../ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../../ui/dialog'
import { Markdown } from '../../ui/Markdown'
import { Skeleton } from '../../ui/skeleton'
import { Textarea } from '../../ui/textarea'
import { Refused } from '../thread/Rows'
import { kindOfHolds, Mark } from './Look'

const when = makeWhen(thisReader())

/**
 * One Artifact opened: the version being read, drawn whole, with every version beside it and
 * what can be done with it. Opened from its card in a Thread and from the Library.
 *
 * A file is its picture (a PNG itself, a PDF or Word file's rendered first page) with Open, which
 * shows the file in a new tab where the browser can (`artifacts.opensInline`), and Download. A
 * document is its Markdown, with Download (as a `.md` file) and Edit, which revises it by hand
 * through the editor machine (`@vivid/state` `revising`).
 *
 * Which version is read is the dialog's own choice and starts at the one it was opened on. Edit
 * is offered on the newest only: a revision is made from the newest, and the server refuses one
 * made from anything older.
 */
export function ArtifactViewer({
  opened,
  onClose,
}: {
  /** What was opened, or nothing while the dialog is shut. */
  opened: Option.Option<Asked>
  onClose: () => void
}) {
  return (
    <Dialog
      open={Option.isSome(opened)}
      onOpenChange={(open) => {
        if (open) return
        // Closing the dialog closes an editor in it; what was typed is dropped.
        closeEditor()
        onClose()
      }}
    >
      <DialogContent solid className="sm:max-w-3xl">
        {Option.isSome(opened) && <Opened key={opened.value.id} asked={opened.value} />}
      </DialogContent>
    </Dialog>
  )
}

/** The dialog's contents for one Artifact, at the version the Person picked. */
function Opened({ asked }: { asked: Asked }) {
  const [version, setVersion] = useState<Option.Option<number>>(
    'version' in asked ? Option.some(asked.version) : Option.none(),
  )
  const reading: Asked = Option.match(version, {
    onNone: () => ({ id: asked.id }),
    onSome: (number) => ({ id: asked.id, version: number }),
  })
  const query = artifactLive.get(reading)
  const state = useLive(query)
  return LiveState.$match(state, {
    Loading: () => <Loading />,
    Failed: ({ failure }) =>
      Predicate.isTagged(failure, 'NotFound') ? (
        <DialogHeader>
          <DialogTitle>Removed</DialogTitle>
          <DialogDescription>This was removed from its Thread.</DialogDescription>
        </DialogHeader>
      ) : (
        <Refused onRetry={() => engine.registry.refresh(query.atom)}>
          This could not be opened right now.
        </Refused>
      ),
    Ready: ({ value }) => (
      <Shown
        detail={value}
        onPick={(number) =>
          setVersion(number === value.artifact.version ? Option.none() : Option.some(number))
        }
        onNewest={() => setVersion(Option.none())}
      />
    ),
  })
}

/** The dialog's holds while the first answer is on its way, so it does not jump when it lands. */
function Loading() {
  return (
    <>
      <DialogHeader>
        <DialogTitle className="sr-only">Opening</DialogTitle>
        <Skeleton className="h-5 w-48" />
        <Skeleton className="h-4 w-32" />
      </DialogHeader>
      <Skeleton className="aspect-4/3 w-full" />
    </>
  )
}

/** A version, read: its header, its body, the versions there are, and the actions. */
function Shown({
  detail,
  onPick,
  onNewest,
}: {
  detail: ArtifactDetail
  onPick: (number: number) => void
  onNewest: () => void
}) {
  const { artifact, shown, content, versions } = detail
  const editor = useRevising()
  const editing = revising.isEditing(editor, artifact.id)
  const newest = shown.number === artifact.version
  const holds = artifacts.holdsOf(content)
  return (
    <>
      <DialogHeader>
        {/* The close mark sits in the corner; the header keeps clear of it. */}
        <div className="flex min-w-0 items-center gap-3 pe-8">
          <Mark kind={kindOfHolds(holds)} size={32} />
          <span className="min-w-0 flex-1">
            <DialogTitle>
              <span className="block truncate">{artifact.title}</span>
            </DialogTitle>
            <DialogDescription>
              <span className="block truncate tabular-nums">
                {artifacts.holdsLine(holds, shown.number)} · {artifacts.madeByWords(shown.madeBy)}
              </span>
            </DialogDescription>
          </span>
        </div>
      </DialogHeader>
      {!newest && (
        <p className="rounded-control bg-surface-2 px-3 py-2 text-label text-ink-2" role="status">
          You are reading version {shown.number}. The newest is version {artifact.version}.{' '}
          <button
            type="button"
            onClick={onNewest}
            className="cursor-pointer font-title text-primary-ink underline-offset-4 hover:underline"
          >
            Read the newest
          </button>
        </p>
      )}
      <div className="flex min-w-0 flex-col gap-5 sm:flex-row">
        <div className="min-w-0 flex-1">
          {ArtifactContent.match(content, {
            Document: ({ body }) =>
              editing ? (
                <Editor key={`${artifact.id}@${shown.number}`} body={body} />
              ) : (
                <div className="max-h-120 overflow-y-auto rounded-card bg-surface-2 px-5 py-4 text-body edge *:first:mt-0 *:last:mb-0">
                  <Markdown content={body} />
                </div>
              ),
            File: ({ output }) => <FileBody detail={detail} output={output} />,
          })}
        </div>
        <Versions versions={versions} shown={shown.number} onPick={onPick} />
      </div>
      {!editing && (
        <div className="flex flex-wrap items-center justify-end gap-2">
          {ArtifactContent.match(content, {
            Document: ({ body }) => (
              <>
                <Button variant="outline" onClick={() => downloadDocument(artifact.title, body)}>
                  <Download />
                  Download
                </Button>
                {newest && (
                  <Button onClick={() => editDocument(artifact.id, shown.number)}>
                    <PencilLine />
                    Edit
                  </Button>
                )}
              </>
            ),
            File: ({ output }) => (
              <FileActions id={artifact.id} version={shown.number} output={output} quiet={false} />
            ),
          })}
        </div>
      )}
    </>
  )
}

/**
 * A file's body: its picture whole, scrolled inside the dialog when it is taller than the room.
 * A file with no picture says how to read it instead of showing an empty frame.
 */
function FileBody({ detail, output }: { detail: ArtifactDetail; output: ArtifactFile }) {
  const picture = artifacts.pictureRole(detail.content)
  if (Option.isNone(picture)) {
    return (
      <p className="rounded-card bg-surface-2 px-5 py-8 text-center text-label text-pretty text-ink-3 edge">
        {artifacts.fileKind(output)} files have no preview here. Download it to open it on your
        computer.
      </p>
    )
  }
  return (
    <div className="max-h-120 overflow-y-auto rounded-card bg-surface-2 edge">
      <img
        src={artifacts.artifactAddress(detail.artifact.id, detail.shown.number, picture.value)}
        alt={
          picture.value === 'preview'
            ? `First page of ${detail.artifact.title}`
            : detail.artifact.title
        }
        className="block w-full"
      />
    </div>
  )
}

/**
 * Open and Download for a file. Both are links to the version's bytes on the app's own origin, so
 * the browser sends the session with them and a download keeps the file's own name.
 */
export function FileActions({
  id,
  version,
  output,
  quiet,
}: {
  id: ArtifactId
  version: number
  output: ArtifactFile
  /** In a Thread, where many cards may stand, Open is an outline like Download, not a fill. */
  quiet: boolean
}) {
  const address = artifacts.artifactAddress(id, version, 'output')
  return (
    <>
      <a href={address} download={output.name} className={buttonVariants({ variant: 'outline' })}>
        <Download />
        Download
      </a>
      {artifacts.opensInline(output) && (
        <a
          href={address}
          target="_blank"
          rel="noreferrer"
          className={buttonVariants({ variant: quiet ? 'outline' : 'default' })}
        >
          <ExternalLink />
          Open
        </a>
      )}
    </>
  )
}

/** Every version, newest first; the one being read is marked, and any other can be picked. */
function Versions({
  versions,
  shown,
  onPick,
}: {
  versions: ReadonlyArray<ArtifactVersion>
  shown: number
  onPick: (number: number) => void
}) {
  // "Now" for the times below is when the list was drawn; it is not open long enough to drift.
  const [opened] = useState(() => Date.now())
  return (
    <nav aria-label="Versions" className="min-w-0 sm:w-52 sm:shrink-0">
      <h3 className="mb-1.5 text-label font-title text-ink-3">
        {versions.length === 1 ? '1 version' : `${versions.length} versions`}
      </h3>
      <ol className="-m-0.5 flex max-h-120 flex-col gap-0.5 overflow-y-auto p-0.5">
        {versions.map((version) => (
          <li key={version.number}>
            <button
              type="button"
              aria-current={version.number === shown ? 'true' : undefined}
              onClick={() => onPick(version.number)}
              className="w-full cursor-pointer rounded-row px-2.5 py-1.5 text-left transition-colors duration-(--dur-fast) hover:bg-wash-hover aria-current:bg-wash-selected"
            >
              <span className="block text-label font-title text-ink tabular-nums">
                Version {version.number}
              </span>
              <span className="block truncate text-meta font-meta text-ink-3">
                {when(version.at, opened)} · {artifacts.madeByWords(version.madeBy)}
              </span>
              {version.note !== undefined && (
                <span className="mt-0.5 line-clamp-2 text-meta text-ink-2">{version.note}</span>
              )}
            </button>
          </li>
        ))}
      </ol>
    </nav>
  )
}

/**
 * The document's Markdown in a field. It starts from what the Person had typed when a save was
 * refused (the machine keeps it), or else from the version being read. Save is held while the
 * text is empty, unchanged or already being saved; the machine refuses a second press as well.
 */
function Editor({ body }: { body: string }) {
  const editor = useRevising()
  const [typed, setTyped] = useState(() => Option.getOrElse(revising.keptText(editor), () => body))
  const valid = revising.typedBody(typed)
  const waiting = revising.isWaiting(editor)
  const notice = revising.noticeOf(editor)
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault()
        if (Option.isSome(valid)) saveDocument(valid.value)
      }}
    >
      {Option.isSome(notice) && (
        <Alert variant={revising.Reading.guards.Refused(editor) ? 'destructive' : 'default'}>
          {notice.value}
        </Alert>
      )}
      <Textarea
        aria-label="Document text"
        autoFocus
        value={typed}
        onChange={(event) => setTyped(event.currentTarget.value)}
        readOnly={waiting}
        className="max-h-120 min-h-80"
      />
      <div className="flex items-center justify-end gap-2">
        <Button type="button" variant="ghost" onClick={closeEditor}>
          Cancel
        </Button>
        <Button
          type="submit"
          disabled={waiting || Option.isNone(valid) || (typed === body && Option.isNone(notice))}
        >
          {waiting ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </form>
  )
}
