import { useState } from 'react'
import { Platform, RefreshControl, ScrollView, View } from 'react-native'
import type { NativeStackScreenProps } from '@react-navigation/native-stack'
import { FileText, Folder as FolderIcon, FolderPlus, Upload } from 'lucide-react-native'
import * as DocumentPicker from 'expo-document-picker'
import { File } from 'expo-file-system'
import { LibraryFolderListResponse, LibraryListResponse } from '@vivid/contracts'
import { openDocument } from '../lib/documents'
import { useOpenThread, useWorkspace, type Routes } from '../workspace'
import { useResource } from '../lib/resource'
import { useTheme } from '../theme'
import { type Document, type Folder } from '../lib/models'
import {
  Card,
  ControlPill,
  EditSheet,
  Empty,
  Feedback,
  Field,
  Header,
  Label,
  Sheet,
  confirmDelete,
  styles,
} from '../components/ui'

type Selection =
  | { readonly kind: 'file'; readonly item: Document }
  | {
      readonly kind: 'folder'
      readonly item: Folder
    }
type SearchResult = {
  readonly chunkId: string
  readonly documentId: string
  readonly filename: string
  readonly page: number | null
  readonly text: string
}
type EditState = {
  readonly title: string
  readonly fields: { readonly key: string; readonly label: string; readonly value?: string }[]
  readonly save: (values: Record<string, string>) => Promise<void>
}
type LibraryAction = (work: () => Promise<void>) => Promise<void>
type LibraryApi = ReturnType<typeof useWorkspace>['api']

/** Owns the shared busy/error lifecycle around Library mutations. */
function useLibraryAction(
  refreshCurrent: () => Promise<void>,
  refreshFolders: () => Promise<void>,
) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const action: LibraryAction = async (work) => {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      await work()
      await refreshCurrent()
      await refreshFolders()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }
  return { action, busy, error }
}

/** Adapts the native document picker result into the existing multipart API request. */
async function uploadLibraryDocument(input: {
  readonly api: LibraryApi
  readonly folderId: string | null
  readonly onUploaded: () => void
}) {
  const result = await DocumentPicker.getDocumentAsync({
    type: ['application/pdf', 'text/plain', 'text/markdown'],
    copyToCacheDirectory: true,
  })
  if (result.canceled) return
  const asset = result.assets[0]
  if (asset.size && asset.size > 10 * 1024 * 1024)
    throw new Error('Choose a file smaller than 10 MB.')
  const form = new FormData()
  form.append(
    'file',
    Platform.OS === 'web' && asset.file ? asset.file : new File(asset.uri),
    asset.name,
  )
  if (input.folderId !== null) form.append('folderId', input.folderId)
  await input.api.request('/api/library', 'POST', form)
  input.onUploaded()
}

/** Derives the visible Library title from the current folder path. */
function libraryTitle(path: readonly Folder[]) {
  const currentFolder = path.at(-1)
  return currentFolder === undefined ? 'Library' : currentFolder.name
}

/** Selects the existing file or folder endpoint for one decoded Library selection. */
function libraryEndpoint(value: Selection) {
  return value.kind === 'file'
    ? `/api/library/${value.item.id}`
    : `/api/library/folders/${value.item.id}`
}

/** Searches the current Library scope without serializing an absent folder identifier. */
function searchLibrary(api: LibraryApi, query: string, folderId: string | null) {
  if (folderId === null) {
    return api.request<{ results: SearchResult[] }>('/api/library/search', 'POST', {
      query,
      limit: 8,
    })
  }
  return api.request<{ results: SearchResult[] }>('/api/library/search', 'POST', {
    query,
    folderId,
    limit: 8,
  })
}

/** Renders Library passage matches without owning search state. */
function SearchResults({
  results,
  busy,
  api,
  action,
}: {
  readonly results: readonly SearchResult[]
  readonly busy: boolean
  readonly api: LibraryApi
  readonly action: LibraryAction
}) {
  if (results.length === 0) {
    return <Label tone="ink-3">No passages found. Try a different phrase.</Label>
  }
  return (
    <>
      {results.map((result) => (
        <Card key={result.chunkId}>
          <Label size="label">
            {result.filename}
            {result.page ? ` · page ${result.page}` : ''}
          </Label>
          <Label size="label" tone="ink-2">
            {result.text}
          </Label>
          <ControlPill
            label="Open source"
            disabled={busy}
            onPress={() =>
              void action(() =>
                openDocument(api, `/api/library/${result.documentId}/content`, result.filename),
              )
            }
          />
        </Card>
      ))}
    </>
  )
}

/** Renders child folders while the parent retains path and selection state. */
function FolderCards({
  folders,
  colors: c,
  onOpen,
  onSelect,
}: {
  readonly folders: readonly Folder[]
  readonly colors: ReturnType<typeof useTheme>['colors']
  readonly onOpen: (folder: Folder) => void
  readonly onSelect: (selection: Selection) => void
}) {
  return folders.map((folder) => (
    <Card key={folder.id}>
      <View style={styles.row}>
        <FolderIcon size={22} color={c['ink-2']} />
        <Label style={{ flex: 1 }}>{folder.name}</Label>
        <Label size="micro" tone="ink-3">
          {folder.itemCount} items
        </Label>
      </View>
      <View style={styles.wrap}>
        <ControlPill label="Open folder" onPress={() => onOpen(folder)} />
        <ControlPill label="Manage" onPress={() => onSelect({ kind: 'folder', item: folder })} />
      </View>
    </Card>
  ))
}

/** Renders document status cards without owning document selection. */
function DocumentCards({
  documents,
  colors: c,
  onSelect,
}: {
  readonly documents: readonly Document[]
  readonly colors: ReturnType<typeof useTheme>['colors']
  readonly onSelect: (selection: Selection) => void
}) {
  return documents.map((document) => (
    <Card key={document.id}>
      <View style={styles.row}>
        <FileText size={22} color={c['ink-2']} />
        <Label style={{ flex: 1 }}>{document.name}</Label>
      </View>
      <Label size="label" tone={document.status === 'failed' ? 'status-danger' : 'ink-3'}>
        {Math.max(1, Math.round(document.size / 1024))} KB ·{' '}
        {document.status === 'ready'
          ? 'Ready to read'
          : document.status === 'failed'
            ? (document.error ?? 'Could not read this file')
            : 'Getting it ready…'}
      </Label>
      <ControlPill
        label="View document"
        onPress={() => onSelect({ kind: 'file', item: document })}
      />
    </Card>
  ))
}

/** Renders Library contents while the screen owns resources and mutations. */
function LibraryContent({
  loading,
  resourceError,
  error,
  busy,
  onRefresh,
  folderId,
  onEdit,
  query,
  onQueryChange,
  onResults,
  results,
  onClearSearch,
  folders,
  documents,
  hasData,
  colors,
  api,
  action,
  onOpenFolder,
  onSelect,
}: {
  readonly loading: boolean
  readonly resourceError: string
  readonly error: string
  readonly busy: boolean
  readonly onRefresh: () => Promise<void>
  readonly folderId: string | null
  readonly onEdit: (edit: EditState) => void
  readonly query: string
  readonly onQueryChange: (query: string) => void
  readonly onResults: (results: SearchResult[]) => void
  readonly results: readonly SearchResult[] | null
  readonly onClearSearch: () => void
  readonly folders: readonly Folder[]
  readonly documents: readonly Document[]
  readonly hasData: boolean
  readonly colors: ReturnType<typeof useTheme>['colors']
  readonly api: LibraryApi
  readonly action: LibraryAction
  readonly onOpenFolder: (folder: Folder) => void
  readonly onSelect: (selection: Selection) => void
}) {
  return (
    <ScrollView
      refreshControl={<RefreshControl refreshing={loading} onRefresh={onRefresh} />}
      contentContainerStyle={styles.page}
    >
      <Feedback error={error || resourceError} retry={onRefresh} />
      {busy && (
        <Label size="label" tone="ink-3">
          One moment…
        </Label>
      )}
      <View style={styles.wrap}>
        <ControlPill
          icon={FolderPlus}
          label="New folder"
          onPress={() => {
            onEdit({
              title: 'A place for related things',
              fields: [{ key: 'name', label: 'Folder name' }],
              save: async (values) => {
                await api.request('/api/library/folders', 'POST', {
                  name: values.name,
                  parentId: folderId,
                })
              },
            })
          }}
        />
      </View>
      <Field
        accessibilityLabel="Search the Library"
        placeholder="Find something in your files…"
        value={query}
        onChangeText={onQueryChange}
      />
      <View style={styles.wrap}>
        <ControlPill
          label="Search files"
          disabled={busy || query.trim().length < 2}
          onPress={() => {
            void action(async () => {
              const body = await searchLibrary(api, query.trim(), folderId)
              onResults(body.results)
            })
          }}
        />
        {results !== null && <ControlPill label="Clear search" onPress={onClearSearch} />}
      </View>
      {results !== null && (
        <SearchResults results={results} busy={busy} api={api} action={action} />
      )}
      <Label size="label" tone="ink-3">
        PDF, Markdown, and text · up to 10 MB
      </Label>
      {!loading && !resourceError && hasData && documents.length === 0 && folders.length === 0 && (
        <Empty
          title="Put a little context here."
          detail="Notes, briefs, the document you always have to explain. Vivid can read them when you ask."
        />
      )}
      <FolderCards folders={folders} colors={colors} onOpen={onOpenFolder} onSelect={onSelect} />
      <DocumentCards documents={documents} colors={colors} onSelect={onSelect} />
    </ScrollView>
  )
}

/** Renders actions for one selected Library item without owning selection state. */
function SelectionSheet({
  selected,
  busy,
  error,
  api,
  createThread,
  open,
  action,
  endpoint,
  onClose,
  onRename,
  onMove,
  onDeleted,
}: {
  readonly selected: Selection
  readonly busy: boolean
  readonly error: string
  readonly api: LibraryApi
  readonly createThread: ReturnType<typeof useWorkspace>['createThread']
  readonly open: ReturnType<typeof useOpenThread>
  readonly action: LibraryAction
  readonly endpoint: (selection: Selection) => string
  readonly onClose: () => void
  readonly onRename: (selection: Selection) => void
  readonly onMove: (selection: Selection) => void
  readonly onDeleted: () => void
}) {
  return (
    <Sheet title={selected.item.name} onClose={onClose}>
      <Feedback error={error} />
      {selected.kind === 'file' && (
        <>
          <Label tone="ink-2">{selected.item.preview || 'Your document is in the Library.'}</Label>
          <ControlPill
            primary
            label="Ask Vivid about this"
            disabled={busy || selected.item.status !== 'ready'}
            onPress={() =>
              void action(async () => {
                const thread = await createThread(
                  `Search the Library and answer a question about “${selected.item.name}”: `,
                )
                onClose()
                open(thread.id, thread.title, thread.draft)
              })
            }
          />
          <ControlPill
            label="Open original"
            disabled={busy}
            onPress={() =>
              void action(async () => {
                await openDocument(
                  api,
                  `/api/library/${selected.item.id}/content`,
                  selected.item.name,
                )
              })
            }
          />
        </>
      )}
      <ControlPill label="Rename" onPress={() => onRename(selected)} />
      <ControlPill label="Move" onPress={() => onMove(selected)} />
      <ControlPill
        danger
        label={`Delete ${selected.kind === 'file' ? 'document' : 'folder'}`}
        disabled={busy}
        onPress={() =>
          confirmDelete(
            selected.item.name,
            () =>
              void action(async () => {
                await api.request(endpoint(selected), 'DELETE')
                onDeleted()
              }),
          )
        }
      />
    </Sheet>
  )
}

/** Renders move targets while the screen owns destination and refresh state. */
function MoveSheet({
  move,
  folders,
  busy,
  error,
  api,
  action,
  endpoint,
  onMoved,
  onClose,
}: {
  readonly move: Selection
  readonly folders: readonly Folder[]
  readonly busy: boolean
  readonly error: string
  readonly api: LibraryApi
  readonly action: LibraryAction
  readonly endpoint: (selection: Selection) => string
  readonly onMoved: () => void
  readonly onClose: () => void
}) {
  return (
    <Sheet title={`Move ${move.item.name}`} onClose={onClose}>
      <Feedback error={error} />
      {[{ id: '', name: 'Library' }, ...folders.filter((folder) => folder.id !== move.item.id)].map(
        (folder) => (
          <ControlPill
            key={folder.id}
            label={folder.name}
            disabled={busy}
            onPress={() =>
              void action(async () => {
                await api.request(
                  endpoint(move),
                  'PATCH',
                  move.kind === 'file'
                    ? { folderId: folder.id || null }
                    : { parentId: folder.id || null },
                )
                onMoved()
              })
            }
          />
        ),
      )}
    </Sheet>
  )
}

/** Renders the active Library edit form without owning refresh state. */
function LibraryEditor({
  edit,
  onClose,
  onSaved,
}: {
  readonly edit: EditState
  readonly onClose: () => void
  readonly onSaved: (values: Record<string, string>) => Promise<void>
}) {
  return <EditSheet title={edit.title} fields={edit.fields} onClose={onClose} onSave={onSaved} />
}

type LibraryViewProps = {
  readonly title: string
  readonly onBack: () => void
  readonly busy: boolean
  readonly onUpload: () => void
  readonly loading: boolean
  readonly resourceError: string
  readonly error: string
  readonly onRefresh: () => Promise<void>
  readonly folderId: string | null
  readonly onEdit: (edit: EditState) => void
  readonly query: string
  readonly onQueryChange: (query: string) => void
  readonly onResults: (results: SearchResult[]) => void
  readonly results: readonly SearchResult[] | null
  readonly onClearSearch: () => void
  readonly folders: readonly Folder[]
  readonly allFolders: readonly Folder[]
  readonly documents: readonly Document[]
  readonly hasData: boolean
  readonly colors: ReturnType<typeof useTheme>['colors']
  readonly api: LibraryApi
  readonly action: LibraryAction
  readonly onOpenFolder: (folder: Folder) => void
  readonly onSelect: (selection: Selection) => void
  readonly selected: Selection | null
  readonly createThread: ReturnType<typeof useWorkspace>['createThread']
  readonly open: ReturnType<typeof useOpenThread>
  readonly endpoint: (selection: Selection) => string
  readonly onCloseSelected: () => void
  readonly onRename: (selection: Selection) => void
  readonly onMove: (selection: Selection) => void
  readonly onDeleted: () => void
  readonly move: Selection | null
  readonly moveError: string
  readonly onMoved: () => void
  readonly onCloseMove: () => void
  readonly edit: EditState | null
  readonly onCloseEdit: () => void
  readonly onSaved: (values: Record<string, string>) => Promise<void>
}

/** Composes the Library surface from render-only sections and screen-owned callbacks. */
function LibraryView(props: LibraryViewProps) {
  return (
    <View style={{ flex: 1 }}>
      <Header
        title={props.title}
        onBack={props.onBack}
        trailing={
          <ControlPill
            icon={Upload}
            accessibilityLabel="Upload a document"
            disabled={props.busy}
            onPress={props.onUpload}
          />
        }
      />
      <LibraryContent
        loading={props.loading}
        resourceError={props.resourceError}
        error={props.error}
        busy={props.busy}
        onRefresh={props.onRefresh}
        folderId={props.folderId}
        onEdit={props.onEdit}
        query={props.query}
        onQueryChange={props.onQueryChange}
        onResults={props.onResults}
        results={props.results}
        onClearSearch={props.onClearSearch}
        folders={props.folders}
        documents={props.documents}
        hasData={props.hasData}
        colors={props.colors}
        api={props.api}
        action={props.action}
        onOpenFolder={props.onOpenFolder}
        onSelect={props.onSelect}
      />
      {props.selected !== null && (
        <SelectionSheet
          selected={props.selected}
          busy={props.busy}
          error={props.error}
          api={props.api}
          createThread={props.createThread}
          open={props.open}
          action={props.action}
          endpoint={props.endpoint}
          onClose={props.onCloseSelected}
          onRename={props.onRename}
          onMove={props.onMove}
          onDeleted={props.onDeleted}
        />
      )}
      {props.move !== null && (
        <MoveSheet
          move={props.move}
          folders={props.allFolders}
          busy={props.busy}
          error={props.moveError}
          api={props.api}
          action={props.action}
          endpoint={props.endpoint}
          onMoved={props.onMoved}
          onClose={props.onCloseMove}
        />
      )}
      {props.edit !== null && (
        <LibraryEditor edit={props.edit} onClose={props.onCloseEdit} onSaved={props.onSaved} />
      )}
    </View>
  )
}

export function Library({ navigation }: NativeStackScreenProps<Routes, 'Library'>) {
  const { api, createThread } = useWorkspace()
  const { colors: c } = useTheme()
  const open = useOpenThread()
  const [path, setPath] = useState<Folder[]>([])
  const currentFolder = path.at(-1)
  const folderId = currentFolder === undefined ? undefined : currentFolder.id
  const resource = useResource(
    api,
    `/api/library${folderId ? `?folderId=${encodeURIComponent(folderId)}` : ''}`,
    LibraryListResponse,
  )
  const allFolders = useResource(api, '/api/library/folders', LibraryFolderListResponse)
  const [selected, setSelected] = useState<Selection>()
  const [edit, setEdit] = useState<EditState>()
  const [move, setMove] = useState<Selection>()
  const { action, busy, error } = useLibraryAction(resource.refresh, allFolders.refresh)
  const [query, setQuery] = useState('')
  const data = resource.data
  const folderData = allFolders.data
  const [results, setResults] = useState<SearchResult[]>()
  const upload = () =>
    uploadLibraryDocument({
      api,
      folderId: folderId ?? null,
      onUploaded: () => setResults(undefined),
    })
  const folders = data === undefined ? [] : data.folders
  const documents = data === undefined ? [] : data.documents
  const allFolderItems = folderData === undefined ? [] : folderData.folders
  return (
    <LibraryView
      title={libraryTitle(path)}
      onBack={() => {
        setResults(undefined)
        if (path.length) setPath((currentPath) => currentPath.slice(0, -1))
        else navigation.goBack()
      }}
      busy={busy}
      onUpload={() => void action(upload)}
      loading={resource.loading}
      resourceError={resource.error}
      error={error}
      onRefresh={resource.refresh}
      folderId={folderId ?? null}
      onEdit={setEdit}
      query={query}
      onQueryChange={setQuery}
      onResults={setResults}
      results={results ?? null}
      onClearSearch={() => {
        setResults(undefined)
        setQuery('')
      }}
      folders={folders}
      documents={documents}
      hasData={data !== undefined}
      colors={c}
      api={api}
      action={action}
      onOpenFolder={(folder) => {
        setResults(undefined)
        setPath((currentPath) => [...currentPath, folder])
      }}
      onSelect={setSelected}
      selected={selected ?? null}
      createThread={createThread}
      open={open}
      endpoint={libraryEndpoint}
      onCloseSelected={() => setSelected(undefined)}
      onRename={(value) => {
        setSelected(undefined)
        setEdit({
          title: 'Rename',
          fields: [{ key: 'name', label: 'Name', value: value.item.name }],
          save: async (values) => {
            await api.request(libraryEndpoint(value), 'PATCH', { name: values.name })
          },
        })
      }}
      onMove={(value) => {
        setMove(value)
        setSelected(undefined)
      }}
      onDeleted={() => {
        setSelected(undefined)
        setResults(undefined)
      }}
      move={move ?? null}
      moveError={error || allFolders.error}
      onMoved={() => {
        setMove(undefined)
        setResults(undefined)
      }}
      onCloseMove={() => setMove(undefined)}
      edit={edit ?? null}
      onCloseEdit={() => setEdit(undefined)}
      onSaved={async (values) => {
        if (edit === undefined) return
        await edit.save(values)
        setResults(undefined)
        await resource.refresh()
        await allFolders.refresh()
      }}
      allFolders={allFolderItems}
    />
  )
}
