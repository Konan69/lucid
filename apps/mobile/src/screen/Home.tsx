import { useEffectEvent, useState, type ReactElement } from 'react'
import { FlatList, Platform, Pressable, View } from 'react-native'
import { useFocusEffect, useNavigation, type NavigationProp } from '@react-navigation/native'
import {
  Archive,
  Check,
  ChevronDown,
  ChevronRight,
  FolderKanban,
  Library,
  ListFilter,
  PanelLeft,
  Plus,
  Search,
  Repeat2,
  Pin,
  CircleHelp,
  CircleAlert,
  CircleDashed,
} from 'lucide-react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { nativeMetrics as m } from '@vivid/tokens/native'
import {
  NotificationListResponse,
  ThreadId,
  ThreadListResponse,
  type Notification,
  type Thread,
} from '@vivid/contracts'
import { laneConversations } from '@vivid/state'
import { countProjects, projects } from '../../../web/src/data/projects'
import {
  useOpenThread,
  useSidebar,
  useThreadActivity,
  useWorkspace,
  type Preferences,
  type Routes,
  type ThreadActivity,
} from '../workspace'
import { useResource } from '../data/resource/hook'
import type { Api } from '../data/api'
import { useTheme } from '../theme'
import {
  ControlPill,
  EditSheet,
  Feedback,
  Field,
  Face,
  Label,
  Sheet,
  confirmDelete,
} from '../ui/ui'
import { MotionPressable } from '../ui/motion/Pressable'
import { ThreadSwipeable, SwipeableScrollGateProvider, useSwipeableScrollGate } from '../t3/swipe'
import { ControlPillMenu } from '../t3/Menu'

const projectByConversation = new Map(
  projects.flatMap((p) => p.conversations.map((title) => [title, p.name] as const)),
)
type SidebarThread = Thread & {
  status: ThreadActivity
  pinned: boolean
  when: 'today' | 'yesterday' | 'week' | 'earlier'
}
type Row = { id: string; thread: SidebarThread } | { id: string; label: string; count?: number }
type ThemeColors = ReturnType<typeof useTheme>['colors']
type ThreadAction = (thread: SidebarThread, name: string) => void

/** Keeps the two sidebar snapshots on stable RPC resource keys. */
function useHomeResources(api: Api) {
  const conversations = useResource(
    api,
    'threads',
    api.rpc((client) => client.ListThreads()),
    ThreadListResponse,
  )
  const notifications = useResource(
    api,
    'notifications',
    api.rpc((client) => client.ListNotifications()),
    NotificationListResponse,
  )
  return { conversations, notifications }
}

function threadDate(updatedAt: number) {
  const now = new Date()
  const updated = new Date(updatedAt)
  const days = Math.round(
    (new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() -
      new Date(updated.getFullYear(), updated.getMonth(), updated.getDate()).getTime()) /
      86_400_000,
  )
  return {
    when:
      days <= 0
        ? ('today' as const)
        : days === 1
          ? ('yesterday' as const)
          : days < 7
            ? ('week' as const)
            : ('earlier' as const),
    label:
      days <= 0
        ? updated.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
        : days === 1
          ? 'Yesterday'
          : updated.toLocaleDateString(
              undefined,
              days < 7 ? { weekday: 'short' } : { month: 'short', day: 'numeric' },
            ),
  }
}

/** Builds sidebar thread state without allocating object spreads inside collection transforms. */
function buildSidebarThreads(input: {
  readonly conversations: readonly Thread[]
  readonly query: string
  readonly pinned: readonly string[]
  readonly settled: readonly string[]
  readonly activity: Readonly<Record<string, ThreadActivity>>
  readonly unread: ReadonlySet<string>
}) {
  const threads: SidebarThread[] = []
  const normalizedQuery = input.query.toLowerCase()
  for (const thread of input.conversations) {
    if (!(thread.title + ' ' + thread.preview).toLowerCase().includes(normalizedQuery)) continue
    const status =
      input.activity[thread.id] === 'working'
        ? 'working'
        : input.settled.includes(thread.id)
          ? 'done'
          : (input.activity[thread.id] ?? (input.unread.has(thread.id) ? 'attention' : 'ready'))
    threads.push({
      id: thread.id,
      title: thread.title,
      preview: thread.preview,
      updatedAt: thread.updatedAt,
      archived: thread.archived,
      when: threadDate(thread.updatedAt).when,
      pinned: input.pinned.includes(thread.id),
      status,
    })
  }
  return threads
}

/** Preserves lane header and thread ordering without spread allocation inside map. */
function buildRows(active: SidebarThread[]) {
  const rows: Row[] = []
  for (const lane of laneConversations(active).lanes) {
    rows.push({
      id: 'lane:' + lane.key,
      label: lane.label,
      count: lane.count ? lane.items.length : undefined,
    })
    for (const thread of lane.items) rows.push({ id: thread.id, thread })
  }
  return rows
}

/** Renders the status glyph used by the existing conversation row. */
function renderStatusIcon(status: ThreadActivity, colors: ThemeColors) {
  const color = colors[statusColorKey(status)]
  if (status === 'working') return <CircleDashed size={13} color={color} strokeWidth={1.6} />
  if (status === 'attention') return <CircleHelp size={13} color={color} strokeWidth={1.6} />
  if (status === 'failed') return <CircleAlert size={13} color={color} strokeWidth={1.6} />
  if (status === 'done') return <Check size={13} color={color} strokeWidth={1.6} />
  return null
}

/** Selects the semantic status color without coupling it to row rendering. */
function statusColorKey(status: ThreadActivity): keyof ThemeColors {
  if (status === 'working') return 'status-working'
  if (status === 'failed') return 'status-danger'
  if (status === 'done') return 'status-success'
  return 'status-attention'
}

/** Selects the face mood used for active and settled conversation states. */
function statusMood(status: ThreadActivity) {
  if (status === 'working') return 'thinking' as const
  if (status === 'done') return 'asleep' as const
  return 'neutral' as const
}

/** Builds the existing native and sheet action list for one thread. */
function threadActions(thread: SidebarThread, settled: readonly string[]) {
  return [
    { id: 'pin', title: thread.pinned ? 'Unpin' : 'Pin' },
    { id: 'done', title: settled.includes(thread.id) ? 'Reopen' : 'Mark done' },
    { id: 'rename', title: 'Rename' },
    { id: 'archive', title: thread.archived ? 'Restore' : 'Archive' },
    { id: 'delete', title: 'Delete', attributes: { destructive: true } },
  ]
}

/** Renders one conversation row while the Home screen owns actions and selection. */
function ThreadRow({
  thread,
  activeThread,
  colors: c,
  backgroundColor,
  width,
  open,
  settled,
  onSelect,
  onAction,
}: {
  readonly thread: SidebarThread
  readonly activeThread: string
  readonly colors: ThemeColors
  readonly backgroundColor: string
  readonly width: number
  readonly open: ReturnType<typeof useOpenThread>
  readonly settled: readonly string[]
  readonly onSelect: (thread: SidebarThread) => void
  readonly onAction: ThreadAction
}) {
  const current = activeThread === thread.id
  const project = projectByConversation.get(thread.title)
  const row = (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: current }}
      accessibilityLabel={thread.title + (thread.status !== 'ready' ? ', ' + thread.status : '')}
      onPress={() => open(thread.id, thread.title)}
      onLongPress={Platform.OS === 'web' ? () => onSelect(thread) : () => undefined}
      style={({ pressed }) => ({
        minHeight: m['card-row-h'],
        paddingHorizontal: 12,
        paddingVertical: 10,
        borderRadius: m['radius-card'] * m['phone-radius-factor'],
        borderWidth: 0.5,
        borderColor: current ? c['line-3'] : c['line-1'],
        backgroundColor: pressed ? c['wash-hover'] : c[current ? 'surface-3' : 'surface-2'],
        gap: 3,
      })}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, height: 20 }}>
        <Face size={18} mood={statusMood(thread.status)} />
        {renderStatusIcon(thread.status, c)}
        {thread.pinned && <Pin size={11} color={c['ink-4']} />}
        <View style={{ flex: 1 }} />
        <Label size="micro" tone="ink-4">
          {threadDate(thread.updatedAt).label}
        </Label>
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
        <Label size="footnote" numberOfLines={1} style={{ flex: 1, fontWeight: '500' }}>
          {thread.title}
        </Label>
        {!!project && (
          <Label size="micro" tone="ink-4" numberOfLines={1} style={{ maxWidth: '38%' }}>
            {project}
          </Label>
        )}
      </View>
      {!!thread.preview && (
        <Label size="label" tone="ink-3" numberOfLines={1} style={{ fontWeight: '400' }}>
          {thread.preview}
        </Label>
      )}
    </Pressable>
  )
  const content =
    Platform.OS === 'web' ? (
      row
    ) : (
      <ControlPillMenu
        shouldOpenOnLongPress
        actions={threadActions(thread, settled)}
        onPressAction={({ nativeEvent }) => onAction(thread, nativeEvent.event)}
      >
        {row}
      </ControlPillMenu>
    )
  return (
    <View style={{ marginBottom: 6 }}>
      {Platform.OS === 'web' ? (
        content
      ) : (
        <ThreadSwipeable
          resetKey={thread.id}
          backgroundColor={backgroundColor}
          fullSwipeWidth={width}
          threadTitle={thread.title}
          fullSwipeAction="primary"
          onDelete={() => onAction(thread, 'delete')}
          primaryAction={{
            icon: thread.archived ? 'arrow.uturn.backward' : 'archivebox',
            label: thread.archived ? 'Restore' : 'Archive',
            accessibilityLabel: thread.archived ? 'Restore conversation' : 'Archive conversation',
            onPress: () => onAction(thread, 'archive'),
          }}
        >
          {() => content}
        </ThreadSwipeable>
      )}
    </View>
  )
}

/** Renders sidebar chrome and workspace status above navigation links. */
function HomeHeader({
  colors: c,
  sidebar,
  workingCount,
  onToggleSearch,
  onStart,
}: {
  readonly colors: ThemeColors
  readonly sidebar: ReturnType<typeof useSidebar>
  readonly workingCount: number
  readonly onToggleSearch: () => void
  readonly onStart: () => void
}) {
  return (
    <>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          height: m['topbar-h'],
          paddingHorizontal: 8,
        }}
      >
        <ControlPill icon={PanelLeft} accessibilityLabel="Close sidebar" onPress={sidebar.close} />
        <View style={{ flex: 1 }} />
        <ControlPill
          icon={Search}
          accessibilityLabel="Search conversations"
          onPress={onToggleSearch}
        />
      </View>
      <MotionPressable
        accessibilityRole="button"
        accessibilityLabel="Vivid workspace"
        onPress={onStart}
        style={({ pressed }) => ({
          flexDirection: 'row',
          alignItems: 'center',
          gap: 10,
          minHeight: 44,
          marginHorizontal: 8,
          paddingHorizontal: 10,
          borderRadius: m['radius-row'],
          backgroundColor: pressed ? c['wash-hover'] : 'transparent',
        })}
      >
        <Face size={22} mood={workingCount ? 'thinking' : 'neutral'} />
        <Label size="footnote" style={{ flex: 1 }}>
          Vivid
        </Label>
        {workingCount > 0 && (
          <Label size="micro" style={{ color: c['status-working'] }}>
            {workingCount} working
          </Label>
        )}
        <ChevronRight size={16} color={c['ink-3']} />
      </MotionPressable>
    </>
  )
}

/** Renders either conversation search or the fixed workspace destinations. */
function WorkspaceLinks({
  colors: c,
  sidebar,
  navigation,
  searching,
  query,
  onQueryChange,
}: {
  readonly colors: ThemeColors
  readonly sidebar: ReturnType<typeof useSidebar>
  readonly navigation: NavigationProp<Routes>
  readonly searching: boolean
  readonly query: string
  readonly onQueryChange: (query: string) => void
}) {
  if (searching) {
    return (
      <View style={{ paddingHorizontal: 12, paddingVertical: 8 }}>
        <Field
          accessibilityLabel="Search conversations"
          placeholder="Search conversations"
          value={query}
          onChangeText={onQueryChange}
          autoFocus
        />
      </View>
    )
  }
  return (
    <View style={{ paddingHorizontal: 8 }}>
      {(
        [
          { name: 'Routines', icon: Repeat2 },
          { name: 'Projects', icon: FolderKanban, count: countProjects(projects) },
          { name: 'Library', icon: Library },
        ] as const
      ).map(({ name, icon: Icon, ...rest }) => (
        <MotionPressable
          key={name}
          accessibilityRole="button"
          accessibilityState={{ selected: sidebar.activeRoute === name }}
          onPress={() => {
            sidebar.close()
            navigation.navigate(name)
          }}
          style={({ pressed }) => ({
            flexDirection: 'row',
            alignItems: 'center',
            gap: 10,
            minHeight: 44,
            paddingHorizontal: 10,
            borderRadius: m['radius-row'] * m['phone-radius-factor'],
            backgroundColor: pressed
              ? c['wash-hover']
              : sidebar.activeRoute === name
                ? c['wash-selected']
                : 'transparent',
          })}
        >
          <View style={{ width: 22, alignItems: 'center' }}>
            <Icon pointerEvents="none" size={18} strokeWidth={1.6} color={c['ink-3']} />
          </View>
          <Label size="label" tone="ink-2" style={{ flex: 1 }}>
            {name}
          </Label>
          {'count' in rest && rest.count > 0 && (
            <Label size="micro" tone="ink-4">
              {rest.count}
            </Label>
          )}
        </MotionPressable>
      ))}
    </View>
  )
}

/** Renders the current conversation filter and list actions. */
function ConversationHeader({
  filter,
  onOpenFilter,
  onStart,
}: {
  readonly filter: string
  readonly onOpenFilter: () => void
  readonly onStart: () => void
}) {
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        paddingLeft: 18,
        paddingRight: 8,
        marginTop: 12,
        minHeight: 44,
      }}
    >
      <Label size="label" style={{ flex: 1 }}>
        {filter === 'All conversations' ? 'Conversations' : filter}
      </Label>
      <ControlPill
        icon={ListFilter}
        accessibilityLabel="Filter conversations"
        onPress={onOpenFilter}
      />
      <ControlPill icon={Plus} accessibilityLabel="New conversation" onPress={onStart} />
    </View>
  )
}

/** Renders settled and archived conversation sections below active lanes. */
function ConversationSections({
  colors: c,
  done,
  archives,
  doneOpen,
  archivedOpen,
  onToggleDone,
  onToggleArchived,
  renderThread,
}: {
  readonly colors: ThemeColors
  readonly done: readonly SidebarThread[]
  readonly archives: readonly SidebarThread[]
  readonly doneOpen: boolean
  readonly archivedOpen: boolean
  readonly onToggleDone: () => void
  readonly onToggleArchived: () => void
  readonly renderThread: (thread: SidebarThread) => ReactElement | null
}) {
  return (
    <View>
      <MotionPressable
        accessibilityRole="button"
        accessibilityLabel="Done conversations"
        accessibilityState={{ expanded: doneOpen }}
        onPress={onToggleDone}
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: 8,
          minHeight: 44,
          paddingHorizontal: 10,
        }}
      >
        <Check size={16} color={c['ink-4']} />
        <Label size="label" tone="ink-3" style={{ flex: 1 }}>
          Done
        </Label>
        <Label size="micro" tone="ink-4">
          {done.length}
        </Label>
        {doneOpen ? (
          <ChevronDown size={14} color={c['ink-4']} />
        ) : (
          <ChevronRight size={14} color={c['ink-4']} />
        )}
      </MotionPressable>
      {doneOpen &&
        (done.length ? (
          done.map(renderThread)
        ) : (
          <Label size="label" tone="ink-4" style={{ padding: 10 }}>
            Conversations you've settled. They keep their history.
          </Label>
        ))}
      <MotionPressable
        accessibilityRole="button"
        accessibilityLabel="Archived conversations"
        accessibilityState={{ expanded: archivedOpen }}
        onPress={onToggleArchived}
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: 8,
          minHeight: 44,
          paddingHorizontal: 10,
        }}
      >
        <Archive size={16} color={c['ink-3']} />
        <Label size="label" tone="ink-3" style={{ flex: 1 }}>
          Archived
        </Label>
        <Label size="micro" tone="ink-4">
          {archives.length}
        </Label>
        {archivedOpen ? (
          <ChevronDown size={14} color={c['ink-4']} />
        ) : (
          <ChevronRight size={14} color={c['ink-4']} />
        )}
      </MotionPressable>
      {archivedOpen &&
        (archives.length ? (
          archives.map(renderThread)
        ) : (
          <Label size="label" tone="ink-4" style={{ padding: 10 }}>
            No archived conversations
          </Label>
        ))}
    </View>
  )
}

/** Renders active lanes and the settled/archive footer using the existing scroll gate. */
function ConversationList({
  gate,
  rows,
  loading,
  resourceError,
  error,
  query,
  filter,
  colors,
  done,
  archives,
  doneOpen,
  archivedOpen,
  onRefresh,
  onClearError,
  onToggleDone,
  onToggleArchived,
  renderThread,
}: {
  readonly gate: ReturnType<typeof useSwipeableScrollGate>
  readonly rows: readonly Row[]
  readonly loading: boolean
  readonly resourceError: string
  readonly error: string
  readonly query: string
  readonly filter: string
  readonly colors: ThemeColors
  readonly done: readonly SidebarThread[]
  readonly archives: readonly SidebarThread[]
  readonly doneOpen: boolean
  readonly archivedOpen: boolean
  readonly onRefresh: () => Promise<void>
  readonly onClearError: () => void
  readonly onToggleDone: () => void
  readonly onToggleArchived: () => void
  readonly renderThread: (thread: SidebarThread) => ReactElement | null
}) {
  return (
    <SwipeableScrollGateProvider enabled={gate.swipeEnabled}>
      <FlatList
        data={rows}
        keyExtractor={(row) => row.id}
        {...gate.scrollGateHandlers}
        scrollEventThrottle={16}
        refreshing={loading}
        onRefresh={onRefresh}
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingHorizontal: 10, paddingBottom: 8 }}
        ListHeaderComponent={
          <Feedback
            error={error || resourceError}
            retry={() => {
              onClearError()
              void onRefresh()
            }}
          />
        }
        ListEmptyComponent={
          !loading && !resourceError ? (
            <Label size="label" tone="ink-4" style={{ padding: 12 }}>
              {query || filter !== 'All conversations'
                ? 'No matching conversations'
                : 'Your conversations will appear here.'}
            </Label>
          ) : null
        }
        renderItem={({ item }) =>
          'thread' in item ? (
            renderThread(item.thread)
          ) : (
            <View
              style={{
                minHeight: m['caption-h'],
                paddingHorizontal: 10,
                flexDirection: 'row',
                alignItems: 'center',
                gap: 6,
              }}
            >
              <Label size="micro" tone="ink-3">
                {item.label}
              </Label>
              {item.count !== undefined && (
                <Label size="micro" tone="ink-4">
                  {item.count}
                </Label>
              )}
            </View>
          )
        }
        ListFooterComponent={
          <ConversationSections
            colors={colors}
            done={done}
            archives={archives}
            doneOpen={doneOpen}
            archivedOpen={archivedOpen}
            onToggleDone={onToggleDone}
            onToggleArchived={onToggleArchived}
            renderThread={renderThread}
          />
        }
      />
    </SwipeableScrollGateProvider>
  )
}

/** Renders the personal settings destination at the bottom of the sidebar. */
function PersonalFooter({
  colors: c,
  bottomInset,
  sidebar,
  navigation,
}: {
  readonly colors: ThemeColors
  readonly bottomInset: number
  readonly sidebar: ReturnType<typeof useSidebar>
  readonly navigation: NavigationProp<Routes>
}) {
  return (
    <MotionPressable
      accessibilityRole="button"
      accessibilityLabel="You, Personal. Open settings"
      onPress={() => {
        sidebar.close()
        navigation.navigate('Settings')
      }}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        minHeight: 48,
        marginHorizontal: 8,
        marginBottom: Math.max(bottomInset, 8),
        paddingHorizontal: 10,
        borderRadius: m['radius-row'],
        backgroundColor: pressed ? c['wash-hover'] : 'transparent',
      })}
    >
      <View
        style={{
          width: 26,
          height: 26,
          borderRadius: 13,
          backgroundColor: c['surface-3'],
          borderWidth: 0.5,
          borderColor: c['line-2'],
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Label size="micro">Y</Label>
      </View>
      <Label size="label" tone="ink-2" style={{ flex: 1 }}>
        You
      </Label>
      <Label size="micro" tone="ink-4">
        Personal
      </Label>
    </MotionPressable>
  )
}

/** Renders filter, action, and rename sheets while Home owns their state. */
function HomeSheets({
  colors: c,
  filterOpen,
  filter,
  selected,
  rename,
  settled,
  error,
  api,
  onCloseFilter,
  onFilter,
  onCloseSelected,
  onAction,
  onCloseRename,
  onRenamed,
}: {
  readonly colors: ThemeColors
  readonly filterOpen: boolean
  readonly filter: string
  readonly selected: SidebarThread | null
  readonly rename: Thread | null
  readonly settled: readonly string[]
  readonly error: string
  readonly api: ReturnType<typeof useWorkspace>['api']
  readonly onCloseFilter: () => void
  readonly onFilter: (filter: string) => void
  readonly onCloseSelected: () => void
  readonly onAction: ThreadAction
  readonly onCloseRename: () => void
  readonly onRenamed: () => Promise<void>
}) {
  return (
    <>
      {filterOpen && (
        <Sheet title="Conversations" onClose={onCloseFilter}>
          {['All conversations', 'Needs you', 'Working', 'Pinned'].map((name) => (
            <MotionPressable
              key={name}
              accessibilityRole="button"
              accessibilityState={{ selected: filter === name }}
              onPress={() => onFilter(name)}
              style={{ flexDirection: 'row', alignItems: 'center', minHeight: 48 }}
            >
              <Label style={{ flex: 1 }}>{name}</Label>
              {filter === name && <Check size={18} color={c.accent} />}
            </MotionPressable>
          ))}
        </Sheet>
      )}
      {selected !== null && (
        <Sheet title={selected.title} onClose={onCloseSelected}>
          {threadActions(selected, settled).map((item) => (
            <ControlPill
              key={item.id}
              label={item.title}
              danger={item.id === 'delete'}
              onPress={() => {
                onAction(selected, item.id)
                if (item.id === 'rename') onCloseSelected()
              }}
            />
          ))}
          <Feedback error={error} />
        </Sheet>
      )}
      {rename !== null && (
        <EditSheet
          title="Rename conversation"
          fields={[{ key: 'title', label: 'Name', value: rename.title }]}
          onClose={onCloseRename}
          onSave={async (values) => {
            await api.run(
              api.rpc((client) =>
                client.PatchThread({ id: ThreadId.make(rename.id), patch: values }),
              ),
            )
            await onRenamed()
          }}
        />
      )}
    </>
  )
}

type HomeCollections = {
  readonly workingCount: number
  readonly done: readonly SidebarThread[]
  readonly archives: readonly SidebarThread[]
  readonly rows: readonly Row[]
}

/** Derives sidebar collections from resource, preference, and activity snapshots. */
function deriveHomeCollections(input: {
  readonly conversations: readonly Thread[]
  readonly notifications: readonly Notification[]
  readonly query: string
  readonly filter: string
  readonly pinned: readonly string[]
  readonly settled: readonly string[]
  readonly activity: Readonly<Record<string, ThreadActivity>>
}): HomeCollections {
  const notificationConversationIds = input.notifications.flatMap((notification) =>
    !notification.readAt && notification.conversationId !== null
      ? [notification.conversationId]
      : [],
  )
  const threads = buildSidebarThreads({
    conversations: input.conversations,
    query: input.query,
    pinned: input.pinned,
    settled: input.settled,
    activity: input.activity,
    unread: new Set(notificationConversationIds),
  })
  const active = threads.filter(
    (thread) =>
      !thread.archived &&
      thread.status !== 'done' &&
      (input.filter === 'All conversations' ||
        (input.filter === 'Pinned' && thread.pinned) ||
        (input.filter === 'Working' && thread.status === 'working') ||
        (input.filter === 'Needs you' && ['attention', 'approve'].includes(thread.status))),
  )
  return {
    workingCount: Object.values(input.activity).filter((status) => status === 'working').length,
    done: threads.filter((thread) => !thread.archived && thread.status === 'done'),
    archives: threads.filter((thread) => thread.archived),
    rows: buildRows(active),
  }
}

/** Creates thread mutation callbacks while keeping API and preference failures in Home state. */
function createThreadAction(input: {
  readonly api: ReturnType<typeof useWorkspace>['api']
  readonly preferences: Preferences
  readonly savePreferences: ReturnType<typeof useWorkspace>['savePreferences']
  readonly refresh: () => Promise<void>
  readonly onClearSelection: () => void
  readonly onRename: (thread: Thread) => void
  readonly onError: (message: string) => void
}) {
  const change = async (thread: Thread, action: 'archive' | 'delete') => {
    try {
      await input.api.run(
        input.api.rpc((client) =>
          action === 'delete'
            ? client.DeleteThread({ id: ThreadId.make(thread.id) })
            : client.PatchThread({
                id: ThreadId.make(thread.id),
                patch: { archived: !thread.archived },
              }),
        ),
      )
      input.onClearSelection()
      await input.refresh()
    } catch (cause) {
      input.onError(cause instanceof Error ? cause.message : String(cause))
    }
  }
  const toggle = async (thread: Thread, field: 'pinnedThreads' | 'settledThreads') => {
    const ids = input.preferences[field] ?? []
    try {
      await input.savePreferences({
        ...input.preferences,
        [field]: ids.includes(thread.id)
          ? ids.filter((id) => id !== thread.id)
          : [...ids, thread.id],
      })
      input.onClearSelection()
    } catch (cause) {
      input.onError(cause instanceof Error ? cause.message : String(cause))
    }
  }
  return (thread: SidebarThread, name: string) => {
    if (name === 'rename') input.onRename(thread)
    else if (name === 'pin') void toggle(thread, 'pinnedThreads')
    else if (name === 'done') void toggle(thread, 'settledThreads')
    else if (name === 'archive') void change(thread, 'archive')
    else if (name === 'delete') confirmDelete(thread.title, () => void change(thread, 'delete'))
  }
}

type HomeViewProps = {
  readonly backgroundColor: string
  readonly topInset: number
  readonly bottomInset: number
  readonly onWidth: (width: number) => void
  readonly colors: ThemeColors
  readonly sidebar: ReturnType<typeof useSidebar>
  readonly navigation: NavigationProp<Routes>
  readonly searching: boolean
  readonly workingCount: number
  readonly onToggleSearch: () => void
  readonly onStart: () => void
  readonly query: string
  readonly onQueryChange: (query: string) => void
  readonly filter: string
  readonly onOpenFilter: () => void
  readonly gate: ReturnType<typeof useSwipeableScrollGate>
  readonly collections: HomeCollections
  readonly loading: boolean
  readonly resourceError: string
  readonly error: string
  readonly onRefresh: () => Promise<void>
  readonly onClearError: () => void
  readonly doneOpen: boolean
  readonly archivedOpen: boolean
  readonly onToggleDone: () => void
  readonly onToggleArchived: () => void
  readonly renderThread: (thread: SidebarThread) => ReactElement | null
  readonly filterOpen: boolean
  readonly onCloseFilter: () => void
  readonly onFilter: (filter: string) => void
  readonly selected: SidebarThread | null
  readonly rename: Thread | null
  readonly settled: readonly string[]
  readonly api: ReturnType<typeof useWorkspace>['api']
  readonly onCloseSelected: () => void
  readonly onAction: ThreadAction
  readonly onCloseRename: () => void
  readonly onRenamed: () => Promise<void>
}

/** Composes the complete sidebar from focused render-only sections. */
function HomeView(props: HomeViewProps) {
  return (
    <View
      onLayout={(event) => props.onWidth(event.nativeEvent.layout.width)}
      style={{ flex: 1, backgroundColor: props.backgroundColor, paddingTop: props.topInset }}
    >
      <HomeHeader
        colors={props.colors}
        sidebar={props.sidebar}
        workingCount={props.workingCount}
        onToggleSearch={props.onToggleSearch}
        onStart={props.onStart}
      />
      <WorkspaceLinks
        colors={props.colors}
        sidebar={props.sidebar}
        navigation={props.navigation}
        searching={props.searching}
        query={props.query}
        onQueryChange={props.onQueryChange}
      />
      <ConversationHeader
        filter={props.filter}
        onOpenFilter={props.onOpenFilter}
        onStart={props.onStart}
      />
      <ConversationList
        gate={props.gate}
        rows={props.collections.rows}
        loading={props.loading}
        resourceError={props.resourceError}
        error={props.error}
        query={props.query}
        filter={props.filter}
        colors={props.colors}
        done={props.collections.done}
        archives={props.collections.archives}
        doneOpen={props.doneOpen}
        archivedOpen={props.archivedOpen}
        onRefresh={props.onRefresh}
        onClearError={props.onClearError}
        onToggleDone={props.onToggleDone}
        onToggleArchived={props.onToggleArchived}
        renderThread={props.renderThread}
      />
      <PersonalFooter
        colors={props.colors}
        bottomInset={props.bottomInset}
        sidebar={props.sidebar}
        navigation={props.navigation}
      />
      <HomeSheets
        colors={props.colors}
        filterOpen={props.filterOpen}
        filter={props.filter}
        selected={props.selected}
        rename={props.rename}
        settled={props.settled}
        error={props.error}
        api={props.api}
        onCloseFilter={props.onCloseFilter}
        onFilter={props.onFilter}
        onCloseSelected={props.onCloseSelected}
        onAction={props.onAction}
        onCloseRename={props.onCloseRename}
        onRenamed={props.onRenamed}
      />
    </View>
  )
}

// Vivid web Sidebar's hierarchy and RuntimeRow, with T3's native row interactions.
export function Home({ embedded = false }: { embedded?: boolean }) {
  const { api, preferences, savePreferences } = useWorkspace()
  const sidebar = useSidebar()
  const { activity } = useThreadActivity()
  const { colors: c } = useTheme()
  const navigation = useNavigation<NavigationProp<Routes>>()
  const open = useOpenThread()
  const { conversations: resource, notifications } = useHomeResources(api)
  const conversationData = resource.data
  const notificationData = notifications.data
  // Focus changes trigger the current resource without rebuilding the focus subscription each render.
  const refreshConversations = useEffectEvent(() => {
    void resource.refresh()
  })
  useFocusEffect(refreshConversations)
  const [query, setQuery] = useState('')
  const [archivedOpen, setArchivedOpen] = useState(false)
  const [doneOpen, setDoneOpen] = useState(false)
  const [searching, setSearching] = useState(false)
  const [filter, setFilter] = useState('All conversations')
  const [filterOpen, setFilterOpen] = useState(false)
  const [rename, setRename] = useState<Thread>()
  const [selected, setSelected] = useState<SidebarThread>()
  const [error, setError] = useState('')
  const [width, setWidth] = useState(308)
  const insets = useSafeAreaInsets()
  const gate = useSwipeableScrollGate()
  const pinned = preferences.pinnedThreads ?? []
  const settled = preferences.settledThreads ?? []
  const collections = deriveHomeCollections({
    conversations: conversationData === undefined ? [] : conversationData.conversations,
    notifications: notificationData === undefined ? [] : notificationData.notifications,
    query,
    filter,
    pinned,
    settled,
    activity,
  })
  const action = createThreadAction({
    api,
    preferences,
    savePreferences,
    refresh: resource.refresh,
    onClearSelection: () => setSelected(undefined),
    onRename: setRename,
    onError: setError,
  })
  function start() {
    sidebar.close()
    navigation.navigate('Home')
  }
  const bg = c[embedded ? 'surface-1' : 'surface-0']
  function renderThread(thread: SidebarThread) {
    return (
      <ThreadRow
        key={thread.id}
        thread={thread}
        activeThread={sidebar.activeThread}
        colors={c}
        backgroundColor={bg}
        width={width}
        open={open}
        settled={settled}
        onSelect={setSelected}
        onAction={action}
      />
    )
  }
  return (
    <HomeView
      backgroundColor={bg}
      topInset={insets.top}
      bottomInset={insets.bottom}
      onWidth={setWidth}
      colors={c}
      sidebar={sidebar}
      navigation={navigation}
      searching={searching}
      workingCount={collections.workingCount}
      onToggleSearch={() => {
        setSearching(!searching)
        setQuery('')
      }}
      onStart={start}
      query={query}
      onQueryChange={setQuery}
      filter={filter}
      onOpenFilter={() => setFilterOpen(true)}
      gate={gate}
      collections={collections}
      loading={resource.loading}
      resourceError={resource.error}
      error={error}
      onRefresh={resource.refresh}
      onClearError={() => setError('')}
      doneOpen={doneOpen}
      archivedOpen={archivedOpen}
      onToggleDone={() => setDoneOpen(!doneOpen)}
      onToggleArchived={() => setArchivedOpen(!archivedOpen)}
      renderThread={renderThread}
      filterOpen={filterOpen}
      onCloseFilter={() => setFilterOpen(false)}
      onFilter={(name) => {
        setFilter(name)
        setFilterOpen(false)
      }}
      selected={selected ?? null}
      rename={rename ?? null}
      settled={settled}
      api={api}
      onCloseSelected={() => setSelected(undefined)}
      onAction={action}
      onCloseRename={() => setRename(undefined)}
      onRenamed={resource.refresh}
    />
  )
}
