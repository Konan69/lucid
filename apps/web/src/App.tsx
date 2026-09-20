/// <reference lib="es2023.array" />

import { Option, Schema } from 'effect'
import {
  useEffect,
  useState,
  useSyncExternalStore,
  type Dispatch,
  type SetStateAction,
} from 'react'
import { EmptyState } from './screen/EmptyState'
import { Library, type LibraryDocument } from './screen/Library'
import { Routines } from './screen/Routines'
import { Projects } from './screen/Projects'
import { Panel } from './screen/Panel'
import { Sidebar } from './screen/Sidebar'
import { Settings, type ThemePreference } from './screen/Settings'
import { Conversation, DemoConversation } from './screen/Conversation'
import { Tokens } from './screen/Tokens'
import {
  plainPreview,
  titleFromMessage,
  type RuntimeConversation,
} from './data/runtimeConversations'

type View = 'conversation' | 'demo' | 'empty' | 'tokens' | 'library' | 'projects' | 'routines'

/**
 * Which sidebar row is highlighted. The demo view highlights its own fixture, the empty view
 * highlights nothing, and every other view keeps the open conversation highlighted.
 */
function sidebarSelection(input: {
  view: View
  activeDemoId: string
  activeId: string | null
}): string | null {
  if (input.view === 'demo') return input.activeDemoId
  return input.view === 'empty' ? null : input.activeId
}

const RuntimeConversationSchema = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  preview: Schema.String,
  updatedAt: Schema.Number,
  archived: Schema.Boolean,
})
const RuntimeConversationListSchema = Schema.Struct({
  conversations: Schema.Array(RuntimeConversationSchema),
})
const RuntimeConversationListJsonSchema = Schema.fromJsonString(RuntimeConversationListSchema)
const LegacyRuntimeConversationSchema = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  preview: Schema.String,
  updatedAt: Schema.Number,
})
const LegacyRuntimeConversationListSchema = Schema.Array(LegacyRuntimeConversationSchema)
const LegacyRuntimeConversationListJsonSchema = Schema.fromJsonString(
  LegacyRuntimeConversationListSchema,
)
const RuntimeConversationResponseSchema = Schema.Struct({ conversation: RuntimeConversationSchema })
const RuntimeConversationResponseJsonSchema = Schema.fromJsonString(
  RuntimeConversationResponseSchema,
)
const decodeRuntimeConversationList = Schema.decodeUnknownSync(RuntimeConversationListJsonSchema)
const decodeLegacyRuntimeConversationList = Schema.decodeUnknownOption(
  LegacyRuntimeConversationListJsonSchema,
)
const decodeRuntimeConversationResponse = Schema.decodeUnknownSync(
  RuntimeConversationResponseJsonSchema,
)

/** Returns the first non-archived conversation without weakening the missing-state contract. */
function firstActiveConversationId(conversations: readonly RuntimeConversation[]): string | null {
  const conversation = conversations.find((thread) => !thread.archived)
  return conversation === undefined ? null : conversation.id
}

function subscribeToSystemTheme(onChange: () => void) {
  const query = window.matchMedia('(prefers-color-scheme: dark)')
  query.addEventListener('change', onChange)
  return () => query.removeEventListener('change', onChange)
}

function getSystemTheme(): 'dark' | 'light' {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

function initialTheme(): ThemePreference {
  const saved = localStorage.getItem('vivid-theme')
  return saved === 'light' || saved === 'dark' || saved === 'system' ? saved : 'system'
}

async function saveRuntimeThread(thread: RuntimeConversation) {
  const response = await fetch(`/api/conversations/${encodeURIComponent(thread.id)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(thread),
  })
  if (!response.ok) throw new Error(`Could not save conversation (${response.status})`)
}

/** Preserves the original query-fragment precedence while keeping routing out of the component. */
function initialView(search: string): View {
  if (search.includes('tokens')) return 'tokens'
  if (search.includes('empty')) return 'empty'
  if (search.includes('library')) return 'library'
  if (search.includes('projects')) return 'projects'
  if (search.includes('routines')) return 'routines'
  return 'conversation'
}

/** Rebuilds the legacy record explicitly so migration does not rely on per-item object spreading. */
function activeLegacyConversation(
  thread: typeof LegacyRuntimeConversationSchema.Type,
): RuntimeConversation {
  return {
    id: thread.id,
    title: thread.title,
    preview: thread.preview,
    updatedAt: thread.updatedAt,
    archived: false,
  }
}

/** Hydrates runtime conversations once and ignores a response after the application unmounts. */
function useRuntimeThreadHydration(
  setRuntimeThreads: Dispatch<SetStateAction<RuntimeConversation[]>>,
  setActiveId: Dispatch<SetStateAction<string | null>>,
  setThreadsReady: Dispatch<SetStateAction<boolean>>,
) {
  useEffect(() => {
    let cancelled = false

    async function loadThreads() {
      const response = await fetch('/api/conversations')
      if (!response.ok) throw new Error(`Could not load conversations (${response.status})`)
      const payload = await response.text()
      const body = decodeRuntimeConversationList(payload)
      let conversations: RuntimeConversation[] = [...body.conversations]

      if (conversations.length === 0) {
        const legacy = localStorage.getItem('vivid-runtime-conversations')
        const decoded =
          legacy === null ? Option.some([]) : decodeLegacyRuntimeConversationList(legacy)
        const parsed = Option.isSome(decoded) ? decoded.value.map(activeLegacyConversation) : []
        if (parsed.length > 0) {
          // Migration is best-effort because the current runtime list remains authoritative. All
          // legacy writes must land before that index can replace the empty runtime response.
          const writes = await Promise.allSettled(parsed.map(saveRuntimeThread))
          if (writes.every((write) => write.status === 'fulfilled')) {
            conversations = parsed.toSorted((left, right) => right.updatedAt - left.updatedAt)
          }
        }
      }

      localStorage.removeItem('vivid-runtime-conversations')
      if (!cancelled) {
        setRuntimeThreads(conversations)
        setActiveId((current) => current ?? firstActiveConversationId(conversations))
        setThreadsReady(true)
      }
    }

    void loadThreads().catch(() => {
      if (!cancelled) setThreadsReady(true)
    })
    return () => {
      cancelled = true
    }
  }, [setActiveId, setRuntimeThreads, setThreadsReady])
}

/** Creates the shared runtime record shape for both blank and Library-started conversations. */
function makeRuntimeConversation(title: string, preview: string): RuntimeConversation {
  return {
    id: crypto.randomUUID(),
    title,
    preview,
    updatedAt: Date.now(),
    archived: false,
  }
}

/** Applies a server-authoritative conversation patch and restores recency ordering. */
async function patchRuntimeThread(
  id: string,
  patch: Partial<Pick<RuntimeConversation, 'archived' | 'title'>>,
  setRuntimeThreads: Dispatch<SetStateAction<RuntimeConversation[]>>,
) {
  const response = await fetch(`/api/conversations/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  })
  if (!response.ok) throw new Error(`Could not update conversation (${response.status})`)
  const payload = await response.text()
  const { conversation } = decodeRuntimeConversationResponse(payload)
  setRuntimeThreads((current) =>
    current
      .map((thread) => (thread.id === id ? conversation : thread))
      .toSorted((left, right) => right.updatedAt - left.updatedAt),
  )
}

/** Owns conversation mutations so the application component only coordinates stable UI state. */
function createAppActions({
  runtimeThreads,
  activeId,
  setRuntimeThreads,
  setConversationDrafts,
  setActiveId,
  setView,
  setPanel,
}: {
  runtimeThreads: RuntimeConversation[]
  activeId: string | null
  setRuntimeThreads: Dispatch<SetStateAction<RuntimeConversation[]>>
  setConversationDrafts: Dispatch<SetStateAction<Record<string, string>>>
  setActiveId: Dispatch<SetStateAction<string | null>>
  setView: Dispatch<SetStateAction<View>>
  setPanel: Dispatch<SetStateAction<'screen' | 'log' | null>>
}) {
  function activateConversation(thread: RuntimeConversation) {
    setRuntimeThreads((current) => [thread, ...current])
    setActiveId(thread.id)
    setView('conversation')
    setPanel(null)
    void saveRuntimeThread(thread)
  }

  function createConversation() {
    activateConversation(makeRuntimeConversation('New conversation', 'No messages yet'))
  }

  function askAboutLibrary(document: LibraryDocument) {
    const thread = makeRuntimeConversation(
      `Ask about ${document.name}`.slice(0, 120),
      `Ready to search ${document.name}`,
    )
    setConversationDrafts((current) => ({
      ...current,
      [thread.id]: `Search the Library and answer a question about “${document.name}”: `,
    }))
    activateConversation(thread)
  }

  function recordMessage(id: string, message: string) {
    const current = runtimeThreads.find((thread) => thread.id === id)
    if (!current) return
    const changed = {
      ...current,
      title: current.title === 'New conversation' ? titleFromMessage(message) : current.title,
      preview: plainPreview(message),
      updatedAt: Date.now(),
    }
    setRuntimeThreads((threads) => [changed, ...threads.filter((thread) => thread.id !== id)])
    void saveRuntimeThread(changed)
  }

  function openRuntimeConversation(thread: RuntimeConversation) {
    setRuntimeThreads((current) =>
      [thread, ...current.filter((item) => item.id !== thread.id)].toSorted(
        (left, right) => right.updatedAt - left.updatedAt,
      ),
    )
    setActiveId(thread.id)
    setView('conversation')
    setPanel(null)
  }

  function renameConversation(id: string, title: string) {
    const current = runtimeThreads.find((thread) => thread.id === id)
    if (!current) return
    const normalized = title.trim()
    if (!normalized || normalized === current.title) return
    void patchRuntimeThread(id, { title: normalized }, setRuntimeThreads)
  }

  function archiveConversation(id: string, archived: boolean) {
    void patchRuntimeThread(id, { archived }, setRuntimeThreads)
    if (archived && activeId === id) {
      setActiveId(firstActiveConversationId(runtimeThreads.filter((thread) => thread.id !== id)))
    }
  }

  async function removeConversation(id: string) {
    const current = runtimeThreads.find((thread) => thread.id === id)
    if (!current || !window.confirm(`Delete “${current.title}”?`)) return
    const response = await fetch(`/api/conversations/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    })
    if (!response.ok) return
    const remaining = runtimeThreads.filter((thread) => thread.id !== id)
    setRuntimeThreads(remaining)
    if (activeId === id) setActiveId(firstActiveConversationId(remaining))
  }

  return {
    archiveConversation,
    askAboutLibrary,
    createConversation,
    openRuntimeConversation,
    recordMessage,
    removeConversation,
    renameConversation,
  }
}

export default function App() {
  const [view, setView] = useState<View>(() => initialView(location.search))
  const [runtimeThreads, setRuntimeThreads] = useState<RuntimeConversation[]>([])
  const [conversationDrafts, setConversationDrafts] = useState<Record<string, string>>({})
  const [activeId, setActiveId] = useState<string | null>(null)
  const [threadsReady, setThreadsReady] = useState(false)
  const [activeDemoId, setActiveDemoId] = useState('t5')
  const [panel, setPanel] = useState<'screen' | 'log' | null>(null)
  const connectorSettingsRequested =
    new URLSearchParams(location.search).has('connectors') ||
    new URLSearchParams(location.search).get('settings') === 'connectors'
  const [settingsOpen, setSettingsOpen] = useState(connectorSettingsRequested)
  const [theme, setTheme] = useState<ThemePreference>(initialTheme)
  const systemTheme = useSyncExternalStore(subscribeToSystemTheme, getSystemTheme, () => 'light')
  const resolvedTheme = theme === 'system' ? systemTheme : theme

  useEffect(() => {
    document.documentElement.dataset.theme = resolvedTheme
    localStorage.setItem('vivid-theme', theme)
  }, [resolvedTheme, theme])

  useRuntimeThreadHydration(setRuntimeThreads, setActiveId, setThreadsReady)

  const actions = createAppActions({
    runtimeThreads,
    activeId,
    setRuntimeThreads,
    setConversationDrafts,
    setActiveId,
    setView,
    setPanel,
  })

  const activeThread = runtimeThreads.find((thread) => thread.id === activeId)
  const activeTitle = activeThread === undefined ? 'Conversation' : activeThread.title

  return (
    <div className="flex size-full">
      <AppSidebar
        view={view}
        activeId={activeId}
        activeDemoId={activeDemoId}
        runtimeThreads={runtimeThreads}
        onArchive={actions.archiveConversation}
        onDelete={actions.removeConversation}
        onRename={actions.renameConversation}
        onCreate={actions.createConversation}
        onView={setView}
        onActiveId={setActiveId}
        onActiveDemoId={setActiveDemoId}
        onOpenSettings={() => setSettingsOpen(true)}
      />
      <AppWorkspace
        view={view}
        activeId={activeId}
        activeTitle={activeTitle}
        activeDemoId={activeDemoId}
        runtimeDrafts={conversationDrafts}
        threadsReady={threadsReady}
        panel={panel}
        onAskAboutLibrary={actions.askAboutLibrary}
        onOpenRuntimeConversation={actions.openRuntimeConversation}
        onRecordMessage={actions.recordMessage}
        onDraftsChange={setConversationDrafts}
        onPanelChange={setPanel}
      />
      <AppSettings
        open={settingsOpen}
        connectorSettingsRequested={connectorSettingsRequested}
        theme={theme}
        onThemeChange={setTheme}
        onClose={() => setSettingsOpen(false)}
      />
    </div>
  )
}

/** Keeps sidebar routing decisions separate from the application state and workspace rendering. */
function AppSidebar({
  view,
  activeId,
  activeDemoId,
  runtimeThreads,
  onArchive,
  onDelete,
  onRename,
  onCreate,
  onView,
  onActiveId,
  onActiveDemoId,
  onOpenSettings,
}: {
  view: View
  activeId: string | null
  activeDemoId: string
  runtimeThreads: RuntimeConversation[]
  onArchive: (id: string, archived: boolean) => void
  onDelete: (id: string) => Promise<void>
  onRename: (id: string, title: string) => void
  onCreate: () => void
  onView: Dispatch<SetStateAction<View>>
  onActiveId: Dispatch<SetStateAction<string | null>>
  onActiveDemoId: Dispatch<SetStateAction<string>>
  onOpenSettings: () => void
}) {
  if (view === 'tokens') return null
  const sidebarActiveId = sidebarSelection({ view, activeDemoId, activeId })

  function select(id: string) {
    if (id === 'new') onCreate()
    else if (id === 'library') onView('library')
    else if (id === 'projects') onView('projects')
    else if (id === 'routines') onView('routines')
    else if (id.startsWith('demo:')) {
      onActiveDemoId(id.slice(5))
      onView('demo')
    } else {
      onActiveId(id)
      onView('conversation')
    }
  }

  return (
    <Sidebar
      activeId={sidebarActiveId}
      runtimeConversations={runtimeThreads}
      onArchive={onArchive}
      onDelete={(id) => {
        void onDelete(id)
      }}
      onRename={onRename}
      onSelect={select}
      onOpenSettings={onOpenSettings}
      workingCount={0}
    />
  )
}

/** Renders the selected workspace without making the root component own screen branches. */
function AppWorkspace({
  view,
  activeId,
  activeTitle,
  activeDemoId,
  runtimeDrafts,
  threadsReady,
  panel,
  onAskAboutLibrary,
  onOpenRuntimeConversation,
  onRecordMessage,
  onDraftsChange,
  onPanelChange,
}: {
  view: View
  activeId: string | null
  activeTitle: string
  activeDemoId: string
  runtimeDrafts: Record<string, string>
  threadsReady: boolean
  panel: 'screen' | 'log' | null
  onAskAboutLibrary: (document: LibraryDocument) => void
  onOpenRuntimeConversation: (thread: RuntimeConversation) => void
  onRecordMessage: (id: string, message: string) => void
  onDraftsChange: Dispatch<SetStateAction<Record<string, string>>>
  onPanelChange: Dispatch<SetStateAction<'screen' | 'log' | null>>
}) {
  return (
    <main className="flex min-w-0 flex-1">
      {view === 'tokens' && <Tokens />}
      {view === 'empty' && <EmptyState />}
      {view === 'library' && <Library onAsk={onAskAboutLibrary} />}
      {view === 'projects' && <Projects />}
      {view === 'routines' && <Routines onOpenConversation={onOpenRuntimeConversation} />}
      {view === 'demo' && <DemoConversation conversationId={activeDemoId} />}
      {view === 'conversation' &&
        (activeId ? (
          <Conversation
            conversationId={activeId}
            title={activeTitle}
            initialDraft={runtimeDrafts[activeId]}
            onMessageSent={(message) => {
              onRecordMessage(activeId ?? 't1', message)
              onDraftsChange((current) => {
                const next = { ...current }
                delete next[activeId]
                return next
              })
            }}
            panelOpen={panel !== null}
            onOpenPanel={(k) => onPanelChange((cur) => (cur === k ? null : k))}
          />
        ) : (
          <div className="flex flex-1 items-center justify-center text-label text-ink-4">
            {threadsReady ? 'Start a new conversation' : 'Loading conversations…'}
          </div>
        ))}
      {view === 'conversation' && panel && (
        <Panel kind={panel} conversationId={activeId} onClose={() => onPanelChange(null)} />
      )}
    </main>
  )
}

/** Owns the settings overlay's URL cleanup while preserving its conditional mount behavior. */
function AppSettings({
  open,
  connectorSettingsRequested,
  theme,
  onThemeChange,
  onClose,
}: {
  open: boolean
  connectorSettingsRequested: boolean
  theme: ThemePreference
  onThemeChange: Dispatch<SetStateAction<ThemePreference>>
  onClose: () => void
}) {
  if (!open) return null
  return (
    <Settings
      initialSection={connectorSettingsRequested ? 'connectors' : 'general'}
      theme={theme}
      onThemeChange={onThemeChange}
      onClose={() => {
        onClose()
        if (connectorSettingsRequested) history.replaceState(null, '', location.pathname)
      }}
    />
  )
}
