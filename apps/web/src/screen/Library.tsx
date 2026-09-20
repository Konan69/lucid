import * as Result from 'effect/Result'
import {
  Check,
  ChevronRight,
  CircleAlert,
  ExternalLink,
  FileInput,
  FileText,
  Folder,
  FolderInput,
  FolderPlus,
  LayoutGrid,
  LoaderCircle,
  MessageSquareText,
  MoreHorizontal,
  Pencil,
  Rows3,
  Search,
  Trash2,
  Upload,
  X,
} from 'lucide-react'
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type DragEvent,
  type FormEvent,
  type RefObject,
} from 'react'
import * as libraryData from '../data/library'
import { run as runClient } from '../data/runtime'
import { cn } from '../ui/cn'

export type LibraryDocument = libraryData.LibraryDocument
export type LibraryFolder = libraryData.LibraryFolder
type SearchResult = libraryData.SearchResult
type DialogState = libraryData.DialogState
type Tile = {
  id: string
  kind: 'folder' | 'file'
  name: string
  meta: string
  document?: LibraryDocument
  folder?: LibraryFolder
}
type UploadState = {
  id: string
  name: string
  progress: number
  status: 'uploading' | 'indexing' | 'failed'
  error?: string
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function retainSelectedDocument(
  current: LibraryDocument | null,
  documents: readonly LibraryDocument[],
): LibraryDocument | null {
  return current ? (documents.find((document) => document.id === current.id) ?? current) : null
}

function buildTiles(documents: LibraryDocument[], folders: LibraryFolder[]): Tile[] {
  return [
    ...folders.map((folder): Tile => ({
      id: folder.id,
      kind: 'folder',
      name: folder.name,
      meta: `${folder.itemCount} ${folder.itemCount === 1 ? 'item' : 'items'}`,
      folder,
    })),
    ...documents.map((document): Tile => ({
      id: document.id,
      kind: 'file',
      name: document.name,
      meta:
        document.status === 'ready'
          ? `${formatBytes(document.size)} · ${document.chunkCount} passages`
          : document.status === 'failed'
            ? 'Failed'
            : 'Indexing…',
      document,
    })),
  ]
}

/** Owns Library hooks in their original order while exposing typed state to screen actions. */
function useLibraryState() {
  const [grid, setGrid] = useState(true)
  const [folderStack, setFolderStack] = useState<LibraryFolder[]>([])
  const [folders, setFolders] = useState<LibraryFolder[]>([])
  const [allFolders, setAllFolders] = useState<LibraryFolder[]>([])
  const [documents, setDocuments] = useState<LibraryDocument[]>([])
  const [selected, setSelected] = useState<LibraryDocument | null>(null)
  const [showSearch, setShowSearch] = useState(false)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResult[] | null>(null)
  const [uploads, setUploads] = useState<UploadState[]>([])
  const [dragging, setDragging] = useState(false)
  const [dialog, setDialog] = useState<DialogState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const dragDepth = useRef(0)
  const currentFolder = folderStack.slice(-1)[0] ?? null
  const currentFolderId = currentFolder ? currentFolder.id : null

  const load = useCallback(async () => {
    const result = await runClient(libraryData.load(currentFolderId))
    if (Result.isFailure(result)) {
      setError(result.failure.message)
      return
    }
    setDocuments(result.success.documents)
    setFolders(result.success.folders)
    setAllFolders(result.success.allFolders)
    setSelected((current) => retainSelectedDocument(current, result.success.documents))
    setError(null)
  }, [currentFolderId])

  useEffect(() => {
    let cancelled = false
    // Folder navigation hydrates from the Library runtime. Responses from a folder the person has
    // already left are ignored so they cannot replace the current folder's contents.
    void runClient(libraryData.load(currentFolderId)).then((result) => {
      if (cancelled) return
      if (Result.isFailure(result)) {
        setError(result.failure.message)
        return
      }
      setDocuments(result.success.documents)
      setFolders(result.success.folders)
      setAllFolders(result.success.allFolders)
      setSelected((current) => retainSelectedDocument(current, result.success.documents))
      setError(null)
    })

    return () => {
      cancelled = true
    }
  }, [currentFolderId])
  useEffect(() => {
    if (
      !documents.some((document) => document.status === 'processing') &&
      !uploads.some((upload) => upload.status === 'indexing')
    )
      return undefined
    const timer = window.setInterval(() => {
      void load()
    }, 900)
    return () => window.clearInterval(timer)
  }, [documents, load, uploads])

  return {
    allFolders,
    currentFolder,
    currentFolderId,
    dialog,
    documents,
    dragDepth,
    dragging,
    error,
    folderStack,
    folders,
    grid,
    inputRef,
    load,
    query,
    results,
    selected,
    setDialog,
    setDragging,
    setError,
    setFolderStack,
    setGrid,
    setQuery,
    setResults,
    setSelected,
    setShowSearch,
    setUploads,
    showSearch,
    uploads,
  }
}

type LibraryState = ReturnType<typeof useLibraryState>

/** Owns upload and drag lifecycle handlers while reusing the screen's stable state setters. */
function createLibraryUploadActions(state: LibraryState) {
  const { currentFolderId, dragDepth, inputRef, load, setDragging, setError, setUploads } = state

  async function uploadOne(file: File, upload: UploadState) {
    const result = await runClient(
      libraryData.upload(file, currentFolderId, (progress) =>
        setUploads((current) =>
          current.map((item) => (item.id === upload.id ? { ...item, progress } : item)),
        ),
      ),
    )
    if (Result.isFailure(result)) {
      setUploads((current) =>
        current.map((item) =>
          item.id === upload.id
            ? { ...item, status: 'failed', error: result.failure.message }
            : item,
        ),
      )
      return
    }
    setUploads((current) =>
      current.map((item) =>
        item.id === upload.id ? { ...item, progress: 100, status: 'indexing' } : item,
      ),
    )
  }

  async function uploadFiles(files: File[]) {
    const states: UploadState[] = files.map((file) => ({
      id: `${file.name}-${file.size}-${file.lastModified}`,
      name: file.name,
      progress: 0,
      status: 'uploading',
    }))
    setUploads((current) => [...states, ...current].slice(0, 8))
    setError(null)
    const uploadsByFile = files.map((file, index) => {
      const upload = states[index]
      if (!upload) throw new Error('Upload state did not match the selected file')
      return { file, upload }
    })
    await Promise.all(uploadsByFile.map(({ file, upload }) => uploadOne(file, upload)))
    if (inputRef.current) inputRef.current.value = ''
    await load()
    window.setTimeout(
      () => setUploads((current) => current.filter((item) => item.status === 'failed')),
      1800,
    )
  }

  function handleDragEnter(event: DragEvent) {
    event.preventDefault()
    dragDepth.current += 1
    setDragging(true)
  }

  function handleDragLeave(event: DragEvent) {
    event.preventDefault()
    dragDepth.current -= 1
    if (dragDepth.current <= 0) setDragging(false)
  }

  function handleDrop(event: DragEvent) {
    event.preventDefault()
    dragDepth.current = 0
    setDragging(false)
    const files = [...event.dataTransfer.files]
    if (files.length) void uploadFiles(files)
  }

  return { handleDragEnter, handleDragLeave, handleDrop, uploadFiles }
}

/** Owns Library search, deletion, navigation, and dialog-result mutations. */
function createLibraryItemActions(state: LibraryState) {
  const {
    currentFolder,
    currentFolderId,
    load,
    query,
    results,
    selected,
    setDialog,
    setError,
    setFolderStack,
    setResults,
    setSelected,
  } = state

  async function search(event: FormEvent) {
    event.preventDefault()
    const normalized = query.trim()
    if (normalized.length < 2) return
    const result = await runClient(libraryData.search(normalized, currentFolderId))
    if (Result.isFailure(result)) {
      setError(result.failure.message)
      return
    }
    setResults(result.success)
    setError(null)
  }

  async function removeDocument(document: LibraryDocument) {
    if (!window.confirm(`Delete “${document.name}” from the Library?`)) return
    const result = await runClient(libraryData.removeDocument(document.id))
    if (Result.isFailure(result)) {
      setError(result.failure.message)
      return
    }
    setSelected(null)
    await load()
  }

  async function removeCurrentFolder() {
    if (!currentFolder || !window.confirm(`Delete the empty folder “${currentFolder.name}”?`))
      return
    const result = await runClient(libraryData.removeFolder(currentFolder.id))
    if (Result.isFailure(result)) {
      setError(result.failure.message)
      return
    }
    setFolderStack((current) => current.slice(0, -1))
  }

  async function openSearchResult(result: SearchResult) {
    const opened = await runClient(libraryData.readDocument(result.documentId))
    if (Result.isFailure(opened)) {
      setError(opened.failure.message)
      return
    }
    setSelected(opened.success)
    setResults(null)
  }

  function open(tile: Tile) {
    if (tile.document) {
      setSelected(tile.document)
      return
    }
    const folder = tile.folder
    if (folder) setFolderStack((current) => [...current, folder])
  }

  function back() {
    if (selected) setSelected(null)
    else if (results) setResults(null)
    else setFolderStack((current) => current.slice(0, -1))
  }

  async function applyDialogResult(result: libraryData.DialogResult, dialog: DialogState) {
    const savedFolder = result.folder
    if (savedFolder && dialog.kind === 'rename-folder')
      setFolderStack((current) =>
        current.map((folder) => (folder.id === savedFolder.id ? savedFolder : folder)),
      )
    if (result.document)
      setSelected(result.document.folderId === currentFolderId ? result.document : null)
    if (dialog.kind === 'move-folder') setFolderStack([])
    setDialog(null)
    await load()
  }

  return {
    applyDialogResult,
    back,
    open,
    openSearchResult,
    removeCurrentFolder,
    removeDocument,
    search,
  }
}

export function Library({ onAsk }: { onAsk: (document: LibraryDocument) => void }) {
  const state = useLibraryState()
  const {
    allFolders,
    currentFolder,
    currentFolderId,
    dialog,
    documents,
    dragging,
    error,
    folders,
    grid,
    inputRef,
    query,
    results,
    selected,
    setDialog,
    setGrid,
    setQuery,
    setResults,
    setShowSearch,
    showSearch,
    uploads,
  } = state

  const tiles = buildTiles(documents, folders)
  const uploadActions = createLibraryUploadActions(state)
  const itemActions = createLibraryItemActions(state)

  return (
    <section
      onDragEnter={uploadActions.handleDragEnter}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={uploadActions.handleDragLeave}
      onDrop={uploadActions.handleDrop}
      className="relative flex h-full min-w-0 flex-1 flex-col bg-surface-0 content-edge"
    >
      <LibraryHeader
        grid={grid}
        currentFolder={currentFolder}
        selected={selected}
        results={results}
        inputRef={inputRef}
        onBack={itemActions.back}
        onGridChange={setGrid}
        onDialogChange={setDialog}
        onSearchToggle={() => {
          setShowSearch((value) => !value)
          setResults(null)
        }}
        onDeleteFolder={() => void itemActions.removeCurrentFolder()}
        onUpload={(files) => void uploadActions.uploadFiles(files)}
      />

      <LibraryContent
        error={error}
        uploads={uploads}
        selected={selected}
        showSearch={showSearch}
        query={query}
        currentFolder={currentFolder}
        results={results}
        grid={grid}
        tiles={tiles}
        onAsk={onAsk}
        onDelete={itemActions.removeDocument}
        onDialogChange={setDialog}
        onQueryChange={setQuery}
        onSearch={(event) => void itemActions.search(event)}
        onOpenResult={(result) => void itemActions.openSearchResult(result)}
        onOpenTile={itemActions.open}
      />
      <LibraryDropOverlay dragging={dragging} currentFolder={currentFolder} />
      {dialog && (
        <LibraryDialog
          state={dialog}
          folders={allFolders}
          currentFolderId={currentFolderId}
          onClose={() => setDialog(null)}
          onSaved={(result) => itemActions.applyDialogResult(result, dialog)}
        />
      )}
    </section>
  )
}

/** Renders Library navigation and delegates toolbar controls to a focused action component. */
function LibraryHeader({
  grid,
  currentFolder,
  selected,
  results,
  inputRef,
  onBack,
  onGridChange,
  onDialogChange,
  onSearchToggle,
  onDeleteFolder,
  onUpload,
}: {
  grid: boolean
  currentFolder: LibraryFolder | null
  selected: LibraryDocument | null
  results: SearchResult[] | null
  inputRef: RefObject<HTMLInputElement | null>
  onBack: () => void
  onGridChange: (grid: boolean) => void
  onDialogChange: (dialog: DialogState) => void
  onSearchToggle: () => void
  onDeleteFolder: () => void
  onUpload: (files: File[]) => void
}) {
  return (
    <header className="flex h-(--topbar-h) shrink-0 items-center gap-2 px-4">
      {(currentFolder || selected || results) && (
        <button
          onClick={onBack}
          aria-label="Back"
          className="mr-1 inline-flex size-8 items-center justify-center rounded-control text-ink-3 hover:bg-wash-hover hover:text-ink"
        >
          <ChevronRight className="size-4 rotate-180" />
        </button>
      )}
      <h1 className="min-w-0 flex-1 truncate text-title font-title text-ink">
        {selected
          ? selected.name
          : results
            ? 'Search results'
            : currentFolder
              ? currentFolder.name
              : 'Library'}
      </h1>
      {!selected && (
        <LibraryHeaderActions
          grid={grid}
          currentFolder={currentFolder}
          inputRef={inputRef}
          onGridChange={onGridChange}
          onDialogChange={onDialogChange}
          onSearchToggle={onSearchToggle}
          onDeleteFolder={onDeleteFolder}
        />
      )}
      <input
        ref={inputRef}
        type="file"
        multiple
        accept=".pdf,.md,.markdown,.txt,application/pdf,text/markdown,text/plain"
        className="hidden"
        onChange={(event) => {
          const files = [...(event.currentTarget.files ?? [])]
          if (files.length) onUpload(files)
        }}
      />
    </header>
  )
}

/** Keeps file input, folder mutations, search, and view controls outside the screen component. */
function LibraryHeaderActions({
  grid,
  currentFolder,
  inputRef,
  onGridChange,
  onDialogChange,
  onSearchToggle,
  onDeleteFolder,
}: {
  grid: boolean
  currentFolder: LibraryFolder | null
  inputRef: RefObject<HTMLInputElement | null>
  onGridChange: (grid: boolean) => void
  onDialogChange: (dialog: DialogState) => void
  onSearchToggle: () => void
  onDeleteFolder: () => void
}) {
  return (
    <>
      {currentFolder && (
        <>
          <button
            aria-label="Rename folder"
            onClick={() => onDialogChange({ kind: 'rename-folder', folder: currentFolder })}
            className="inline-flex size-8 items-center justify-center rounded-control text-ink-3 hover:bg-wash-hover hover:text-ink"
          >
            <Pencil className="size-4" />
          </button>
          <button
            aria-label="Move folder"
            onClick={() => onDialogChange({ kind: 'move-folder', folder: currentFolder })}
            className="inline-flex size-8 items-center justify-center rounded-control text-ink-3 hover:bg-wash-hover hover:text-ink"
          >
            <FolderInput className="size-4" />
          </button>
          <button
            aria-label="Delete folder"
            onClick={onDeleteFolder}
            className="inline-flex size-8 items-center justify-center rounded-control text-ink-3 hover:bg-danger-soft hover:text-danger"
          >
            <Trash2 className="size-4" />
          </button>
        </>
      )}
      <button
        aria-label="New folder"
        onClick={() => onDialogChange({ kind: 'new-folder' })}
        className="inline-flex size-8 items-center justify-center rounded-control text-ink-3 hover:bg-wash-hover hover:text-ink"
      >
        <FolderPlus className="size-4" />
      </button>
      <button
        aria-label="Upload files"
        onClick={() => {
          const input = inputRef.current
          if (input) input.click()
        }}
        className="inline-flex size-8 items-center justify-center rounded-control text-ink-3 hover:bg-wash-hover hover:text-ink"
      >
        <Upload className="size-4" />
      </button>
      <button
        aria-label="Search Library"
        onClick={onSearchToggle}
        className="inline-flex size-8 items-center justify-center rounded-control text-ink-3 hover:bg-wash-hover hover:text-ink"
      >
        <Search className="size-4" />
      </button>
      <div className="flex items-center rounded-control bg-surface-2 p-0.5">
        <button
          aria-label="Grid"
          onClick={() => onGridChange(true)}
          className={cn(
            'inline-flex size-7 items-center justify-center rounded-sm',
            grid ? 'bg-surface-3 text-ink smooth-shadow-ring-xs' : 'text-ink-3 hover:text-ink',
          )}
        >
          <LayoutGrid className="size-4" />
        </button>
        <button
          aria-label="List"
          onClick={() => onGridChange(false)}
          className={cn(
            'inline-flex size-7 items-center justify-center rounded-sm',
            !grid ? 'bg-surface-3 text-ink smooth-shadow-ring-xs' : 'text-ink-3 hover:text-ink',
          )}
        >
          <Rows3 className="size-4" />
        </button>
      </div>
    </>
  )
}

/** Renders document, search, grid, and list states inside the unchanged scroll container. */
function LibraryContent({
  error,
  uploads,
  selected,
  showSearch,
  query,
  currentFolder,
  results,
  grid,
  tiles,
  onAsk,
  onDelete,
  onDialogChange,
  onQueryChange,
  onSearch,
  onOpenResult,
  onOpenTile,
}: {
  error: string | null
  uploads: UploadState[]
  selected: LibraryDocument | null
  showSearch: boolean
  query: string
  currentFolder: LibraryFolder | null
  results: SearchResult[] | null
  grid: boolean
  tiles: Tile[]
  onAsk: (document: LibraryDocument) => void
  onDelete: (document: LibraryDocument) => Promise<void>
  onDialogChange: (dialog: DialogState) => void
  onQueryChange: (query: string) => void
  onSearch: (event: FormEvent) => void
  onOpenResult: (result: SearchResult) => void
  onOpenTile: (tile: Tile) => void
}) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto scroll-fade-y">
      <div className="mx-auto w-full max-w-230 px-5 pt-2 pb-10 sm:px-8">
        {error && (
          <div
            className="mb-3 rounded-control bg-danger-soft px-3 py-2 text-label text-danger"
            role="alert"
          >
            {error}
          </div>
        )}
        {uploads.length > 0 && <UploadProgress uploads={uploads} />}
        {selected ? (
          <DocumentDetail
            document={selected}
            onAsk={() => onAsk(selected)}
            onDelete={() => void onDelete(selected)}
            onRename={() => onDialogChange({ kind: 'rename-file', document: selected })}
            onMove={() => onDialogChange({ kind: 'move-file', document: selected })}
          />
        ) : (
          <>
            {showSearch && (
              <form
                onSubmit={onSearch}
                className="mb-3 flex items-center gap-2 rounded-control bg-surface-2 px-3 smooth-shadow-ring-xs"
              >
                <Search className="size-4 text-ink-4" />
                <input
                  autoFocus
                  value={query}
                  onChange={(event) => onQueryChange(event.currentTarget.value)}
                  placeholder={currentFolder ? `Search ${currentFolder.name}` : 'Search all files'}
                  className="h-10 min-w-0 flex-1 bg-transparent text-label text-ink outline-none placeholder:text-ink-4"
                />
              </form>
            )}
            {results ? (
              <SearchResults results={results} onOpen={onOpenResult} />
            ) : grid ? (
              <TileGrid tiles={tiles} onOpen={onOpenTile} />
            ) : (
              <TileList tiles={tiles} onOpen={onOpenTile} />
            )}
          </>
        )}
      </div>
    </div>
  )
}

/** Preserves the drag target overlay while removing its branch from the screen component. */
function LibraryDropOverlay({
  dragging,
  currentFolder,
}: {
  dragging: boolean
  currentFolder: LibraryFolder | null
}) {
  if (!dragging) return null
  return (
    <div className="pointer-events-none absolute inset-3 z-20 flex items-center justify-center rounded-card border-2 border-dashed border-accent bg-surface-0/90 text-center">
      <div>
        <Upload className="mx-auto size-7 text-accent-ink" />
        <p className="mt-2 text-title font-title text-ink">
          Drop files into {currentFolder ? currentFolder.name : 'Library'}
        </p>
        <p className="mt-1 text-meta font-meta text-ink-4">
          PDF, Markdown, or text · up to 10 MB each
        </p>
      </div>
    </div>
  )
}

function UploadProgress({ uploads }: { uploads: UploadState[] }) {
  return (
    <ul className="mb-3 space-y-1">
      {uploads.map((upload) => (
        <li
          key={upload.id}
          className="flex items-center gap-3 rounded-row bg-surface-2 px-3 py-2 smooth-shadow-ring-xs"
        >
          <FileText className="size-4 shrink-0 text-ink-3" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-label text-ink">{upload.name}</span>
            <span className="mt-1 block h-1 overflow-hidden rounded-full bg-line-2">
              <UploadBar progress={upload.progress} failed={upload.status === 'failed'} />
            </span>
          </span>
          <span
            className={cn(
              'text-meta font-meta',
              upload.status === 'failed' ? 'text-danger' : 'text-ink-4',
            )}
          >
            {upload.status === 'uploading'
              ? `${upload.progress}%`
              : upload.status === 'indexing'
                ? 'Indexing'
                : upload.error}
          </span>
        </li>
      ))}
    </ul>
  )
}

/** Returns the existing name for rename and move variants without optional state fields. */
function dialogOriginalName(state: DialogState): string {
  if (state.kind === 'new-folder') return ''
  if (state.kind === 'rename-folder' || state.kind === 'move-folder') return state.folder.name
  return state.document.name
}

const DIALOG_TITLES = {
  'new-folder': 'New folder',
  'rename-folder': 'Rename folder',
  'move-folder': 'Move folder',
  'rename-file': 'Rename file',
  'move-file': 'Move file',
} satisfies Record<DialogState['kind'], string>

/** Maps each closed dialog variant to the title already shown by the interface. */
function dialogTitle(state: DialogState): string {
  return DIALOG_TITLES[state.kind]
}

function LibraryDialog({
  state,
  folders,
  currentFolderId,
  onClose,
  onSaved,
}: {
  state: DialogState
  folders: LibraryFolder[]
  currentFolderId: string | null
  onClose: () => void
  onSaved: (result: libraryData.DialogResult) => Promise<void>
}) {
  const moving = state.kind === 'move-file' || state.kind === 'move-folder'
  const originalName = dialogOriginalName(state)
  const [name, setName] = useState(originalName)
  const [destination, setDestination] = useState<string>(moving ? '' : (currentFolderId ?? ''))
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const unavailable = state.kind === 'move-folder' ? new Set([state.folder.id]) : new Set<string>()

  async function submit(event: FormEvent) {
    event.preventDefault()
    setPending(true)
    setError(null)
    const result = await runClient(
      libraryData.saveDialog(state, name, destination, currentFolderId),
    )
    if (Result.isFailure(result)) {
      setError(result.failure.message)
      setPending(false)
      return
    }
    await onSaved(result.success)
  }

  const title = dialogTitle(state)
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/20 p-4 backdrop-blur-scrim"
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <form
        onSubmit={(event) => void submit(event)}
        className="w-full max-w-sm rounded-panel bg-surface-1 p-4 smooth-shadow-ring-md"
      >
        <div className="flex items-center gap-2">
          <h2 className="flex-1 text-dialog font-title text-ink">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="inline-flex size-8 items-center justify-center rounded-control text-ink-3 hover:bg-wash-hover"
          >
            <X className="size-4" />
          </button>
        </div>
        <LibraryDialogField
          state={state}
          moving={moving}
          folders={folders}
          unavailable={unavailable}
          name={name}
          destination={destination}
          onNameChange={setName}
          onDestinationChange={setDestination}
        />
        {error && <p className="mt-3 text-label text-danger">{error}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="h-9 rounded-control px-3 text-label text-ink-3 hover:bg-wash-hover"
          >
            Cancel
          </button>
          <button
            disabled={pending}
            className="inline-flex h-9 items-center gap-2 rounded-control bg-accent px-4 text-label font-title text-ink-on-accent disabled:opacity-50"
          >
            {pending && <LoaderCircle className="size-3.5 animate-spin" />}
            {moving ? 'Move' : 'Save'}
          </button>
        </div>
      </form>
    </div>
  )
}

/** Renders the destination or name field selected by the dialog's closed variant. */
function LibraryDialogField({
  state,
  moving,
  folders,
  unavailable,
  name,
  destination,
  onNameChange,
  onDestinationChange,
}: {
  state: DialogState
  moving: boolean
  folders: LibraryFolder[]
  unavailable: Set<string>
  name: string
  destination: string
  onNameChange: (name: string) => void
  onDestinationChange: (destination: string) => void
}) {
  if (moving) {
    return (
      <label className="mt-4 block">
        <span className="mb-1.5 block text-label font-title text-ink-2">Destination</span>
        <select
          value={destination}
          onChange={(event) => onDestinationChange(event.currentTarget.value)}
          className="h-10 w-full rounded-control bg-surface-2 px-3 text-label text-ink smooth-shadow-ring-xs"
        >
          <option value="">Library</option>
          {folders
            .filter((folder) => !unavailable.has(folder.id))
            .map((folder) => (
              <option key={folder.id} value={folder.id}>
                {folder.name}
              </option>
            ))}
        </select>
      </label>
    )
  }
  return (
    <label className="mt-4 block">
      <span className="mb-1.5 block text-label font-title text-ink-2">Name</span>
      <input
        autoFocus
        required
        maxLength={state.kind === 'rename-file' ? 180 : 120}
        value={name}
        onChange={(event) => onNameChange(event.currentTarget.value)}
        className="h-10 w-full rounded-control bg-surface-2 px-3 text-label text-ink smooth-shadow-ring-xs outline-none focus:smooth-shadow-ring-sm"
      />
    </label>
  )
}

function TileGrid({ tiles, onOpen }: { tiles: Tile[]; onOpen: (tile: Tile) => void }) {
  const folderTiles = tiles.filter((tile) => tile.kind === 'folder')
  const files = tiles.filter((tile) => tile.kind === 'file')
  return (
    <div className="mt-3">
      <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {folderTiles.map((tile) => (
          <li key={tile.id}>
            <button
              onClick={() => onOpen(tile)}
              className="group/row flex w-full items-center gap-2.5 rounded-card bg-surface-2 px-3 py-2.5 text-left smooth-shadow-ring-xs transition-surface duration-(--dur-fast) hover:bg-wash-hover hover:smooth-shadow-ring-sm"
            >
              <span className="inline-flex size-7 shrink-0 items-center justify-center text-ink-3">
                <Folder className="size-5" strokeWidth={1.7} />
              </span>
              <span className="min-w-0 flex-1 truncate text-label text-ink">{tile.name}</span>
              <span className="text-meta font-meta text-ink-4">{tile.meta}</span>
            </button>
          </li>
        ))}
      </ul>
      <ul className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
        {files.map((tile) => (
          <li key={tile.id}>
            <button
              onClick={() => onOpen(tile)}
              className="group/tile flex w-full flex-col overflow-hidden rounded-card bg-surface-2 p-3 text-left smooth-shadow-ring-sm transition-press duration-(--dur-fast) hover:-translate-y-0.5 hover:bg-surface-3 hover:smooth-shadow-ring-md active:scale-98"
            >
              <span className="flex items-center gap-2">
                <FileText className="size-4 shrink-0 text-ink-3" strokeWidth={1.6} />
                <span className="min-w-0 flex-1 truncate text-label text-ink">{tile.name}</span>
                {tile.document && tile.document.status === 'processing' ? (
                  <LoaderCircle className="size-4 shrink-0 animate-spin text-working" />
                ) : (
                  <MoreHorizontal className="size-4 shrink-0 text-ink-4 opacity-0 transition-opacity group-hover/tile:opacity-100" />
                )}
              </span>
              <span className="relative mt-3 block aspect-4/3 overflow-hidden rounded-control bg-surface-1 ring-line">
                <Preview />
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

function TileList({ tiles, onOpen }: { tiles: Tile[]; onOpen: (tile: Tile) => void }) {
  return (
    <ul className="mt-3">
      {tiles.map((tile) => (
        <li key={tile.id}>
          <button
            onClick={() => onOpen(tile)}
            className="group/row flex w-full items-center gap-3 rounded-row px-2.5 py-2 text-left transition-colors duration-(--dur-fast) outline-none select-none hover:bg-wash-hover"
          >
            <span
              className={cn(
                'inline-flex size-8 shrink-0 items-center justify-center rounded-control',
                tile.kind === 'folder'
                  ? 'bg-accent-soft text-accent-ink'
                  : 'bg-surface-2 text-ink-3 smooth-shadow-ring-xs',
              )}
            >
              {tile.kind === 'file' ? (
                <FileText className="size-4.5" />
              ) : (
                <Folder className="size-4.5" />
              )}
            </span>
            <span className="min-w-0 flex-1 truncate text-title text-ink">{tile.name}</span>
            <span className="text-meta font-meta text-ink-4">{tile.meta}</span>
            <MoreHorizontal className="size-4 shrink-0 text-ink-4 opacity-0 transition-opacity group-hover/row:opacity-100" />
          </button>
        </li>
      ))}
    </ul>
  )
}

function DocumentDetail({
  document,
  onAsk,
  onDelete,
  onRename,
  onMove,
}: {
  document: LibraryDocument
  onAsk: () => void
  onDelete: () => void
  onRename: () => void
  onMove: () => void
}) {
  return (
    <div className="mt-3">
      <div className="flex items-center gap-3">
        <span className="inline-flex size-9 items-center justify-center rounded-control bg-surface-2 text-ink-3 smooth-shadow-ring-xs">
          <FileText className="size-4.5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-title text-ink">{document.name}</p>
          <p className="text-meta font-meta text-ink-4">
            {formatBytes(document.size)} · {document.chunkCount} passages
          </p>
        </div>
        <button
          onClick={onRename}
          aria-label="Rename file"
          className="inline-flex size-8 items-center justify-center rounded-control text-ink-3 hover:bg-wash-hover"
        >
          <Pencil className="size-4" />
        </button>
        <button
          onClick={onMove}
          aria-label="Move file"
          className="inline-flex size-8 items-center justify-center rounded-control text-ink-3 hover:bg-wash-hover"
        >
          <FileInput className="size-4" />
        </button>
        <a
          href={`/api/library/${encodeURIComponent(document.id)}/content`}
          target="_blank"
          rel="noreferrer"
          aria-label="Open original"
          className="inline-flex size-8 items-center justify-center rounded-control text-ink-3 hover:bg-wash-hover"
        >
          <ExternalLink className="size-4" />
        </a>
        <button
          onClick={onDelete}
          aria-label="Delete file"
          className="inline-flex size-8 items-center justify-center rounded-control text-ink-3 hover:bg-danger-soft hover:text-danger"
        >
          <Trash2 className="size-4" />
        </button>
      </div>
      <div className="mt-5 rounded-card bg-surface-2 p-5 smooth-shadow-ring-xs">
        <Status document={document} />
        <p className="mt-4 text-label leading-relaxed whitespace-pre-wrap text-ink-3">
          {document.preview || document.error || 'Extracting and indexing text…'}
        </p>
      </div>
      {document.status === 'ready' && (
        <button
          onClick={onAsk}
          className="mt-4 inline-flex h-9 items-center gap-2 rounded-control bg-accent px-4 text-label font-title text-ink-on-accent"
        >
          <MessageSquareText className="size-4" />
          Ask Vivid about this
        </button>
      )}
    </div>
  )
}

function Status({ document }: { document: LibraryDocument }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 text-meta font-meta',
        document.status === 'ready'
          ? 'text-success'
          : document.status === 'failed'
            ? 'text-danger'
            : 'text-working',
      )}
    >
      {document.status === 'ready' ? (
        <Check className="size-3" />
      ) : document.status === 'failed' ? (
        <CircleAlert className="size-3" />
      ) : (
        <LoaderCircle className="size-3 animate-spin" />
      )}
      {document.status === 'ready' ? 'Ready' : document.status === 'failed' ? 'Failed' : 'Indexing'}
    </span>
  )
}

function SearchResults({
  results,
  onOpen,
}: {
  results: SearchResult[]
  onOpen: (result: SearchResult) => void
}) {
  return (
    <ul className="mt-3">
      {results.length === 0 ? (
        <li className="py-12 text-center text-label text-ink-4">No matching files.</li>
      ) : (
        results.map((result) => (
          <li key={result.chunkId}>
            <button
              onClick={() => onOpen(result)}
              className="group/row flex w-full items-start gap-3 rounded-row px-2.5 py-3 text-left hover:bg-wash-hover"
            >
              <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-control bg-surface-2 text-ink-3 smooth-shadow-ring-xs">
                <FileText className="size-4" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-title text-ink">{result.filename}</span>
                <span className="mt-1 line-clamp-2 text-label text-ink-3">{result.text}</span>
              </span>
              {result.page && (
                <span className="text-meta font-meta text-ink-4">Page {result.page}</span>
              )}
            </button>
          </li>
        ))
      )}
    </ul>
  )
}

function Preview() {
  return (
    <span
      aria-hidden
      className="absolute inset-x-7 inset-y-3 flex flex-col gap-1.5 rounded-sm bg-surface-3 p-2.5 smooth-shadow-ring-xs"
    >
      <i className="h-2 w-1/2 rounded-full bg-ink/15" />
      <i className="mt-1 h-1 w-full rounded-full bg-line-1" />
      <i className="h-1 w-11/12 rounded-full bg-line-1" />
      <i className="h-1 w-4/5 rounded-full bg-line-1" />
      <i className="mt-auto h-1 w-2/3 rounded-full bg-line-1" />
    </span>
  )
}

/** The fill of one upload's progress track; failure recolours it without resetting the width. */
function UploadBar({ progress, failed }: { progress: number; failed: boolean }) {
  // SAFETY: React forwards this validated CSS custom property; `w-(--upload-progress)` reads it.
  const barStyle = { '--upload-progress': `${progress}%` } as React.CSSProperties
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
