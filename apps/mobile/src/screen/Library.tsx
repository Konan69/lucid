import {
  Workspace,
  type LibraryFolder,
  type LibraryFolderId,
  type LibraryItem,
  type LibraryShelf,
} from '@vivid/contracts'
import { library, type LiveQuery } from '@vivid/state'
import { Data, Effect, Option, Result } from 'effect'
import { useState, type ReactNode } from 'react'
import { ScrollView } from 'react-native'
import type { NativeStackScreenProps } from '@react-navigation/native-stack'
import {
  FileText,
  Folder as FolderIcon,
  FolderOpen,
  FolderPlus,
  Library as LibraryIcon,
  Upload,
} from 'lucide-react-native'
import { addDocument, openDocument } from '../data/documents'
import { commit, warn } from '../data/haptics'
import { LiveState, refusalOf, useLive, useLiveData } from '../data/live'
import { Start, startThread } from '../data/threads'
import { useTheme } from '../theme'
import { Bar } from '../ui/Bar'
import { Screen } from '../ui/Screen'
import { Live } from '../ui/Live'
import { Row, Section } from '../ui/List'
import { NameSheet, Sheet } from '../ui/Sheet'
import { ArtifactShelf } from './artifact/Shelf'
import {
  Button,
  confirmDestructive,
  Empty,
  Label,
  Notice,
  Segmented,
  Skeleton,
  styles,
} from '../ui/ui'
import { useGo, useOpenThread, useMe, type Routes } from '../workspace'
import { start } from '../data/app'

/** One level of one shelf: which shelf, which folder on it (or its top), and the query read. */
interface Level {
  readonly shelf: LibraryShelf
  readonly folderId: LibraryFolderId | null
  readonly query: LiveQuery<library.LibraryList>
}

/**
 * What is open over a level. One thing at a time, so a file's sheet and the form for a new
 * folder can never be up together.
 */
type Over = Data.TaggedEnum<{
  Nothing: {}
  NewFolder: {}
  Item: { readonly item: LibraryItem }
}>
const Over = Data.taggedEnum<Over>()

/**
 * The Library: what Vivid has been given to read. A personal space has one shelf. In a Company
 * there are two, the Person's own and the Company's, and the choice between them is the only
 * thing this screen holds; what is on a shelf is a live query.
 */
export function Library() {
  const me = useMe()
  const data = useLiveData()

  const shelves = library.shelvesOf(me.workspace)
  const [chosen, setChosen] = useState<LibraryShelf>('Mine')
  // Leaving a Company takes its shelf with it; the Person is then looking at their own.
  const shelf = shelves.some((choice) => choice.shelf === chosen) ? chosen : 'Mine'
  const level: Level = { shelf, folderId: null, query: data.live.library.get(shelf) }
  return (
    <LevelScreen
      title="Library"
      subtitle={Workspace.match(me.workspace, {
        Personal: () => 'What Vivid can read in your threads.',
        Company: () => 'What Vivid can read, yours and the company’s.',
      })}
      level={level}
      above={
        <>
          {/* What Vivid made belongs to the workspace, not to a shelf: it heads the top level. */}
          <ArtifactShelf />
          {shelves.length > 1 && (
            <Segmented
              label="Shelf"
              value={shelf}
              options={shelves.map((choice) => ({ value: choice.shelf, label: choice.name }))}
              onChange={setChosen}
            />
          )}
        </>
      }
      below={null}
    />
  )
}

/** One folder, a level down. Renaming and deleting it live at the foot of its own page. */
export function Folder({ route }: NativeStackScreenProps<Routes, 'Folder'>) {
  const data = useLiveData()

  const { shelf, id, name } = route.params
  const level: Level = { shelf, folderId: id, query: data.live.folder.get({ shelf, folderId: id }) }
  return (
    <LevelScreen
      title={name}
      level={level}
      above={null}
      below={<FolderActions id={id} name={name} />}
    />
  )
}

/**
 * Adding a file to a level. The picker and the upload are one action; while it runs the button
 * says so, and what came of it (a refusal, or that the shelf already held the same file) is said
 * under the bar. A file that was taken needs no announcement: it appears in the list.
 */
function useAdd(level: Level) {
  const data = useLiveData()
  const [busy, setBusy] = useState(false)
  const [said, setSaid] = useState<Option.Option<string>>(Option.none())
  function add() {
    return start(
      Effect.gen(function* () {
        setBusy(true)
        setSaid(Option.none())
        const result = yield* data.running(
          addDocument(data.session, { shelf: level.shelf, folderId: level.folderId }),
        )
        setBusy(false)
        if (Result.isFailure(result)) {
          setSaid(Option.some(result.failure.message))
          return
        }
        if (Option.exists(result.success, (uploaded) => uploaded.duplicate)) {
          setSaid(Option.some('That file is already on this shelf.'))
        } else if (Option.isSome(result.success)) commit()
      }),
    )
  }
  return { busy, said, add }
}

/** A level of the Library as a screen: its bar, what it holds, and what can be added to it. */
function LevelScreen({
  title,
  subtitle,
  level,
  above,
  below,
}: {
  title: string
  subtitle?: string
  level: Level
  above: ReactNode
  below: ReactNode
}) {
  const state = useLive(level.query)
  // The level has answered and holds nothing: under its bar it is its empty state.
  const none =
    LiveState.$is('Ready')(state) &&
    state.value.folders.length === 0 &&
    state.value.documents.length === 0
  const [over, setOver] = useState<Over>(Over.Nothing())
  // A delete closes its sheet at once, so a refused one has only the level to be said in.
  const [undeleted, setUndeleted] = useState<Option.Option<string>>(Option.none())
  const adding = useAdd(level)
  const close = () => setOver(Over.Nothing())
  /** Opens something over the level. The Person has moved on, so an old refusal is taken down. */
  const open = (next: Over) => {
    setUndeleted(Option.none())
    setOver(next)
  }
  return (
    <Screen>
      <Bar
        title={title}
        actions={[
          {
            symbol: 'folder.badge.plus',
            icon: FolderPlus,
            label: 'New folder',
            disabled: false,
            onPress: () => open(Over.NewFolder()),
          },
          {
            symbol: 'square.and.arrow.up',
            icon: Upload,
            label: 'Add a file',
            disabled: adding.busy,
            onPress: () => void adding.add(),
          },
        ]}
      />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={[styles.page, styles.column]}
      >
        {/* What this level is, as the page's first line. It was the line under the bar's title;
            the system's bar has no such line without a native change (`ui/Bar.tsx`). With
            nothing on the level its empty state says it instead (`Empty`). */}
        {subtitle !== undefined && !none && (
          <Label size="label" tone="ink-2">
            {subtitle}
          </Label>
        )}
        {above}
        {adding.busy && (
          <Label size="label" tone="ink-2">
            Adding your file…
          </Label>
        )}
        {Option.isSome(adding.said) && <Notice message={adding.said.value} />}
        {Option.isSome(undeleted) && <Notice message={undeleted.value} />}
        <Live state={state} loading={<Skeleton rows={4} />}>
          {(value) => (
            <Contents
              level={level}
              list={library.inFolder(value, level.folderId)}
              onItem={(item) => open(Over.Item({ item }))}
              onAdd={() => void adding.add()}
            />
          )}
        </Live>
        {below}
      </ScrollView>
      {Over.$is('NewFolder')(over) && <NewFolder level={level} onClose={close} />}
      {Over.$is('Item')(over) && (
        <ItemSheet
          level={level}
          item={over.item}
          onClose={close}
          onUndeleted={(message) => setUndeleted(Option.some(message))}
        />
      )}
    </Screen>
  )
}

/** What Vivid has to say about a file: that it is reading it, that it could not, or its size. */
function noteOf(item: LibraryItem): string {
  switch (item.status) {
    case 'processing':
      return 'Vivid is reading this file.'
    case 'ready':
      return library.formatBytes(item.size)
    case 'failed':
      return item.error === null ? 'Vivid could not read this file.' : item.error
  }
}

/** The folders and files at one level. */
function Contents({
  level,
  list,
  onItem,
  onAdd,
}: {
  level: Level
  list: library.LibraryList
  onItem: (item: LibraryItem) => void
  onAdd: () => void
}) {
  const go = useGo()
  const { colors: c } = useTheme()
  if (list.folders.length === 0 && list.documents.length === 0) {
    return (
      <Empty
        icon={level.folderId === null ? LibraryIcon : FolderOpen}
        title={level.folderId === null ? 'No files yet' : 'This folder is empty'}
        line={
          level.shelf === 'Company'
            ? 'Add a file and Vivid can read it in every member’s threads.'
            : 'Add a file and Vivid can read it in your threads.'
        }
        room="page"
      >
        <Button kind="primary" icon={Upload} label="Add a file" onPress={onAdd} />
      </Empty>
    )
  }
  return (
    <>
      {list.folders.length > 0 && (
        <Section title="Folders">
          {list.folders.map((folder: LibraryFolder) => (
            <Row
              key={folder.id}
              leading={<FolderIcon size={20} strokeWidth={1.6} color={c['foreground-secondary']} />}
              title={folder.name}
              detail={folder.itemCount === 1 ? '1 file' : `${folder.itemCount} files`}
              onPress={() =>
                go.push('Folder', { shelf: level.shelf, id: folder.id, name: folder.name })
              }
            />
          ))}
        </Section>
      )}
      {list.documents.length > 0 && (
        <Section title="Files">
          {list.documents.map((item) => (
            <Row
              key={item.id}
              leading={<FileText size={20} strokeWidth={1.6} color={c['foreground-secondary']} />}
              title={item.name}
              detail={noteOf(item)}
              onPress={() => onItem(item)}
            />
          ))}
        </Section>
      )}
    </>
  )
}

function NewFolder({ level, onClose }: { level: Level; onClose: () => void }) {
  const data = useLiveData()
  return (
    <NameSheet
      title="New folder"
      label="Name"
      initial=""
      placeholder="Contracts"
      action="Create folder"
      maxLength={120}
      onClose={onClose}
      onSave={(name) =>
        data
          .changing((client) =>
            client.CreateLibraryFolder({ name, shelf: level.shelf, parentId: level.folderId }),
          )
          .pipe(Effect.map(refusalOf))
      }
    />
  )
}

/** Renaming and deleting the folder whose page this is. Deleting it leaves the page. */
function FolderActions({ id, name }: { id: LibraryFolderId; name: string }) {
  const data = useLiveData()
  const go = useGo()
  const [renaming, setRenaming] = useState(false)
  const [refused, setRefused] = useState<Option.Option<string>>(Option.none())

  const remove = () =>
    confirmDestructive({
      title: `Delete “${name}”?`,
      detail: 'The folder is removed. This cannot be undone.',
      action: 'Delete folder',
      onConfirm: () => {
        warn()
        void data
          .change((client) => client.DeleteLibraryFolder({ id }))
          .then((result) => {
            if (Result.isFailure(result)) setRefused(Option.some(result.failure.message))
            else go.goBack()
          })
      },
    })

  return (
    <>
      {Option.isSome(refused) && <Notice message={refused.value} />}
      <Section title="This folder">
        <Row title="Rename folder" onPress={() => setRenaming(true)} />
        <Row title="Delete folder" danger onPress={remove} />
      </Section>
      {renaming && (
        <NameSheet
          title="Rename folder"
          label="Name"
          initial={name}
          placeholder="Contracts"
          action="Save"
          maxLength={120}
          onClose={() => setRenaming(false)}
          onSave={(next) =>
            Effect.gen(function* () {
              const result = yield* data.changing((client) =>
                client.PatchLibraryFolder({ id, patch: { name: next } }),
              )
              // The page was opened under the old name, which travelled with the route.
              if (Result.isSuccess(result)) go.setParams({ name: next })
              return refusalOf(result)
            })
          }
        />
      )}
    </>
  )
}

/**
 * One file: what Vivid read of it, asking about it, opening the original, renaming and deleting.
 * Asking starts a Thread with a sentence about the file and goes there once Vivid has it.
 */
function ItemSheet({
  level,
  item,
  onClose,
  onUndeleted,
}: {
  level: Level
  item: LibraryItem
  onClose: () => void
  /** Told when deleting was refused. This sheet has closed by then, so the level says it. */
  onUndeleted: (message: string) => void
}) {
  const data = useLiveData()
  const openThread = useOpenThread()
  const [renaming, setRenaming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [refused, setRefused] = useState<Option.Option<string>>(Option.none())

  function ask() {
    return start(
      Effect.gen(function* () {
        setBusy(true)
        const outcome = yield* startThread(data, {
          message: `Read “${item.name}” in the Library and tell me what matters in it.`,
          projectId: null,
        })
        setBusy(false)
        if (Start.$is('Started')(outcome)) {
          onClose()
          openThread(outcome.id)
          return
        }
        setRefused(Option.some(outcome.message))
      }),
    )
  }

  function open() {
    return start(
      Effect.gen(function* () {
        setBusy(true)
        const result = yield* data.running(
          openDocument(data.session, `/${item.id}/content`, item.name),
        )
        setBusy(false)
        setRefused(refusalOf(result))
      }),
    )
  }

  /**
   * Deletes the file, which leaves the level at once. If the server refuses, or was never reached,
   * the file is put back, and the level says so: a file that silently reappears reads as a delete
   * that did nothing.
   */
  function discard() {
    return start(
      Effect.gen(function* () {
        const result = yield* data.changing(
          (client) => client.DeleteLibraryItem({ id: item.id }),
          () => level.query.expect(library.itemRemoved(item.id)),
        )
        if (Result.isFailure(result))
          onUndeleted(`“${item.name}” could not be deleted, so it is back in the Library.`)
      }),
    )
  }

  /** Asks first, then leaves the sheet at once; the level shows what came of it. */
  const remove = () =>
    confirmDestructive({
      title: `Delete “${item.name}”?`,
      detail: 'Vivid will no longer be able to read it. This cannot be undone.',
      action: 'Delete file',
      onConfirm: () => {
        warn()
        onClose()
        void discard()
      },
    })

  if (renaming) {
    return (
      <NameSheet
        title="Rename file"
        label="Name"
        initial={item.name}
        placeholder="brief.pdf"
        action="Save"
        maxLength={200}
        onClose={onClose}
        onSave={(name) =>
          data
            .changing(
              (client) => client.PatchLibraryItem({ id: item.id, patch: { name } }),
              () => level.query.expect(library.itemRenamed(item.id, name)),
            )
            .pipe(Effect.map(refusalOf))
        }
      />
    )
  }

  return (
    <Sheet title={item.name} detail={noteOf(item)} onClose={onClose}>
      {item.preview.length > 0 && (
        <Label numberOfLines={8} size="label" tone="ink-2">
          {item.preview}
        </Label>
      )}
      {Option.isSome(refused) && <Notice message={refused.value} />}
      <Button
        kind="primary"
        label={busy ? 'One moment…' : 'Ask Vivid about this'}
        disabled={busy || item.status !== 'ready'}
        onPress={() => void ask()}
      />
      <Button label="Open the original" disabled={busy} onPress={() => void open()} />
      <Section title="This file">
        <Row title="Rename file" onPress={() => setRenaming(true)} />
        <Row title="Delete file" danger onPress={remove} />
      </Section>
    </Sheet>
  )
}
