import { Option, Schema } from 'effect'
import { useEffect, useState, useSyncExternalStore } from 'react'
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

export default function App() {
  const [view, setView] = useState<View>(() =>
    location.search.includes('tokens')
      ? 'tokens'
      : location.search.includes('empty')
        ? 'empty'
        : location.search.includes('library')
          ? 'library'
          : location.search.includes('projects')
            ? 'projects'
            : location.search.includes('routines')
              ? 'routines'
              : 'conversation',
  )
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
        const parsed = Option.isSome(decoded)
          ? decoded.value.map((thread) => ({ ...thread, archived: false }))
          : []
        if (parsed.length > 0) {
          // Migration is best-effort because the current runtime list remains authoritative. All
          // legacy writes must land before that index can replace the empty runtime response.
          const writes = await Promise.allSettled(parsed.map(saveRuntimeThread))
          if (writes.every((write) => write.status === 'fulfilled')) {
            conversations = parsed.sort((left, right) => right.updatedAt - left.updatedAt)
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
  }, [])

  function createConversation() {
    const thread: RuntimeConversation = {
      id: crypto.randomUUID(),
      title: 'New conversation',
      preview: 'No messages yet',
      updatedAt: Date.now(),
      archived: false,
    }
    setRuntimeThreads((current) => [thread, ...current])
    setActiveId(thread.id)
    setView('conversation')
    setPanel(null)
    void saveRuntimeThread(thread)
  }

  function askAboutLibrary(document: LibraryDocument) {
    const thread: RuntimeConversation = {
      id: crypto.randomUUID(),
      title: `Ask about ${document.name}`.slice(0, 120),
      preview: `Ready to search ${document.name}`,
      updatedAt: Date.now(),
      archived: false,
    }
    setRuntimeThreads((current) => [thread, ...current])
    setConversationDrafts((current) => ({
      ...current,
      [thread.id]: `Search the Library and answer a question about “${document.name}”: `,
    }))
    setActiveId(thread.id)
    setView('conversation')
    setPanel(null)
    void saveRuntimeThread(thread)
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
      [thread, ...current.filter((item) => item.id !== thread.id)].sort(
        (left, right) => right.updatedAt - left.updatedAt,
      ),
    )
    setActiveId(thread.id)
    setView('conversation')
    setPanel(null)
  }

  async function patchRuntimeThread(
    id: string,
    patch: Partial<Pick<RuntimeConversation, 'archived' | 'title'>>,
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
        .sort((left, right) => right.updatedAt - left.updatedAt),
    )
  }

  function renameConversation(id: string, title: string) {
    const current = runtimeThreads.find((thread) => thread.id === id)
    if (!current) return
    const normalized = title.trim()
    if (!normalized || normalized === current.title) return
    void patchRuntimeThread(id, { title: normalized })
  }

  function archiveConversation(id: string, archived: boolean) {
    void patchRuntimeThread(id, { archived })
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

  const activeThread = runtimeThreads.find((thread) => thread.id === activeId)
  const activeTitle = activeThread === undefined ? 'Conversation' : activeThread.title

  return (
    <div className="flex size-full">
      {view !== 'tokens' && (
        <Sidebar
          activeId={view === 'demo' ? activeDemoId : view === 'empty' ? null : activeId}
          runtimeConversations={runtimeThreads}
          onArchive={archiveConversation}
          onDelete={(id) => {
            void removeConversation(id)
          }}
          onRename={renameConversation}
          onSelect={(id) => {
            if (id === 'new') createConversation()
            else if (id === 'library') setView('library')
            else if (id === 'projects') setView('projects')
            else if (id === 'routines') setView('routines')
            else if (id.startsWith('demo:')) {
              setActiveDemoId(id.slice(5))
              setView('demo')
            } else {
              setActiveId(id)
              setView('conversation')
            }
          }}
          onOpenSettings={() => setSettingsOpen(true)}
          workingCount={0}
        />
      )}
      <main className="flex min-w-0 flex-1">
        {view === 'tokens' && <Tokens />}
        {view === 'empty' && <EmptyState />}
        {view === 'library' && <Library onAsk={askAboutLibrary} />}
        {view === 'projects' && <Projects />}
        {view === 'routines' && <Routines onOpenConversation={openRuntimeConversation} />}
        {view === 'demo' && <DemoConversation conversationId={activeDemoId} />}
        {view === 'conversation' &&
          (activeId ? (
            <Conversation
              conversationId={activeId}
              title={activeTitle}
              initialDraft={conversationDrafts[activeId]}
              onMessageSent={(message) => {
                recordMessage(activeId ?? 't1', message)
                setConversationDrafts((current) => {
                  const next = { ...current }
                  delete next[activeId]
                  return next
                })
              }}
              panelOpen={panel !== null}
              onOpenPanel={(k) => setPanel((cur) => (cur === k ? null : k))}
            />
          ) : (
            <div className="flex flex-1 items-center justify-center text-label text-ink-4">
              {threadsReady ? 'Start a new conversation' : 'Loading conversations…'}
            </div>
          ))}
        {view === 'conversation' && panel && (
          <Panel kind={panel} conversationId={activeId} onClose={() => setPanel(null)} />
        )}
      </main>
      {settingsOpen && (
        <Settings
          initialSection={connectorSettingsRequested ? 'connectors' : 'general'}
          theme={theme}
          onThemeChange={setTheme}
          onClose={() => {
            setSettingsOpen(false)
            if (connectorSettingsRequested) history.replaceState(null, '', location.pathname)
          }}
        />
      )}
    </div>
  )
}
