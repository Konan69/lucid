import {
  Workspace,
  type LibraryFolder,
  type LibraryFolderId,
  type LibraryItem,
  type LibraryShelf,
} from '@vivid/contracts'
import { Data, Effect, Option, Result } from 'effect'
import {
  Check,
  ChevronRight,
  CircleAlert,
  CircleDashed,
  ExternalLink,
  FileInput,
  FileText,
  FileType,
  Folder,
  FolderInput,
  FolderPlus,
  Hash,
  LayoutGrid,
  LibraryBig,
  MessageSquareText,
  Pencil,
  Rows3,
  Search,
  Trash2,
  Upload,
  X,
} from 'lucide-react'
import { useId, useRef, useState, type DragEvent, type FormEvent, type ReactNode } from 'react'
import * as libraryData from '../data/library'
import { changing, live, LiveState, useLive } from '../data/live'
import { act, running } from '../data/app'
import { engine } from '../data/runtime'
import { Button, IconButton } from '../ui/button'
import { cn } from '../ui/cn'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog'
import { Field, FieldLabel } from '../ui/field'
import { Input } from '../ui/input'
import { useSurface } from '../ui/Layer'
import { Live } from '../ui/Live'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui/select'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'
import { Alert } from '../ui/alert'
import { Segmented } from '../ui/Segmented'
import { SkeletonList } from '../ui/skeleton'
import { BAR } from './bar'
import { Emblem, type Hue } from './Emblem'
import { ENTER, PRESS, stagger } from './motion'

/** The shell imports this name for the item it asks Vivid about. */
export type LibraryDocument = LibraryItem
type SearchResult = libraryData.SearchResult
type LibraryList = libraryData.LibraryList

// ── One folder, live ─────────────────────────────────────────────────────────

/**
 * What is inside one folder, live.
 *
 * `live.library` answers for a shelf: every item on it, and the folders at its top. The folders
 * inside a folder come only from asking about that folder, so a folder in view is its own query,
 * one per shelf and folder, shared and kept warm exactly like the shelf's. It is declared here
 * because the Library is the only screen that walks into folders.
 */
const folderLibrary = engine.family(
  (query: { readonly shelf: LibraryShelf; readonly folderId: LibraryFolderId }) =>
    `${query.shelf}:${query.folderId}`,
  (client, query) => client.WatchLibrary(query),
)

// ── What the screen holds itself ─────────────────────────────────────────────

/**
 * What the Library is showing: a level of a shelf, the answers to a search, or one item. An item
 * is held as it was when opened, and redrawn from the live shelf whenever the shelf has it.
 */
type View = Data.TaggedEnum<{
  Browse: {}
  Results: { readonly results: ReadonlyArray<SearchResult> }
  Item: { readonly item: LibraryItem }
}>
const View = Data.taggedEnum<View>()

/** The question a dialog is asking. A move carries the folders it can go to, read when it opens. */
type Ask = Data.TaggedEnum<{
  NewFolder: {}
  RenameFolder: { readonly folder: LibraryFolder }
  MoveFolder: {
    readonly folder: LibraryFolder
    readonly destinations: ReadonlyArray<LibraryFolder>
  }
  RenameItem: { readonly item: LibraryItem }
  MoveItem: { readonly item: LibraryItem; readonly destinations: ReadonlyArray<LibraryFolder> }
}>
const Ask = Data.taggedEnum<Ask>()

/** Where one file is on its way into the Library. Only a failure has something to say. */
type UploadStatus = Data.TaggedEnum<{
  Sending: { readonly percent: number }
  Reading: {}
  Duplicate: {}
  Failed: { readonly message: string }
}>
const UploadStatus = Data.taggedEnum<UploadStatus>()

interface UploadRow {
  readonly id: string
  readonly name: string
  readonly status: UploadStatus
}

/** What a change came to: nothing to say, or the server's sentence about why it refused. */
const refusal = <Value, Failure extends { readonly message: string }>(
  result: Result.Result<Value, Failure>,
): Option.Option<string> =>
  Result.isFailure(result) ? Option.some(result.failure.message) : Option.none()

/**
 * Everything the Library keeps between renders, and what follows from it. The shelf's contents are
 * not in here: they are read from the live query for the shelf, or the folder, that is in view.
 */
function useBrowser(workspace: Workspace) {
  const [chosen, setChosen] = useState<LibraryShelf>('Mine')
  const [path, setPath] = useState<ReadonlyArray<LibraryFolder>>([])
  const [view, setView] = useState<View>(View.Browse())
  const [grid, setGrid] = useState(true)
  const [query, setQuery] = useState<Option.Option<string>>(Option.none())
  const [uploads, setUploads] = useState<ReadonlyArray<UploadRow>>([])
  const [dragging, setDragging] = useState(false)
  const [ask, setAsk] = useState<Option.Option<Ask>>(Option.none())
  const [refused, setRefused] = useState<Option.Option<string>>(Option.none())
  const dragDepth = useRef(0)

  const shelves = libraryData.shelvesOf(workspace)
  // A personal space has one shelf, whatever was chosen in a Company before switching out of it;
  // the folders walked into belong to a shelf and are left behind with it.
  const shelf: LibraryShelf = Workspace.guards.Company(workspace) ? chosen : 'Mine'
  const trail = path.filter((folder) => folder.shelf === shelf)
  const folder = Option.fromUndefinedOr(trail.at(-1))
  const folderId = Option.match(folder, { onNone: () => null, onSome: (inside) => inside.id })
  const store = Option.match(folder, {
    onNone: () => live.library.get(shelf),
    onSome: (inside) => folderLibrary.get({ shelf, folderId: inside.id }),
  })
  const contents = useLive(store)

  return {
    ask,
    contents,
    dragDepth,
    dragging,
    folder,
    folderId,
    grid,
    query,
    refused,
    setAsk,
    setChosen,
    setDragging,
    setGrid,
    setPath,
    setQuery,
    setRefused,
    setUploads,
    setView,
    shelf,
    shelves,
    store,
    uploads,
    view,
  }
}

type Browser = ReturnType<typeof useBrowser>

// ── Changes ──────────────────────────────────────────────────────────────────

/** Sending files, by the picker or by dropping them on the screen. */
function uploadActions(browser: Browser) {
  const { dragDepth, folderId, setDragging, setUploads, shelf } = browser

  const setStatus = (id: string, status: UploadStatus) =>
    setUploads((rows) => rows.map((row) => (row.id === id ? { ...row, status } : row)))

  /**
   * Sends one file. A file that got in simply leaves the upload list: the shelf is live, so the
   * item appears there by itself. Only what did not get in, or was already there, stays to be read.
   */
  function send(file: File, id: string) {
    return Effect.gen(function* () {
      const result = yield* running(
        libraryData.upload(file, { shelf, folderId }, (percent) =>
          // Once every byte has left, the server is reading the file until it answers.
          setStatus(
            id,
            percent >= 100 ? UploadStatus.Reading() : UploadStatus.Sending({ percent }),
          ),
        ),
      )
      if (Result.isFailure(result)) {
        setStatus(id, UploadStatus.Failed({ message: result.failure.message }))
        return
      }
      if (result.success.duplicate) {
        setStatus(id, UploadStatus.Duplicate())
        return
      }
      setUploads((rows) => rows.filter((row) => row.id !== id))
    })
  }

  function sendAll(files: ReadonlyArray<File>) {
    const sending = files.map((file) => ({ file, id: crypto.randomUUID() }))
    setUploads((rows) => [
      ...sending.map(({ file, id }) => ({
        id,
        name: file.name,
        status: UploadStatus.Sending({ percent: 0 }),
      })),
      ...rows,
    ])
    for (const { file, id } of sending) void act(send(file, id))
  }

  // A drag crosses many child elements, each firing enter and leave; the depth says when the
  // pointer has really left the screen.
  function dragEnter(event: DragEvent) {
    event.preventDefault()
    dragDepth.current += 1
    setDragging(true)
  }

  function dragLeave(event: DragEvent) {
    event.preventDefault()
    dragDepth.current -= 1
    if (dragDepth.current <= 0) setDragging(false)
  }

  function drop(event: DragEvent) {
    event.preventDefault()
    dragDepth.current = 0
    setDragging(false)
    const files = [...event.dataTransfer.files]
    if (files.length > 0) sendAll(files)
  }

  const dismiss = (id: string) => setUploads((rows) => rows.filter((row) => row.id !== id))

  return { dismiss, dragEnter, dragLeave, drop, sendAll }
}

/** Moving around the Library, searching it, and deleting from it. */
function browseActions(browser: Browser) {
  const { folderId, query, setAsk, setPath, setRefused, setView, shelf, store, view } = browser

  function search(event: FormEvent) {
    return Effect.gen(function* () {
      event.preventDefault()
      const text = Option.getOrElse(query, () => '').trim()
      if (text.length < 2) return
      const result = yield* running(libraryData.search(text, folderId))
      setRefused(refusal(result))
      if (Result.isSuccess(result)) setView(View.Results({ results: result.success }))
    })
  }

  function openResult(found: SearchResult) {
    return Effect.gen(function* () {
      const result = yield* running(libraryData.readItem(found.documentId))
      setRefused(refusal(result))
      if (Result.isSuccess(result)) setView(View.Item({ item: result.success }))
    })
  }

  /** The item leaves the shelf at once. If the server refuses, it is back, with the reason above it. */
  function removeItem(item: LibraryItem) {
    return Effect.gen(function* () {
      if (!window.confirm(`Delete “${item.name}” from the Library?`)) return
      setView(View.Browse())
      const result = yield* changing(
        (client) => client.DeleteLibraryItem({ id: item.id }),
        () => store.expect(libraryData.itemRemoved(item.id)),
      )
      setRefused(refusal(result))
    })
  }

  /** A folder is left only once the server has deleted it: one that is not empty stays open. */
  function removeFolder(folder: LibraryFolder) {
    return Effect.gen(function* () {
      if (!window.confirm(`Delete the folder “${folder.name}”?`)) return
      const result = yield* changing((client) => client.DeleteLibraryFolder({ id: folder.id }))
      setRefused(refusal(result))
      if (Result.isSuccess(result))
        setPath((trail) => trail.filter((each) => each.id !== folder.id))
    })
  }

  /** Reads where a thing can go, then asks. The folders of a shelf are read when they are needed. */
  function askMove(open: (destinations: ReadonlyArray<LibraryFolder>) => Ask) {
    return Effect.gen(function* () {
      const result = yield* running(libraryData.shelfFolders(shelf))
      setRefused(refusal(result))
      if (Result.isSuccess(result)) setAsk(Option.some(open(result.success)))
    })
  }

  function back() {
    setRefused(Option.none())
    if (View.$is('Browse')(view)) setPath((trail) => trail.slice(0, -1))
    else setView(View.Browse())
  }

  return { askMove, back, openResult, removeFolder, removeItem, search }
}

/**
 * What each dialog does when it is submitted, described: the dialog starts it. Every one waits for
 * the server and answers with its refusal, which the dialog shows beside the field; on success it closes the dialog. Renaming and
 * moving an item also change the shelf at once, so the list behind the dialog is already right.
 */
function dialogActions(browser: Browser) {
  const { folderId, setAsk, setPath, setView, shelf, store } = browser
  const close = () => setAsk(Option.none())

  function newFolder(name: string) {
    return Effect.gen(function* () {
      const result = yield* changing((client) =>
        client.CreateLibraryFolder({ name, shelf, parentId: folderId }),
      )
      if (Result.isSuccess(result)) close()
      return refusal(result)
    })
  }

  function renameFolder(folder: LibraryFolder, name: string) {
    return Effect.gen(function* () {
      const result = yield* changing((client) =>
        client.PatchLibraryFolder({ id: folder.id, patch: { name } }),
      )
      if (Result.isSuccess(result)) {
        // The folder in view is not part of its own contents, so its new name is taken from the
        // server's answer.
        const renamed = result.success.folder
        setPath((trail) => trail.map((each) => (each.id === renamed.id ? renamed : each)))
        close()
      }
      return refusal(result)
    })
  }

  function moveFolder(folder: LibraryFolder, parentId: LibraryFolderId | null) {
    return Effect.gen(function* () {
      const result = yield* changing((client) =>
        client.PatchLibraryFolder({ id: folder.id, patch: { parentId } }),
      )
      if (Result.isSuccess(result)) {
        // The trail that led here is no longer the way to this folder; start again from the top.
        setPath([])
        close()
      }
      return refusal(result)
    })
  }

  function renameItem(item: LibraryItem, name: string) {
    return Effect.gen(function* () {
      const result = yield* changing(
        (client) => client.PatchLibraryItem({ id: item.id, patch: { name } }),
        () => store.expect(libraryData.itemRenamed(item.id, name)),
      )
      if (Result.isSuccess(result)) {
        setView(View.Item({ item: result.success.document }))
        close()
      }
      return refusal(result)
    })
  }

  function moveItem(item: LibraryItem, destination: LibraryFolderId | null) {
    return Effect.gen(function* () {
      const result = yield* changing(
        (client) => client.PatchLibraryItem({ id: item.id, patch: { folderId: destination } }),
        () => store.expect(libraryData.itemMoved(item.id, destination)),
      )
      if (Result.isSuccess(result)) {
        setView(View.Item({ item: result.success.document }))
        close()
      }
      return refusal(result)
    })
  }

  return { close, moveFolder, moveItem, newFolder, renameFolder, renameItem }
}

// ── The screen ───────────────────────────────────────────────────────────────

/**
 * The Library: what Vivid can read. In a Company there are two shelves, the Person's own and the
 * Company's; in a personal space there is one. `onAsk` starts a Thread about one item.
 */
export function Library({ onAsk }: { onAsk: (document: LibraryDocument) => void }) {
  const me = useLive(live.me)
  return LiveState.$match(me, {
    Loading: () => (
      <LibraryPane>
        <SkeletonList of="card" count={4} />
      </LibraryPane>
    ),
    Failed: ({ failure }) => (
      <LibraryPane>
        <Alert variant="destructive">{failure.message}</Alert>
      </LibraryPane>
    ),
    Ready: ({ value }) => <LibraryBrowser workspace={value.workspace} onAsk={onAsk} />,
  })
}

/** The screen's frame before it knows where the Person is working: a title and a body. */
function LibraryPane({ children }: { children: ReactNode }) {
  return (
    <section className="flex h-full min-w-0 flex-1 flex-col bg-surface-0">
      <header className={BAR}>
        <h1 className="text-title font-title text-ink">Library</h1>
      </header>
      <div className="mx-auto w-full max-w-230 px-5 pt-2 sm:px-8">{children}</div>
    </section>
  )
}

/** The Library once the workspace is known. The whole screen takes dropped files. */
function LibraryBrowser({
  workspace,
  onAsk,
}: {
  workspace: Workspace
  onAsk: (document: LibraryDocument) => void
}) {
  const browser = useBrowser(workspace)
  const uploading = uploadActions(browser)
  const browsing = browseActions(browser)
  const dialogs = dialogActions(browser)
  const shelfName = browser.shelves.find((choice) => choice.shelf === browser.shelf)
  const place = Option.match(browser.folder, {
    onNone: () => (shelfName === undefined ? 'the Library' : shelfName.name),
    onSome: (folder) => folder.name,
  })

  return (
    <section
      onDragEnter={uploading.dragEnter}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={uploading.dragLeave}
      onDrop={uploading.drop}
      className="relative flex h-full min-w-0 flex-1 flex-col bg-surface-0"
    >
      <LibraryHeader browser={browser} browsing={browsing} onUpload={uploading.sendAll} />
      <div className="min-h-0 flex-1 scroll-fade-y overflow-y-auto">
        <div className="mx-auto flex w-full max-w-230 flex-col gap-3 px-5 pt-2 pb-10 sm:px-8">
          {Option.isSome(browser.refused) && (
            <Alert variant="destructive">{browser.refused.value}</Alert>
          )}
          <Uploads rows={browser.uploads} onDismiss={uploading.dismiss} />
          <LibraryBody
            browser={browser}
            browsing={browsing}
            onUpload={uploading.sendAll}
            onAsk={onAsk}
          />
        </div>
      </div>
      {browser.dragging && (
        <div className="pointer-events-none absolute inset-3 z-20 flex items-center justify-center rounded-card border-2 border-dashed border-primary bg-surface-0 text-center">
          <div>
            <Upload className="mx-auto size-7 text-primary-ink" />
            <p className="mt-2 text-title font-title text-ink">Drop files into {place}</p>
            <p className="mt-1 text-meta font-meta text-ink-3">
              PDF, Markdown or text, up to 10 MB each
            </p>
          </div>
        </div>
      )}
      {Option.isSome(browser.ask) && (
        <AskDialog ask={browser.ask.value} place={place} dialogs={dialogs} />
      )}
    </section>
  )
}

/** The top bar: the way back, where the Person is, and what can be done at this level. */
function LibraryHeader({
  browser,
  browsing,
  onUpload,
}: {
  browser: Browser
  browsing: ReturnType<typeof browseActions>
  onUpload: (files: ReadonlyArray<File>) => void
}) {
  const { folder, view } = browser
  const browsingShelf = View.$is('Browse')(view)
  const title = View.$match(view, {
    Browse: () =>
      Option.match(folder, { onNone: () => 'Library', onSome: (inside) => inside.name }),
    Results: () => 'Search results',
    Item: ({ item }) => item.name,
  })
  return (
    <header className={BAR}>
      {(!browsingShelf || Option.isSome(folder)) && (
        <IconButton label="Back" onClick={browsing.back}>
          <ChevronRight className="size-4 rotate-180" />
        </IconButton>
      )}
      <h1 className="min-w-0 flex-1 truncate text-title font-title text-ink">{title}</h1>
      {browsingShelf && <LevelActions browser={browser} browsing={browsing} onUpload={onUpload} />}
    </header>
  )
}

/** What can be done to the level in view: change its folder, add to it, search it, redraw it. */
function LevelActions({
  browser,
  browsing,
  onUpload,
}: {
  browser: Browser
  browsing: ReturnType<typeof browseActions>
  onUpload: (files: ReadonlyArray<File>) => void
}) {
  const { folder, grid, query, setAsk, setGrid, setQuery } = browser
  return (
    <>
      {Option.isSome(folder) && (
        <FolderActions
          onRename={() => setAsk(Option.some(Ask.RenameFolder({ folder: folder.value })))}
          onMove={() =>
            void act(
              browsing.askMove((destinations) =>
                Ask.MoveFolder({ folder: folder.value, destinations }),
              ),
            )
          }
          onDelete={() => void act(browsing.removeFolder(folder.value))}
        />
      )}
      <IconButton label="New folder" onClick={() => setAsk(Option.some(Ask.NewFolder()))}>
        <FolderPlus className="size-4" />
      </IconButton>
      <FilePicker label="Upload files" look="icon" onFiles={onUpload}>
        <Upload className="size-4" />
      </FilePicker>
      <IconButton
        label="Search the Library"
        active={Option.isSome(query)}
        onClick={() => setQuery(Option.isSome(query) ? Option.none() : Option.some(''))}
      >
        <Search className="size-4" />
      </IconButton>
      <Segmented
        label="How the Library is drawn"
        value={grid ? 'grid' : 'list'}
        options={[
          { value: 'grid', name: 'Grid', label: <LayoutGrid className="size-4" /> },
          { value: 'list', name: 'List', label: <Rows3 className="size-4" /> },
        ]}
        onChange={(drawn) => setGrid(drawn === 'grid')}
      />
    </>
  )
}

/** Rename, move or delete the folder the Person is standing in. */
function FolderActions({
  onRename,
  onMove,
  onDelete,
}: {
  onRename: () => void
  onMove: () => void
  onDelete: () => void
}) {
  return (
    <>
      <IconButton label="Rename folder" onClick={onRename}>
        <Pencil className="size-4" />
      </IconButton>
      <IconButton label="Move folder" onClick={onMove}>
        <FolderInput className="size-4" />
      </IconButton>
      <IconButton label="Delete folder" onClick={onDelete}>
        <Trash2 className="size-4" />
      </IconButton>
    </>
  )
}

/** One item's page, the answers to a search, or the level of the shelf that is in view. */
function LibraryBody({
  browser,
  browsing,
  onUpload,
  onAsk,
}: {
  browser: Browser
  browsing: ReturnType<typeof browseActions>
  onUpload: (files: ReadonlyArray<File>) => void
  onAsk: (document: LibraryDocument) => void
}) {
  const { contents, setAsk, view } = browser
  return View.$match(view, {
    Browse: () => (
      <ShelfLevel
        browser={browser}
        onUpload={onUpload}
        onSearch={(event) => void act(browsing.search(event))}
      />
    ),
    Results: ({ results }) => (
      <SearchResults results={results} onOpen={(found) => void act(browsing.openResult(found))} />
    ),
    Item: ({ item }) => {
      // The live shelf has the item's latest state (its name, whether Vivid has read it yet).
      // An item opened from a search can be filed where this query does not look; it is then
      // drawn as it was when opened.
      const current = LiveState.$match(contents, {
        Loading: () => item,
        Failed: () => item,
        Ready: ({ value }) => {
          const found = value.documents.find((candidate) => candidate.id === item.id)
          return found === undefined ? item : found
        },
      })
      return (
        <ItemDetail
          item={current}
          onAsk={() => onAsk(current)}
          onDelete={() => void act(browsing.removeItem(current))}
          onRename={() => setAsk(Option.some(Ask.RenameItem({ item: current })))}
          onMove={() =>
            void act(
              browsing.askMove((destinations) => Ask.MoveItem({ item: current, destinations })),
            )
          }
        />
      )
    },
  })
}

// ── A level of a shelf ───────────────────────────────────────────────────────

/** The shelf switch, the search field when it is open, and the folders and items at this level. */
function ShelfLevel({
  browser,
  onUpload,
  onSearch,
}: {
  browser: Browser
  onUpload: (files: ReadonlyArray<File>) => void
  onSearch: (event: FormEvent) => void
}) {
  const { contents, folder, folderId, grid, query, setChosen, setPath, setQuery, setView } = browser
  return (
    <>
      {browser.shelves.length > 1 && (
        <div>
          <Segmented
            label="Shelf"
            value={browser.shelf}
            options={browser.shelves.map((choice) => ({
              value: choice.shelf,
              name: choice.name,
              label: choice.name,
            }))}
            onChange={(shelf) => {
              // Folders belong to a shelf, so changing shelf starts again from its top.
              setChosen(shelf)
              setPath([])
            }}
          />
        </div>
      )}
      {Option.isSome(query) && (
        <form
          onSubmit={onSearch}
          className="flex items-center gap-2 rounded-control bg-surface-2 px-3 edge"
        >
          <Search className="size-4 text-ink-4" />
          <input
            autoFocus
            aria-label="Search"
            value={query.value}
            onChange={(event) => setQuery(Option.some(event.currentTarget.value))}
            placeholder={Option.match(folder, {
              onNone: () => 'Search everything Vivid has read',
              onSome: (inside) => `Search ${inside.name}`,
            })}
            className="h-10 min-w-0 flex-1 bg-transparent text-label text-ink outline-none placeholder:text-ink-4"
          />
        </form>
      )}
      <Live state={contents} loading={<SkeletonList of="card" count={4} />}>
        {(list) => {
          const level = libraryData.inFolder(list, folderId)
          if (level.folders.length === 0 && level.documents.length === 0) {
            return <NothingHere company={browser.shelf === 'Company'} onUpload={onUpload} />
          }
          return (
            <Level
              level={level}
              grid={grid}
              onOpenFolder={(inside) => setPath((trail) => [...trail, inside])}
              onOpenItem={(item) => setView(View.Item({ item }))}
            />
          )
        }}
      </Live>
    </>
  )
}

/** What a level says when it holds nothing: who will be able to read what is added, and the way in. */
function NothingHere({
  company,
  onUpload,
}: {
  company: boolean
  onUpload: (files: ReadonlyArray<File>) => void
}) {
  return (
    <div className="flex flex-col items-center px-6 pt-10 pb-16 text-center">
      <Emblem hue="violet" size={44}>
        <LibraryBig />
      </Emblem>
      <p className="mt-4 text-section font-title text-ink">Nothing here yet</p>
      <p className="mt-1 mb-5 max-w-sm text-label text-pretty text-ink-3">
        {company
          ? 'Add a file and Vivid can read it in every Member’s Threads.'
          : 'Add a file and Vivid can read it in your Threads.'}
      </p>
      <FilePicker label="Upload files" look="button" onFiles={onUpload}>
        <Upload className="size-3.5" />
        Upload files
      </FilePicker>
      {/* What can be added, as the marks the files will wear once they are here. */}
      <ul className="mt-6 flex items-center gap-4 text-meta font-meta text-ink-3">
        {(['pdf', 'markdown', 'text'] as const).map((kind) => (
          <li key={kind} className="inline-flex items-center gap-1.5">
            <KindMark kind={kind} size={20} />
            {KIND[kind].label}
          </li>
        ))}
      </ul>
    </div>
  )
}

/** The file types Vivid can read, as the browser's picker understands them. */
const READABLE = '.pdf,.md,.markdown,.txt,application/pdf,text/markdown,text/plain'

const PICKER_LOOK = {
  icon: 'size-8 justify-center text-ink-3 hover:text-ink has-focus-visible:text-ink',
  button: 'h-8 gap-2 bg-surface-3 px-3 text-label font-title text-ink edge',
} satisfies Record<string, string>

/**
 * A control that opens the browser's file picker. It is a label around the real file input, so
 * the browser opens the picker itself: no ref, no scripted click. The input is hidden from sight
 * but not from the keyboard, and the label shows where focus is.
 *
 * Drawn as an icon alone it names itself in a tooltip, under the pointer or when the input inside
 * takes focus. Drawn as a button it already says the words, so it has none.
 */
function FilePicker({
  label,
  look,
  onFiles,
  children,
}: {
  label: string
  look: keyof typeof PICKER_LOOK
  onFiles: (files: ReadonlyArray<File>) => void
  children: ReactNode
}) {
  const picker = (
    <label
      className={cn(
        'inline-flex cursor-pointer items-center rounded-control transition-colors duration-(--dur-fast) hover:bg-wash-hover has-focus-visible:bg-wash-hover',
        PICKER_LOOK[look],
      )}
    >
      <input
        type="file"
        multiple
        aria-label={label}
        accept={READABLE}
        className="sr-only"
        onChange={(event) => {
          const input = event.currentTarget
          if (input.files !== null && input.files.length > 0) onFiles([...input.files])
          // Clearing the field lets the same file be chosen again after a failure.
          input.value = ''
        }}
      />
      {children}
    </label>
  )
  if (look === 'button') return picker
  return (
    <Tooltip>
      <TooltipTrigger render={picker} />
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

/** How an item's state reads everywhere it appears; a new status fails to compile here. */
const ITEM_STATUS = {
  ready: { label: 'Ready', tone: 'text-success', mark: <Check className="size-3" /> },
  failed: { label: 'Failed', tone: 'text-danger', mark: <CircleAlert className="size-3" /> },
  processing: {
    label: 'Reading',
    tone: 'text-working',
    mark: <CircleDashed className="size-3 animate-status-pulse" />,
  },
} satisfies Record<LibraryItem['status'], { label: string; tone: string; mark: ReactNode }>

/** The line beside an item: its size once Vivid has read it, otherwise where it stands. */
const itemNote = (item: LibraryItem): string =>
  item.status === 'ready'
    ? `${libraryData.formatBytes(item.size)} · ${item.chunkCount} ${item.chunkCount === 1 ? 'passage' : 'passages'}`
    : ITEM_STATUS[item.status].label

const folderNote = (folder: LibraryFolder): string =>
  `${folder.itemCount} ${folder.itemCount === 1 ? 'item' : 'items'}`

/**
 * The kinds of file the Library holds, each with the name, hue and glyph it is known by. They
 * are the three kinds the picker accepts (`READABLE`); a file's kind is how a Person recognises
 * it in a grid before reading its name, so each has a colour of its own from the face hues.
 */
const KIND = {
  pdf: { label: 'PDF', hue: 'red', icon: <FileText /> },
  markdown: { label: 'Markdown', hue: 'blue', icon: <Hash /> },
  text: { label: 'Text', hue: 'gray', icon: <FileType /> },
} as const satisfies Record<string, { label: string; hue: Hue; icon: ReactNode }>
type Kind = keyof typeof KIND

/** What kind of file an item is, from the type it was uploaded as. Anything else reads as text. */
const kindOf = (item: LibraryItem): Kind => {
  if (item.mimeType === 'application/pdf') return 'pdf'
  if (item.mimeType === 'text/markdown' || /\.(md|markdown)$/iu.test(item.name)) return 'markdown'
  return 'text'
}

/** A file kind's mark: its glyph in white on its hue. */
function KindMark({ kind, size }: { kind: Kind; size: number }) {
  return (
    <Emblem hue={KIND[kind].hue} size={size}>
      {KIND[kind].icon}
    </Emblem>
  )
}

/** A folder's mark: a filled folder in the Library's own violet, the one hue this place has. */
function FolderMark({ className }: { className: string }) {
  return (
    <Folder aria-hidden className={cn('shrink-0 fill-face-violet text-face-violet', className)} />
  )
}

/** The folders and items of one level, as tiles or as rows. */
function Level({
  level,
  grid,
  onOpenFolder,
  onOpenItem,
}: {
  level: LibraryList
  grid: boolean
  onOpenFolder: (folder: LibraryFolder) => void
  onOpenItem: (item: LibraryItem) => void
}) {
  if (!grid) {
    return (
      <ul>
        {level.folders.map((folder) => (
          <li key={folder.id}>
            <LevelRow
              mark={<FolderMark className="size-7" />}
              name={folder.name}
              note={folderNote(folder)}
              onOpen={() => onOpenFolder(folder)}
            />
          </li>
        ))}
        {level.documents.map((item) => (
          <li key={item.id}>
            <LevelRow
              mark={<KindMark kind={kindOf(item)} size={28} />}
              name={item.name}
              note={itemNote(item)}
              onOpen={() => onOpenItem(item)}
            />
          </li>
        ))}
      </ul>
    )
  }
  return (
    <div className="flex flex-col gap-4">
      {level.folders.length > 0 && (
        <ul className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-4">
          {level.folders.map((folder, place) => (
            <li key={folder.id}>
              <button
                type="button"
                onClick={() => onOpenFolder(folder)}
                className={cn(
                  'flex w-full cursor-pointer items-center gap-2.5 rounded-card bg-surface-3 px-3 py-2.5 text-left edge outline-none hover:bg-surface-2 focus-visible:edge-primary',
                  PRESS,
                  ENTER,
                  stagger(place),
                )}
              >
                <FolderMark className="size-6" />
                <span className="min-w-0 flex-1 truncate text-title text-ink">{folder.name}</span>
                <span className="text-meta font-meta text-ink-3 tabular-nums">
                  {folderNote(folder)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <ul className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-4">
        {level.documents.map((item, place) => (
          <li key={item.id}>
            <ItemTile item={item} place={place} onOpen={() => onOpenItem(item)} />
          </li>
        ))}
      </ul>
    </div>
  )
}

/** One folder or item in the list view. */
function LevelRow({
  mark,
  name,
  note,
  onOpen,
}: {
  mark: ReactNode
  name: string
  note: string
  onOpen: () => void
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        'flex w-full cursor-pointer items-center gap-3 rounded-row px-2.5 py-2 text-left hover:bg-wash-hover',
        PRESS,
      )}
    >
      {mark}
      <span className="min-w-0 flex-1 truncate text-title text-ink">{name}</span>
      <span className="text-meta font-meta text-ink-3 tabular-nums">{note}</span>
    </button>
  )
}

/**
 * The sheet in an item's tile. Once Vivid has read the file it is the file's own first lines,
 * small, the way a document's thumbnail shows its first page; before that, or when it could not
 * be read, it is the outline of a page, since there are no words to show yet.
 */
function Sheet({ item }: { item: LibraryItem }) {
  const read = item.status === 'ready' && item.preview.trim().length > 0
  return (
    <span className="relative block aspect-4/3 overflow-hidden rounded-control bg-surface-2">
      <span
        aria-hidden
        className="absolute inset-x-5 top-3 -bottom-2 flex flex-col gap-1.5 overflow-hidden rounded-t-sm bg-surface-3 px-3 pt-3 edge"
      >
        {read ? (
          <span className="line-clamp-6 text-meta wrap-break-word whitespace-pre-line text-ink-3">
            {item.preview}
          </span>
        ) : (
          <>
            <i className="h-2 w-1/2 rounded-full bg-line-3" />
            <i className="mt-1 h-1 w-full rounded-full bg-line-2" />
            <i className="h-1 w-11/12 rounded-full bg-line-2" />
            <i className="h-1 w-4/5 rounded-full bg-line-2" />
          </>
        )}
      </span>
    </span>
  )
}

/** One item in the grid: its first page, then its kind, its name and where it stands. */
function ItemTile({
  item,
  place,
  onOpen,
}: {
  item: LibraryItem
  /** Its place in the grid, which is how long it waits before it arrives. */
  place: number
  onOpen: () => void
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        'flex w-full cursor-pointer flex-col overflow-hidden rounded-card bg-surface-3 p-2 text-left edge outline-none hover:bg-surface-2 focus-visible:edge-primary',
        PRESS,
        ENTER,
        stagger(place),
      )}
    >
      <Sheet item={item} />
      <span className="flex items-center gap-2.5 px-1 pt-2.5 pb-1">
        <KindMark kind={kindOf(item)} size={28} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-title text-ink">{item.name}</span>
          <span
            className={cn(
              'block truncate text-meta font-meta tabular-nums',
              item.status === 'failed' ? 'text-danger' : 'text-ink-3',
            )}
          >
            {itemNote(item)}
          </span>
        </span>
      </span>
    </button>
  )
}

// ── One item ─────────────────────────────────────────────────────────────────

/** What an item's page says under its status: what Vivid read, or why it could not. */
const itemText = (item: LibraryItem): string => {
  switch (item.status) {
    case 'ready':
      return item.preview
    case 'processing':
      return 'Vivid is reading this file.'
    case 'failed':
      return item.error === null ? 'Vivid could not read this file.' : item.error
  }
}

/** One item: rename, move, open the original, delete, and ask Vivid about it once it is read. */
function ItemDetail({
  item,
  onAsk,
  onDelete,
  onRename,
  onMove,
}: {
  item: LibraryItem
  onAsk: () => void
  onDelete: () => void
  onRename: () => void
  onMove: () => void
}) {
  const status = ITEM_STATUS[item.status]
  return (
    <div>
      <div className="flex items-center gap-3">
        <span className="inline-flex size-9 items-center justify-center rounded-control bg-surface-2 text-ink-3 edge">
          <FileText className="size-4.5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-title text-ink">{item.name}</p>
          <p className="text-meta font-meta text-ink-3">
            {libraryData.formatBytes(item.size)} · {item.chunkCount} passages
          </p>
        </div>
        <IconButton label="Rename file" onClick={onRename}>
          <Pencil className="size-4" />
        </IconButton>
        <IconButton label="Move file" onClick={onMove}>
          <FileInput className="size-4" />
        </IconButton>
        {/* A link, not a button: the browser opens the file in a new tab. It names itself the way
            the icon buttons beside it do. */}
        <Tooltip>
          <TooltipTrigger
            render={
              <a
                href={`/api/library/${encodeURIComponent(item.id)}/content`}
                target="_blank"
                rel="noreferrer"
                aria-label="Open the original file"
                className="inline-flex size-8 cursor-pointer items-center justify-center rounded-control text-ink-3 transition-colors duration-(--dur-fast) hover:bg-wash-hover hover:text-ink"
              />
            }
          >
            <ExternalLink className="size-4" />
          </TooltipTrigger>
          <TooltipContent>Open the original file</TooltipContent>
        </Tooltip>
        <IconButton label="Delete file" onClick={onDelete}>
          <Trash2 className="size-4" />
        </IconButton>
      </div>
      <div className="mt-5 rounded-card bg-surface-2 p-5 edge">
        <span className={cn('inline-flex items-center gap-1 text-meta font-meta', status.tone)}>
          {status.mark}
          {status.label}
        </span>
        <p className="mt-4 text-label leading-relaxed whitespace-pre-wrap text-ink-3">
          {itemText(item)}
        </p>
      </div>
      {item.status === 'ready' && (
        <div className="mt-4">
          <Button onClick={onAsk}>
            <MessageSquareText className="size-4" />
            Ask Vivid about this
          </Button>
        </div>
      )}
    </div>
  )
}

/** The passages a search found, each opening the item it came from. */
function SearchResults({
  results,
  onOpen,
}: {
  results: ReadonlyArray<SearchResult>
  onOpen: (result: SearchResult) => void
}) {
  if (results.length === 0) {
    return <p className="py-12 text-center text-label text-ink-3">Nothing matches that.</p>
  }
  return (
    <ul>
      {results.map((result) => (
        <li key={result.chunkId}>
          <button
            type="button"
            onClick={() => onOpen(result)}
            className="flex w-full cursor-pointer items-start gap-3 rounded-row px-2.5 py-3 text-left transition-colors duration-(--dur-fast) hover:bg-wash-hover"
          >
            <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-control bg-surface-2 text-ink-3 edge">
              <FileText className="size-4" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-title text-ink">{result.filename}</span>
              <span className="mt-1 line-clamp-2 text-label text-ink-3">{result.text}</span>
            </span>
            {result.page !== null && (
              <span className="text-meta font-meta text-ink-3">Page {result.page}</span>
            )}
          </button>
        </li>
      ))}
    </ul>
  )
}

// ── Uploads ──────────────────────────────────────────────────────────────────

/** What an upload row says on the right. */
const uploadNote = (status: UploadStatus): string =>
  UploadStatus.$match(status, {
    Sending: ({ percent }) => `${percent}%`,
    Reading: () => 'Vivid is reading it',
    Duplicate: () => 'Already on this shelf',
    Failed: ({ message }) => message,
  })

/** How far along an upload's bar is drawn. A file that has stopped moving shows a full bar. */
const uploadPercent = (status: UploadStatus): number =>
  UploadStatus.$match(status, {
    Sending: ({ percent }) => percent,
    Reading: () => 100,
    Duplicate: () => 100,
    Failed: () => 100,
  })

/** Files on their way in, and the ones that did not make it, which stay until dismissed. */
function Uploads({
  rows,
  onDismiss,
}: {
  rows: ReadonlyArray<UploadRow>
  onDismiss: (id: string) => void
}) {
  if (rows.length === 0) return null
  return (
    <ul className="space-y-1">
      {rows.map((row) => {
        const failed = UploadStatus.$is('Failed')(row.status)
        const settled = failed || UploadStatus.$is('Duplicate')(row.status)
        return (
          <li
            key={row.id}
            className="flex items-center gap-3 rounded-row bg-surface-2 px-3 py-2 edge"
          >
            <FileText className="size-4 shrink-0 text-ink-3" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-label text-ink">{row.name}</span>
              <span className="mt-1 block h-1 overflow-hidden rounded-full bg-line-2">
                <UploadBar percent={uploadPercent(row.status)} failed={failed} />
              </span>
            </span>
            <span
              role={failed ? 'alert' : undefined}
              className={cn('text-meta font-meta', failed ? 'text-danger' : 'text-ink-3')}
            >
              {uploadNote(row.status)}
            </span>
            {settled && (
              <IconButton label="Dismiss" onClick={() => onDismiss(row.id)}>
                <X className="size-4" />
              </IconButton>
            )}
          </li>
        )
      })}
    </ul>
  )
}

/** The fill of one upload's progress track; failure recolours it without resetting the width. */
function UploadBar({ percent, failed }: { percent: number; failed: boolean }) {
  // SAFETY: React forwards this validated CSS custom property; `w-(--upload-progress)` reads it.
  const barStyle = { '--upload-progress': `${percent}%` } as React.CSSProperties
  return (
    <i
      className={cn(
        'block h-full w-(--upload-progress) rounded-full transition-width',
        failed ? 'bg-danger' : 'bg-primary',
      )}
      style={barStyle}
    />
  )
}

// ── Dialogs ──────────────────────────────────────────────────────────────────

/** Draws the dialog for the question being asked and hands its answer to the matching action. */
function AskDialog({
  ask,
  place,
  dialogs,
}: {
  ask: Ask
  place: string
  dialogs: ReturnType<typeof dialogActions>
}) {
  return Ask.$match(ask, {
    NewFolder: () => (
      <NameDialog
        title="New folder"
        description={`It will be inside ${place}.`}
        initial=""
        limit={120}
        action="Create"
        onSubmit={dialogs.newFolder}
        onClose={dialogs.close}
      />
    ),
    RenameFolder: ({ folder }) => (
      <NameDialog
        title="Rename folder"
        description={folder.name}
        initial={folder.name}
        limit={120}
        action="Rename"
        onSubmit={(name) => dialogs.renameFolder(folder, name)}
        onClose={dialogs.close}
      />
    ),
    MoveFolder: ({ folder, destinations }) => (
      <MoveDialog
        title="Move folder"
        description={folder.name}
        // A folder cannot go inside itself.
        destinations={destinations.filter((each) => each.id !== folder.id)}
        initial={folder.parentId}
        onSubmit={(parentId) => dialogs.moveFolder(folder, parentId)}
        onClose={dialogs.close}
      />
    ),
    RenameItem: ({ item }) => (
      <NameDialog
        title="Rename file"
        description={item.name}
        initial={item.name}
        limit={180}
        action="Rename"
        onSubmit={(name) => dialogs.renameItem(item, name)}
        onClose={dialogs.close}
      />
    ),
    MoveItem: ({ item, destinations }) => (
      <MoveDialog
        title="Move file"
        description={item.name}
        destinations={destinations}
        initial={item.folderId}
        onSubmit={(folderId) => dialogs.moveItem(item, folderId)}
        onClose={dialogs.close}
      />
    ),
  })
}

/**
 * What every Library dialog shares: it sends its answer, waits, and shows the server's sentence
 * beside the field if it was refused. The Person keeps what they typed and can try again.
 */
function useSubmission() {
  const [pending, setPending] = useState(false)
  const [refused, setRefused] = useState<Option.Option<string>>(Option.none())

  function submit(send: Effect.Effect<Option.Option<string>>) {
    return Effect.gen(function* () {
      setPending(true)
      setRefused(Option.none())
      const message = yield* send
      // On success the dialog has been closed by its action and there is nothing left to update.
      if (Option.isNone(message)) return
      setRefused(message)
      setPending(false)
    })
  }

  return { pending, refused, submit }
}

/** A dialog that asks for one name. */
function NameDialog({
  title,
  description,
  initial,
  limit,
  action,
  onSubmit,
  onClose,
}: {
  title: string
  description: string
  initial: string
  limit: number
  action: string
  onSubmit: (name: string) => Effect.Effect<Option.Option<string>>
  onClose: () => void
}) {
  const [name, setName] = useState(initial)
  const { pending, refused, submit } = useSubmission()
  const field = useId()
  // Sent away (Escape, a click outside, the close button) it plays out before `onClose` is told.
  const surface = useSurface(onClose)
  return (
    <Dialog {...surface}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {/* `contents`: the field and the actions take the dialog's own gap, and the submit button
            stays inside the form so Enter in the field sends the name. */}
        <form
          className="contents"
          onSubmit={(event) => {
            event.preventDefault()
            void act(submit(onSubmit(name.trim())))
          }}
        >
          <div className="flex flex-col gap-3">
            <Field>
              <FieldLabel htmlFor={field}>Name</FieldLabel>
              <Input
                id={field}
                required
                // A dialog exists to take this one answer; the cursor belongs in it.
                // oxlint-disable-next-line jsx-a11y/no-autofocus
                autoFocus
                maxLength={limit}
                value={name}
                onChange={(event) => setName(event.currentTarget.value)}
              />
            </Field>
            {Option.isSome(refused) && <Alert variant="destructive">{refused.value}</Alert>}
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending || name.trim() === ''}>
              {action}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/**
 * The select value for the top of the shelf, which has no folder id. It cannot be the empty
 * string: Base UI's Select reads an empty value as nothing chosen and would draw the trigger as a
 * placeholder (`select/store.js`, `hasSelectedValue`).
 */
const TOP = 'top'

/** A dialog that asks where on its shelf something should go. */
function MoveDialog({
  title,
  description,
  destinations,
  initial,
  onSubmit,
  onClose,
}: {
  title: string
  description: string
  destinations: ReadonlyArray<LibraryFolder>
  initial: LibraryFolderId | null
  onSubmit: (folderId: LibraryFolderId | null) => Effect.Effect<Option.Option<string>>
  onClose: () => void
}) {
  const [destination, setDestination] = useState(initial)
  const { pending, refused, submit } = useSubmission()
  const field = useId()
  // Sent away (Escape, a click outside, the close button) it plays out before `onClose` is told.
  const surface = useSurface(onClose)
  // Every place it can go, the top of the shelf first. The select reads the trigger's words from
  // this list, and a choice is looked up in it, so the value and where it leads cannot disagree.
  const places: ReadonlyArray<{ value: string; label: string; folderId: LibraryFolderId | null }> =
    [
      { value: TOP, label: 'The top of the shelf', folderId: null },
      ...destinations.map((folder) => ({
        value: folder.id,
        label: folder.name,
        folderId: folder.id,
      })),
    ]
  return (
    <Dialog {...surface}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {/* `contents`: the field and the actions take the dialog's own gap, and the submit button
            stays inside the form. */}
        <form
          className="contents"
          onSubmit={(event) => {
            event.preventDefault()
            void act(submit(onSubmit(destination)))
          }}
        >
          <div className="flex flex-col gap-3">
            <Field>
              <FieldLabel htmlFor={field}>Move to</FieldLabel>
              {/* The trigger is the first control in the dialog, so Base UI puts the keyboard on
                  it as the dialog opens; the native select asked for that with `autoFocus`. */}
              <Select
                items={places}
                value={destination === null ? TOP : destination}
                onValueChange={(value) => {
                  // Base UI hands `null` when a selection is cleared; nothing here clears one.
                  if (value === null) return
                  const chosen = places.find((place) => place.value === value)
                  if (chosen === undefined) return
                  setDestination(chosen.folderId)
                }}
              >
                <SelectTrigger id={field} className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {places.map((place) => (
                      <SelectItem key={place.value} value={place.value}>
                        {place.label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
            {Option.isSome(refused) && <Alert variant="destructive">{refused.value}</Alert>}
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending || destination === initial}>
              Move
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
