import { useEffectEvent, useState } from 'react'
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
import { nativeMetrics as m } from '@vivid/design-tokens/native'
import { NotificationListResponse, ThreadListResponse } from '@vivid/contracts'
import { laneConversations } from '../../../web/src/data/conversationLanes'
import { countProjects, projects } from '../../../web/src/data/projects'
import {
  useOpenThread,
  useSidebar,
  useThreadActivity,
  useWorkspace,
  type Routes,
  type ThreadActivity,
} from '../workspace'
import { useResource } from '../lib/resource'
import { type Thread } from '../lib/models'
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
} from '../components/ui'
import { MotionPressable } from '../components/MotionPressable'
import {
  ThreadSwipeable,
  SwipeableScrollGateProvider,
  useSwipeableScrollGate,
} from '../t3/thread-swipe-actions'
import { ControlPillMenu } from '../t3/ControlPillMenu'

const projectByConversation = new Map(
  projects.flatMap((p) => p.conversations.map((title) => [title, p.name] as const)),
)
type SidebarThread = Thread & {
  status: ThreadActivity
  pinned: boolean
  when: 'today' | 'yesterday' | 'week' | 'earlier'
}
type Row = { id: string; thread: SidebarThread } | { id: string; label: string; count?: number }
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

// Vivid web Sidebar's hierarchy and RuntimeRow, with T3's native row interactions.
export function Home({ embedded = false }: { embedded?: boolean }) {
  const { api, preferences, savePreferences } = useWorkspace()
  const sidebar = useSidebar()
  const { activity } = useThreadActivity()
  const { colors: c } = useTheme()
  const navigation = useNavigation<NavigationProp<Routes>>()
  const open = useOpenThread()
  const resource = useResource(api, '/api/conversations', ThreadListResponse)
  const notifications = useResource(api, '/api/notifications', NotificationListResponse)
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
  const unread = new Set(
    notificationData === undefined
      ? []
      : notificationData.notifications.flatMap((notification) =>
          !notification.readAt && notification.conversationId !== null
            ? [notification.conversationId]
            : [],
        ),
  )
  const workingCount = Object.values(activity).filter((s) => s === 'working').length
  const threads: SidebarThread[] = (
    conversationData === undefined ? [] : conversationData.conversations
  )
    .filter((t) => (t.title + ' ' + t.preview).toLowerCase().includes(query.toLowerCase()))
    .map((t) => ({
      ...t,
      when: threadDate(t.updatedAt).when,
      pinned: pinned.includes(t.id),
      status:
        activity[t.id] === 'working'
          ? 'working'
          : settled.includes(t.id)
            ? 'done'
            : (activity[t.id] ?? (unread.has(t.id) ? 'attention' : 'ready')),
    }))
  const active = threads.filter(
    (t) =>
      !t.archived &&
      t.status !== 'done' &&
      (filter === 'All conversations' ||
        (filter === 'Pinned' && t.pinned) ||
        (filter === 'Working' && t.status === 'working') ||
        (filter === 'Needs you' && ['attention', 'approve'].includes(t.status))),
  )
  const done = threads.filter((t) => !t.archived && t.status === 'done')
  const archives = threads.filter((t) => t.archived)
  const rows: Row[] = laneConversations(active).lanes.flatMap((lane) => [
    {
      id: 'lane:' + lane.key,
      label: lane.label,
      count: lane.count ? lane.items.length : undefined,
    },
    ...lane.items.map((thread) => ({ id: thread.id, thread })),
  ])
  type RequestBody = Record<string, string | number | boolean | null>
  async function change(thread: Thread, method: string, body?: RequestBody) {
    try {
      await api.request('/api/conversations/' + thread.id, method, body)
      setSelected(undefined)
      await resource.refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }
  async function toggle(thread: Thread, field: 'pinnedThreads' | 'settledThreads') {
    const ids = preferences[field] ?? []
    try {
      await savePreferences({
        ...preferences,
        [field]: ids.includes(thread.id)
          ? ids.filter((id) => id !== thread.id)
          : [...ids, thread.id],
      })
      setSelected(undefined)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }
  function start() {
    sidebar.close()
    navigation.navigate('Home')
  }
  function action(thread: SidebarThread, name: string) {
    if (name === 'rename') setRename(thread)
    else if (name === 'pin') void toggle(thread, 'pinnedThreads')
    else if (name === 'done') void toggle(thread, 'settledThreads')
    else if (name === 'archive') void change(thread, 'PATCH', { archived: !thread.archived })
    else if (name === 'delete') confirmDelete(thread.title, () => void change(thread, 'DELETE'))
  }
  function actions(thread: SidebarThread) {
    return [
      { id: 'pin', title: thread.pinned ? 'Unpin' : 'Pin' },
      { id: 'done', title: settled.includes(thread.id) ? 'Reopen' : 'Mark done' },
      { id: 'rename', title: 'Rename' },
      { id: 'archive', title: thread.archived ? 'Restore' : 'Archive' },
      { id: 'delete', title: 'Delete', attributes: { destructive: true } },
    ]
  }
  const bg = c[embedded ? 'surface-1' : 'surface-0']
  function renderThread(thread: SidebarThread) {
    const current = sidebar.activeThread === thread.id
    const StatusIcon =
      thread.status === 'working'
        ? CircleDashed
        : thread.status === 'attention'
          ? CircleHelp
          : thread.status === 'failed'
            ? CircleAlert
            : thread.status === 'done'
              ? Check
              : undefined
    const statusColor =
      c[
        thread.status === 'working'
          ? 'status-working'
          : thread.status === 'failed'
            ? 'status-danger'
            : thread.status === 'done'
              ? 'status-success'
              : 'status-attention'
      ]
    const project = projectByConversation.get(thread.title)
    const row = (
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ selected: current }}
        accessibilityLabel={thread.title + (thread.status !== 'ready' ? ', ' + thread.status : '')}
        onPress={() => open(thread.id, thread.title)}
        onLongPress={Platform.OS === 'web' ? () => setSelected(thread) : () => undefined}
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
          <Face
            size={18}
            mood={
              thread.status === 'working'
                ? 'thinking'
                : thread.status === 'done'
                  ? 'asleep'
                  : 'neutral'
            }
          />
          {StatusIcon && <StatusIcon size={13} color={statusColor} strokeWidth={1.6} />}
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
          actions={actions(thread)}
          onPressAction={({ nativeEvent }) => action(thread, nativeEvent.event)}
        >
          {row}
        </ControlPillMenu>
      )
    return (
      <View key={thread.id} style={{ marginBottom: 6 }}>
        {Platform.OS === 'web' ? (
          content
        ) : (
          <ThreadSwipeable
            resetKey={thread.id}
            backgroundColor={bg}
            fullSwipeWidth={width}
            threadTitle={thread.title}
            fullSwipeAction="primary"
            onDelete={() => action(thread, 'delete')}
            primaryAction={{
              icon: thread.archived ? 'arrow.uturn.backward' : 'archivebox',
              label: thread.archived ? 'Restore' : 'Archive',
              accessibilityLabel: thread.archived ? 'Restore conversation' : 'Archive conversation',
              onPress: () => action(thread, 'archive'),
            }}
          >
            {() => content}
          </ThreadSwipeable>
        )}
      </View>
    )
  }
  return (
    <View
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
      style={{ flex: 1, backgroundColor: bg, paddingTop: insets.top }}
    >
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
          onPress={() => {
            setSearching(!searching)
            setQuery('')
          }}
        />
      </View>
      <MotionPressable
        accessibilityRole="button"
        accessibilityLabel="Vivid workspace"
        onPress={start}
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
      {searching ? (
        <View style={{ paddingHorizontal: 12, paddingVertical: 8 }}>
          <Field
            accessibilityLabel="Search conversations"
            placeholder="Search conversations"
            value={query}
            onChangeText={setQuery}
            autoFocus
          />
        </View>
      ) : (
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
      )}
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
          onPress={() => setFilterOpen(true)}
        />
        <ControlPill icon={Plus} accessibilityLabel="New conversation" onPress={start} />
      </View>
      <SwipeableScrollGateProvider enabled={gate.swipeEnabled}>
        <FlatList
          data={rows}
          keyExtractor={(row) => row.id}
          {...gate.scrollGateHandlers}
          scrollEventThrottle={16}
          refreshing={resource.loading}
          onRefresh={resource.refresh}
          keyboardDismissMode="on-drag"
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ paddingHorizontal: 10, paddingBottom: 8 }}
          ListHeaderComponent={
            <Feedback
              error={error || resource.error}
              retry={() => {
                setError('')
                void resource.refresh()
              }}
            />
          }
          ListEmptyComponent={
            !resource.loading && !resource.error ? (
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
            <View>
              <MotionPressable
                accessibilityRole="button"
                accessibilityLabel="Done conversations"
                accessibilityState={{ expanded: doneOpen }}
                onPress={() => setDoneOpen(!doneOpen)}
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
                onPress={() => setArchivedOpen(!archivedOpen)}
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
          }
        />
      </SwipeableScrollGateProvider>
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
          marginBottom: Math.max(insets.bottom, 8),
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
      {filterOpen && (
        <Sheet title="Conversations" onClose={() => setFilterOpen(false)}>
          {['All conversations', 'Needs you', 'Working', 'Pinned'].map((name) => (
            <MotionPressable
              key={name}
              accessibilityRole="button"
              accessibilityState={{ selected: filter === name }}
              onPress={() => {
                setFilter(name)
                setFilterOpen(false)
              }}
              style={{ flexDirection: 'row', alignItems: 'center', minHeight: 48 }}
            >
              <Label style={{ flex: 1 }}>{name}</Label>
              {filter === name && <Check size={18} color={c.accent} />}
            </MotionPressable>
          ))}
        </Sheet>
      )}
      {selected && (
        <Sheet title={selected.title} onClose={() => setSelected(undefined)}>
          {actions(selected).map((item) => (
            <ControlPill
              key={item.id}
              label={item.title}
              danger={item.id === 'delete'}
              onPress={() => {
                action(selected, item.id)
                if (item.id === 'rename') setSelected(undefined)
              }}
            />
          ))}
          <Feedback error={error} />
        </Sheet>
      )}
      {rename && (
        <EditSheet
          title="Rename conversation"
          fields={[{ key: 'title', label: 'Name', value: rename.title }]}
          onClose={() => setRename(undefined)}
          onSave={async (values) => {
            await api.request('/api/conversations/' + rename.id, 'PATCH', values)
            await resource.refresh()
          }}
        />
      )}
    </View>
  )
}
