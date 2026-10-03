import {
  Workspace,
  type LibraryFolder,
  type LibraryFolderId,
  type LibraryItem,
  type LibraryShelf,
} from '@vivid/contracts'
import { Data, Option, Result } from 'effect'
import {
  Check,
  ChevronRight,
  CircleAlert,
  CircleDashed,
  ExternalLink,
  FileInput,
  FileText,
  Folder,
  FolderInput,
  FolderPlus,
  LayoutGrid,
  MessageSquareText,
  Pencil,
  Rows3,
  Search,
  Trash2,
  Upload,
  X,
} from 'lucide-react'
import { useRef, useState, type DragEvent, type FormEvent, type ReactNode } from 'react'
import * as libraryData from '../data/library'
import { change, live, LiveState, useLive } from '../data/live'
import { run } from '../data/app'
import { engine } from '../data/runtime'
import { Button, IconButton } from '../ui/Button'
import { cn } from '../ui/cn'
import { Dialog, DialogActions, DialogField } from '../ui/Dialog'
import { Field, Select } from '../ui/Field'
import { Live } from '../ui/Live'
import { Notice } from '../ui/Notice'
import { Segmented } from '../ui/Segmented'
import { Skeleton } from '../ui/Skeleton'
import { BAR } from './bar'

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
  async function send(file: File, id: string) {
    const result = await run(
      libraryData.upload(file, { shelf, folderId }, (percent) =>
        // Once every byte has left, the server is reading the file until it answers.
        setStatus(id, percent >= 100 ? UploadStatus.Reading() : UploadStatus.Sending({ percent })),
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
    for (const { file, id } of sending) void send(file, id)
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

  async function search(event: FormEvent) {
    event.preventDefault()
    const text = Option.getOrElse(query, () => '').trim()
    if (text.length < 2) return
    const result = await run(libraryData.search(text, folderId))
    setRefused(refusal(result))
    if (Result.isSuccess(result)) setView(View.Results({ results: result.success }))
  }

  async function openResult(found: SearchResult) {
    const result = await run(libraryData.readItem(found.documentId))
    setRefused(refusal(result))
    if (Result.isSuccess(result)) setView(View.Item({ item: result.success }))
  }

  /** The item leaves the shelf at once. If the server refuses, it is back, with the reason above it. */
  async function removeItem(item: LibraryItem) {
    if (!window.confirm(`Delete “${item.name}” from the Library?`)) return
    setView(View.Browse())
    const result = await change(
      (client) => client.DeleteLibraryItem({ id: item.id }),
      () => store.expect(libraryData.itemRemoved(item.id)),
    )
    setRefused(refusal(result))
  }

  /** A folder is left only once the server has deleted it: one that is not empty stays open. */
  async function removeFolder(folder: LibraryFolder) {
    if (!window.confirm(`Delete the folder “${folder.name}”?`)) return
    const result = await change((client) => client.DeleteLibraryFolder({ id: folder.id }))
    setRefused(refusal(result))
    if (Result.isSuccess(result)) setPath((trail) => trail.filter((each) => each.id !== folder.id))
  }

  /** Reads where a thing can go, then asks. The folders of a shelf are read when they are needed. */
  async function askMove(open: (destinations: ReadonlyArray<LibraryFolder>) => Ask) {
    const result = await run(libraryData.shelfFolders(shelf))
    setRefused(refusal(result))
    if (Result.isSuccess(result)) setAsk(Option.some(open(result.success)))
  }

  function back() {
    setRefused(Option.none())
    if (View.$is('Browse')(view)) setPath((trail) => trail.slice(0, -1))
    else setView(View.Browse())
  }

  return { askMove, back, openResult, removeFolder, removeItem, search }
}

/**
 * What each dialog does when it is submitted. Every one waits for the server and answers with its
 * refusal, which the dialog shows beside the field; on success it closes the dialog. Renaming and
 * moving an item also change the shelf at once, so the list behind the dialog is already right.
 */
function dialogActions(browser: Browser) {
  const { folderId, setAsk, setPath, setView, shelf, store } = browser
  const close = () => setAsk(Option.none())

  async function newFolder(name: string) {
    const result = await change((client) =>
      client.CreateLibraryFolder({ name, shelf, parentId: folderId }),
    )
    if (Result.isSuccess(result)) close()
    return refusal(result)
  }

  async function renameFolder(folder: LibraryFolder, name: string) {
    const result = await change((client) =>
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
  }

  async function moveFolder(folder: LibraryFolder, parentId: LibraryFolderId | null) {
    const result = await change((client) =>
      client.PatchLibraryFolder({ id: folder.id, patch: { parentId } }),
    )
    if (Result.isSuccess(result)) {
      // The trail that led here is no longer the way to this folder; start again from the top.
      setPath([])
      close()
    }
    return refusal(result)
  }

  async function renameItem(item: LibraryItem, name: string) {
    const result = await change(
      (client) => client.PatchLibraryItem({ id: item.id, patch: { name } }),
      () => store.expect(libraryData.itemRenamed(item.id, name)),
    )
    if (Result.isSuccess(result)) {
      setView(View.Item({ item: result.success.document }))
      close()
    }
    return refusal(result)
  }

  async function moveItem(item: LibraryItem, destination: LibraryFolderId | null) {
    const result = await change(
      (client) => client.PatchLibraryItem({ id: item.id, patch: { folderId: destination } }),
      () => store.expect(libraryData.itemMoved(item.id, destination)),
    )
    if (Result.isSuccess(result)) {
      setView(View.Item({ item: result.success.document }))
      close()
    }
    return refusal(result)
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
        <Skeleton of="card" count={4} />
      </LibraryPane>
    ),
    Failed: ({ failure }) => (
      <LibraryPane>
        <Notice>{failure.message}</Notice>
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
      <div className="min-h-0 flex-1 overflow-y-auto scroll-fade-y">
        <div className="mx-auto flex w-full max-w-230 flex-col gap-3 px-5 pt-2 pb-10 sm:px-8">
          {Option.isSome(browser.refused) && <Notice>{browser.refused.value}</Notice>}
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
        <div className="pointer-events-none absolute inset-3 z-20 flex items-center justify-center rounded-card border-2 border-dashed border-accent bg-surface-0 text-center">
          <div>
            <Upload className="mx-auto size-7 text-accent-ink" />
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
            void browsing.askMove((destinations) =>
              Ask.MoveFolder({ folder: folder.value, destinations }),
            )
          }
          onDelete={() => void browsing.removeFolder(folder.value)}
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
        onSearch={(event) => void browsing.search(event)}
      />
    ),
    Results: ({ results }) => (
      <SearchResults results={results} onOpen={(found) => void browsing.openResult(found)} />
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
          onDelete={() => void browsing.removeItem(current)}
          onRename={() => setAsk(Option.some(Ask.RenameItem({ item: current })))}
          onMove={() =>
            void browsing.askMove((destinations) => Ask.MoveItem({ item: current, destinations }))
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
      <Live state={contents} loading={<Skeleton of="card" count={4} />}>
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
    <div className="flex flex-col items-center px-6 py-16 text-center">
      <FileText className="size-5 text-ink-4" />
      <p className="mt-2 mb-4 max-w-sm text-label text-ink-3">
        {company
          ? 'Nothing here yet. Add a file and Vivid can read it in every Member’s Threads.'
          : 'Nothing here yet. Add a file and Vivid can read it in your Threads.'}
      </p>
      <FilePicker label="Upload files" look="button" onFiles={onUpload}>
        <Upload className="size-3.5" />
        Upload files
      </FilePicker>
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
  return (
    <label
      title={label}
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
    ? `${libraryData.formatBytes(item.size)} · ${item.chunkCount} passages`
    : ITEM_STATUS[item.status].label

const folderNote = (folder: LibraryFolder): string =>
  `${folder.itemCount} ${folder.itemCount === 1 ? 'item' : 'items'}`

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
              mark={<Folder className="size-4.5" />}
              accent
              name={folder.name}
              note={folderNote(folder)}
              onOpen={() => onOpenFolder(folder)}
            />
          </li>
        ))}
        {level.documents.map((item) => (
          <li key={item.id}>
            <LevelRow
              mark={<FileText className="size-4.5" />}
              accent={false}
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
        <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {level.folders.map((folder) => (
            <li key={folder.id}>
              <button
                type="button"
                onClick={() => onOpenFolder(folder)}
                className="flex w-full cursor-pointer items-center gap-2.5 rounded-card bg-surface-2 px-3 py-2.5 text-left edge transition-surface duration-(--dur-fast) hover:bg-wash-hover"
              >
                <Folder className="size-5 shrink-0 text-ink-3" strokeWidth={1.7} />
                <span className="min-w-0 flex-1 truncate text-label text-ink">{folder.name}</span>
                <span className="text-meta font-meta text-ink-3">{folderNote(folder)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
        {level.documents.map((item) => (
          <li key={item.id}>
            <ItemTile item={item} onOpen={() => onOpenItem(item)} />
          </li>
        ))}
      </ul>
    </div>
  )
}

/** One folder or item in the list view. */
function LevelRow({
  mark,
  accent,
  name,
  note,
  onOpen,
}: {
  mark: ReactNode
  accent: boolean
  name: string
  note: string
  onOpen: () => void
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full cursor-pointer items-center gap-3 rounded-row px-2.5 py-2 text-left transition-colors duration-(--dur-fast) hover:bg-wash-hover"
    >
      <span
        className={cn(
          'inline-flex size-8 shrink-0 items-center justify-center rounded-control',
          accent ? 'bg-accent-soft text-accent-ink' : 'bg-surface-2 text-ink-3 edge',
        )}
      >
        {mark}
      </span>
      <span className="min-w-0 flex-1 truncate text-title text-ink">{name}</span>
      <span className="text-meta font-meta text-ink-3">{note}</span>
    </button>
  )
}

/** One item in the grid: its name, where it stands, and a drawn page standing in for a preview. */
function ItemTile({ item, onOpen }: { item: LibraryItem; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full cursor-pointer flex-col overflow-hidden rounded-card bg-surface-2 p-3 text-left edge transition-press duration-(--dur-fast) hover:bg-surface-3 active:scale-98"
    >
      <span className="flex items-center gap-2">
        <FileText className="size-4 shrink-0 text-ink-3" strokeWidth={1.6} />
        <span className="min-w-0 flex-1 truncate text-label text-ink">{item.name}</span>
      </span>
      <span className="relative mt-3 block aspect-4/3 overflow-hidden rounded-control bg-surface-1 ring-line">
        <span
          aria-hidden
          className="absolute inset-x-7 inset-y-3 flex flex-col gap-1.5 rounded-sm bg-surface-3 p-2.5 edge"
        >
          <i className="h-2 w-1/2 rounded-full bg-line-3" />
          <i className="mt-1 h-1 w-full rounded-full bg-line-1" />
          <i className="h-1 w-11/12 rounded-full bg-line-1" />
          <i className="h-1 w-4/5 rounded-full bg-line-1" />
          <i className="mt-auto h-1 w-2/3 rounded-full bg-line-1" />
        </span>
      </span>
      <span className="mt-2 truncate text-meta font-meta text-ink-3">{itemNote(item)}</span>
    </button>
  )
}

// ── One item ─────────────────────────────────────────────────────────────────

/** What an item's page says under its status: what Vivid read, or why it could not. */
const itemText = (item: LibraryItem): string => {
  if (item.status === 'ready') return item.preview
  if (item.status === 'processing') return 'Vivid is reading this file.'
  return item.error === null ? 'Vivid could not read this file.' : item.error
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
        <a
          href={`/api/library/${encodeURIComponent(item.id)}/content`}
          target="_blank"
          rel="noreferrer"
          aria-label="Open the original file"
          title="Open the original file"
          className="inline-flex size-8 cursor-pointer items-center justify-center rounded-control text-ink-3 transition-colors duration-(--dur-fast) hover:bg-wash-hover hover:text-ink"
        >
          <ExternalLink className="size-4" />
        </a>
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
          <Button variant="primary" icon={<MessageSquareText className="size-4" />} onClick={onAsk}>
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
        failed ? 'bg-danger' : 'bg-accent',
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

  async function submit(send: () => Promise<Option.Option<string>>) {
    setPending(true)
    setRefused(Option.none())
    const message = await send()
    // On success the dialog has been closed by its action and there is nothing left to update.
    if (Option.isNone(message)) return
    setRefused(message)
    setPending(false)
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
  onSubmit: (name: string) => Promise<Option.Option<string>>
  onClose: () => void
}) {
  const [name, setName] = useState(initial)
  const { pending, refused, submit } = useSubmission()
  return (
    <Dialog title={title} description={description} onClose={onClose}>
      <form
        onSubmit={(event) => {
          event.preventDefault()
          void submit(() => onSubmit(name.trim()))
        }}
        className="flex flex-col gap-3"
      >
        <DialogField label="Name" value={name} onChange={setName} maxLength={limit} />
        {Option.isSome(refused) && <Notice>{refused.value}</Notice>}
        <DialogActions>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={pending || name.trim() === ''}>
            {action}
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  )
}

/** The select value for the top of the shelf; no folder id is the empty string. */
const TOP = ''

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
  onSubmit: (folderId: LibraryFolderId | null) => Promise<Option.Option<string>>
  onClose: () => void
}) {
  const [destination, setDestination] = useState(initial)
  const { pending, refused, submit } = useSubmission()
  return (
    <Dialog title={title} description={description} onClose={onClose}>
      <form
        onSubmit={(event) => {
          event.preventDefault()
          void submit(() => onSubmit(destination))
        }}
        className="flex flex-col gap-3"
      >
        <Field label="Move to">
          <Select
            autoFocus
            value={destination === null ? TOP : destination}
            onChange={(event) => {
              const chosen = destinations.find((each) => each.id === event.currentTarget.value)
              setDestination(chosen === undefined ? null : chosen.id)
            }}
          >
            <option value={TOP}>The top of the shelf</option>
            {destinations.map((folder) => (
              <option key={folder.id} value={folder.id}>
                {folder.name}
              </option>
            ))}
          </Select>
        </Field>
        {Option.isSome(refused) && <Notice>{refused.value}</Notice>}
        <DialogActions>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={pending || destination === initial}>
            Move
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  )
}
