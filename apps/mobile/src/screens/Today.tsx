import { useState, useSyncExternalStore } from 'react'
import { ScrollView, View, RefreshControl } from 'react-native'
import type { NativeStackScreenProps } from '@react-navigation/native-stack'
import { Check, Plus, Bell, Circle } from 'lucide-react-native'
import { NotificationListResponse, TaskListResponse } from '@vivid/contracts'
import { useOpenThread, useWorkspace, type Routes } from '../workspace'
import { useResource } from '../lib/resource'
import { useTheme } from '../theme'
import { type Notification, type Task, when } from '../lib/models'
import {
  Card,
  ControlPill,
  EditSheet,
  Empty,
  Feedback,
  Header,
  Label,
  Sheet,
  confirmDelete,
  styles,
} from '../components/ui'

const CURRENT_TIME_REFRESH_MS = 15_000
const currentTimeListeners = new Set<() => void>()
let currentTime = Date.now()
let currentTimeTimer: ReturnType<typeof setInterval> | null = null

/** Keeps overdue groups and follow-up defaults on a stable, periodically refreshed snapshot. */
/**
 * How often a follow-up repeats, in milliseconds; `once` does not repeat, which the wire contract
 * spells `null`. The keys are the form's choices, so the guard and the interval cannot drift.
 */
const REPEAT_EVERY_MS = { once: null, daily: 86_400_000, weekly: 604_800_000 } satisfies Record<
  string,
  number | null
>
const isRepeat = (value: string): value is keyof typeof REPEAT_EVERY_MS =>
  Object.hasOwn(REPEAT_EVERY_MS, value)

function subscribeCurrentTime(listener: () => void) {
  currentTimeListeners.add(listener)
  if (currentTimeTimer === null) {
    const update = () => {
      currentTime = Date.now()
      for (const currentListener of currentTimeListeners) currentListener()
    }
    update()
    currentTimeTimer = setInterval(update, CURRENT_TIME_REFRESH_MS)
  }
  return () => {
    currentTimeListeners.delete(listener)
    if (currentTimeListeners.size === 0 && currentTimeTimer !== null) {
      clearInterval(currentTimeTimer)
      currentTimeTimer = null
    }
  }
}

function getCurrentTime() {
  return currentTime
}

function useCurrentTime() {
  return useSyncExternalStore(subscribeCurrentTime, getCurrentTime, getCurrentTime)
}

/** Shows the task empty state only after the task resource has loaded successfully. */
function shouldShowTaskEmpty(loading: boolean, error: string, visibleCount: number) {
  return !loading && !error && visibleCount === 0
}

type RequestBody = Record<string, string | number | boolean | null | readonly string[]>
type TodayAct = (path: string, method?: string, body?: RequestBody) => Promise<void>
type TaskGroup = { readonly title: string; readonly items: readonly Task[] }
type TodayApi = ReturnType<typeof useWorkspace>['api']

/** Renders unread notifications and preserves their read/open ordering. */
function NotificationsCard({
  notifications,
  unreadCount,
  colors: c,
  busy,
  openThread,
  act,
}: {
  readonly notifications: readonly Notification[]
  readonly unreadCount: number
  readonly colors: ReturnType<typeof useTheme>['colors']
  readonly busy: boolean
  readonly openThread: ReturnType<typeof useOpenThread>
  readonly act: TodayAct
}) {
  if (!unreadCount) return null
  return (
    <Card>
      <View style={styles.row}>
        <Bell size={18} color={c['ink-2']} />
        <Label size="headline" style={{ flex: 1 }}>
          While you were away
        </Label>
      </View>
      {notifications
        .filter((notification) => !notification.readAt)
        .slice(0, 6)
        .map((notification) => {
          const conversationId = notification.conversationId
          return (
            <View key={notification.id} style={{ gap: 8 }}>
              <Label size="footnote">{notification.title}</Label>
              <Label size="label" tone="ink-3">
                {notification.body}
              </Label>
              <View style={styles.wrap}>
                {conversationId && (
                  <ControlPill
                    label="Open conversation"
                    onPress={() => {
                      openThread(conversationId, notification.title)
                      void act('/api/notifications/read', 'POST', { ids: [notification.id] })
                    }}
                  />
                )}
                <ControlPill
                  label="Mark read"
                  disabled={busy}
                  onPress={() =>
                    void act('/api/notifications/read', 'POST', { ids: [notification.id] })
                  }
                />
              </View>
            </View>
          )
        })}
      <ControlPill
        label="Mark all read"
        disabled={busy}
        onPress={() => void act('/api/notifications/read', 'POST', {})}
      />
    </Card>
  )
}

/** Renders grouped task cards without owning task or selection state. */
function TaskGroups({
  groups,
  busy,
  act,
  onSelect,
}: {
  readonly groups: readonly TaskGroup[]
  readonly busy: boolean
  readonly act: TodayAct
  readonly onSelect: (id: string) => void
}) {
  return (
    <>
      {groups
        .filter((group) => group.items.length)
        .map((group) => (
          <View key={group.title} style={{ gap: 12 }}>
            <Label size="label" tone={group.title === 'Overdue' ? 'status-danger' : 'ink-3'}>
              {group.title}
            </Label>
            {group.items.map((task) => (
              <Card key={task.id}>
                <View style={styles.row}>
                  <ControlPill
                    icon={task.status === 'open' ? Circle : Check}
                    accessibilityLabel={
                      task.status === 'open' ? `Complete ${task.title}` : `Reopen ${task.title}`
                    }
                    disabled={busy}
                    onPress={() =>
                      void act(`/api/tasks/${task.id}`, 'PATCH', {
                        status: task.status === 'open' ? 'done' : 'open',
                      })
                    }
                  />
                  <View style={{ flex: 1, gap: 4 }}>
                    <Label>{task.title}</Label>
                    <Label size="label" tone="ink-3">
                      {task.assignee ? `With ${task.assignee} · ` : ''}
                      {when(task.dueAt)}
                    </Label>
                  </View>
                </View>
                {task.nextFollowUpAt && (
                  <Label size="label" tone="ink-3">
                    Vivid follows up {when(task.nextFollowUpAt)}
                  </Label>
                )}
                <ControlPill label="View task" onPress={() => onSelect(task.id)} />
              </Card>
            ))}
          </View>
        ))}
    </>
  )
}

/** Renders task actions and follow-up history while the screen owns mutations. */
function TaskDetailSheet({
  selected,
  error,
  busy,
  openThread,
  act,
  onClose,
  onEdit,
  onFollowUp,
}: {
  readonly selected: Task
  readonly error: string
  readonly busy: boolean
  readonly openThread: ReturnType<typeof useOpenThread>
  readonly act: TodayAct
  readonly onClose: () => void
  readonly onEdit: () => void
  readonly onFollowUp: () => void
}) {
  return (
    <Sheet title={selected.title} onClose={onClose}>
      <Feedback error={error} />
      <Label tone="ink-2">{selected.detail || 'A small thing worth keeping track of.'}</Label>
      <Label size="label" tone="ink-3">
        {selected.priority === 'urgent' ? 'Urgent · ' : ''}
        {when(selected.dueAt)}
      </Label>
      <View style={styles.wrap}>
        <ControlPill label="Edit" onPress={onEdit} />
        <ControlPill
          label="Open conversation"
          onPress={() => {
            openThread(selected.conversationId, selected.title)
            onClose()
          }}
        />
        {selected.status === 'open' && (
          <>
            <ControlPill
              label="Chase now"
              disabled={busy}
              onPress={() => void act(`/api/tasks/${selected.id}/nudge`, 'POST', {})}
            />
            <ControlPill label="Follow up later" onPress={onFollowUp} />
            <ControlPill
              label="Drop task"
              disabled={busy}
              onPress={() => void act(`/api/tasks/${selected.id}`, 'PATCH', { status: 'dropped' })}
            />
          </>
        )}
      </View>
      <Label size="headline">Follow-ups</Label>
      {selected.followUps.length === 0 && <Label tone="ink-3">No nudges scheduled yet.</Label>}
      {selected.followUps.map((followUp) => (
        <Card key={followUp.id}>
          <Label size="label">
            {when(followUp.at)} · {followUp.status}
          </Label>
          <Label tone="ink-3" size="label">
            {followUp.note || 'Check in on this task'}
            {followUp.repeatEveryMs
              ? ` · Repeats every ${followUp.repeatEveryMs / 3_600_000} hours`
              : ''}
          </Label>
          {followUp.output && <Label size="label">{followUp.output}</Label>}
          {followUp.error && (
            <Label tone="status-danger" size="label">
              {followUp.error}
            </Label>
          )}
          <View style={styles.wrap}>
            {followUp.status !== 'running' && followUp.status !== 'cancelled' && (
              <ControlPill
                label="Run now"
                disabled={busy}
                onPress={() => void act(`/api/follow-ups/${followUp.id}/run`)}
              />
            )}
            {followUp.status === 'scheduled' && (
              <ControlPill
                label="Cancel"
                disabled={busy}
                onPress={() =>
                  void act(`/api/follow-ups/${followUp.id}`, 'PATCH', { status: 'cancelled' })
                }
              />
            )}
            {['cancelled', 'failed'].includes(followUp.status) && (
              <ControlPill
                danger
                label="Remove"
                disabled={busy}
                onPress={() => void act(`/api/follow-ups/${followUp.id}`, 'DELETE')}
              />
            )}
          </View>
        </Card>
      ))}
      <ControlPill
        danger
        label="Delete task"
        disabled={busy}
        onPress={() =>
          confirmDelete(selected.title, () => void act(`/api/tasks/${selected.id}`, 'DELETE'))
        }
      />
    </Sheet>
  )
}

/** Renders task fields while the screen retains API and refresh authority. */
function TaskEditor({
  editing,
  api,
  onClose,
  onRefresh,
}: {
  readonly editing: Task | 'new'
  readonly api: TodayApi
  readonly onClose: () => void
  readonly onRefresh: () => Promise<void>
}) {
  return (
    <EditSheet
      title={editing === 'new' ? 'Something to keep an eye on' : 'Edit task'}
      fields={[
        {
          key: 'title',
          label: 'What needs doing?',
          value: editing === 'new' ? '' : editing.title,
        },
        {
          key: 'detail',
          label: 'A little context',
          multiline: true,
          value: editing === 'new' ? '' : editing.detail,
        },
        {
          key: 'assignee',
          label: 'Who is it with?',
          value: editing === 'new' ? '' : (editing.assignee ?? ''),
        },
        {
          key: 'due',
          label: 'Due (optional)',
          date: true,
          value: editing !== 'new' && editing.dueAt ? localDate(editing.dueAt) : '',
        },
        {
          key: 'priority',
          label: 'How pressing is it?',
          value: editing === 'new' ? 'normal' : editing.priority,
          options: [
            { label: 'Normal', value: 'normal' },
            { label: 'Urgent', value: 'urgent' },
          ],
        },
      ]}
      onClose={onClose}
      onSave={async (values) => {
        const dueAt = values.due.trim() ? parseDate(values.due) : null
        await api.request(
          editing === 'new' ? '/api/tasks' : `/api/tasks/${editing.id}`,
          editing === 'new' ? 'POST' : 'PATCH',
          {
            title: values.title,
            detail: values.detail,
            assignee: values.assignee || null,
            dueAt,
            priority: values.priority,
          },
        )
        await onRefresh()
      }}
    />
  )
}

/** Renders follow-up fields while the screen retains API and refresh authority. */
function FollowUpEditor({
  task,
  now,
  api,
  onClose,
  onRefresh,
}: {
  readonly task: Task
  readonly now: number
  readonly api: TodayApi
  readonly onClose: () => void
  readonly onRefresh: () => Promise<void>
}) {
  return (
    <EditSheet
      title="Leave the remembering to Vivid"
      fields={[
        {
          key: 'at',
          label: 'When',
          date: true,
          value: localDate(now + 86_400_000),
        },
        { key: 'note', label: 'What should Vivid check?', multiline: true },
        {
          key: 'repeat',
          label: 'How often?',
          value: 'once',
          options: [
            { label: 'Just once', value: 'once' },
            { label: 'Every day', value: 'daily' },
            { label: 'Every week', value: 'weekly' },
          ],
        },
      ]}
      onClose={onClose}
      onSave={async (values) => {
        const repeat = values.repeat
        if (!isRepeat(repeat)) throw new Error('Choose once, daily, or weekly.')
        await api.request(`/api/tasks/${task.id}/follow-ups`, 'POST', {
          at: parseDate(values.at),
          note: values.note,
          repeatEveryMs: REPEAT_EVERY_MS[repeat],
        })
        await onRefresh()
      }}
    />
  )
}

type TodayViewProps = {
  readonly colors: ReturnType<typeof useTheme>['colors']
  readonly onBack: () => void
  readonly onNewTask: () => void
  readonly loading: boolean
  readonly onRefresh: () => void
  readonly error: string
  readonly notifications: readonly Notification[]
  readonly unreadCount: number
  readonly busy: boolean
  readonly openThread: ReturnType<typeof useOpenThread>
  readonly act: TodayAct
  readonly showDone: boolean
  readonly onToggleDone: () => void
  readonly showEmpty: boolean
  readonly groups: readonly TaskGroup[]
  readonly onSelect: (id: string) => void
  readonly selected: Task | null
  readonly onCloseSelected: () => void
  readonly onEditSelected: () => void
  readonly onFollowUpSelected: () => void
  readonly editing: Task | 'new' | null
  readonly onCloseEditor: () => void
  readonly followUp: Task | null
  readonly onCloseFollowUp: () => void
  readonly now: number
  readonly api: TodayApi
  readonly refreshTasks: () => Promise<void>
}

/** Composes the Today surface from render-only sections and screen-owned callbacks. */
function TodayView(props: TodayViewProps) {
  return (
    <View style={{ flex: 1 }}>
      <Header
        title="Today"
        onBack={props.onBack}
        trailing={
          <ControlPill icon={Plus} accessibilityLabel="Track a task" onPress={props.onNewTask} />
        }
      />
      <ScrollView
        refreshControl={<RefreshControl refreshing={props.loading} onRefresh={props.onRefresh} />}
        contentContainerStyle={styles.page}
      >
        <Feedback error={props.error} retry={props.onRefresh} />
        <NotificationsCard
          notifications={props.notifications}
          unreadCount={props.unreadCount}
          colors={props.colors}
          busy={props.busy}
          openThread={props.openThread}
          act={props.act}
        />
        <View style={styles.wrap}>
          <ControlPill
            label={props.showDone ? 'Show open tasks' : 'Show settled tasks'}
            onPress={props.onToggleDone}
          />
        </View>
        {props.showEmpty && (
          <Empty
            title={props.showDone ? 'A fresh page' : 'A little breathing room.'}
            detail={
              props.showDone
                ? 'Finished tasks will collect here.'
                : 'Tell Vivid what to keep an eye on, or add something yourself.'
            }
          />
        )}
        <TaskGroups
          groups={props.groups}
          busy={props.busy}
          act={props.act}
          onSelect={props.onSelect}
        />
      </ScrollView>
      {props.selected !== null && (
        <TaskDetailSheet
          selected={props.selected}
          error={props.error}
          busy={props.busy}
          openThread={props.openThread}
          act={props.act}
          onClose={props.onCloseSelected}
          onEdit={props.onEditSelected}
          onFollowUp={props.onFollowUpSelected}
        />
      )}
      {props.editing !== null && (
        <TaskEditor
          editing={props.editing}
          api={props.api}
          onClose={props.onCloseEditor}
          onRefresh={props.refreshTasks}
        />
      )}
      {props.followUp !== null && (
        <FollowUpEditor
          task={props.followUp}
          now={props.now}
          api={props.api}
          onClose={props.onCloseFollowUp}
          onRefresh={props.refreshTasks}
        />
      )}
    </View>
  )
}

export function Today({ navigation }: NativeStackScreenProps<Routes, 'Today'>) {
  const { api } = useWorkspace()
  const { colors: c } = useTheme()
  const openThread = useOpenThread()
  const tasks = useResource(api, '/api/tasks', TaskListResponse)
  const notifications = useResource(api, '/api/notifications', NotificationListResponse)
  const [selectedId, setSelectedId] = useState<string>()
  const [editing, setEditing] = useState<Task | 'new'>()
  const [followUp, setFollowUp] = useState<Task>()
  const [showDone, setShowDone] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const now = useCurrentTime()
  const tasksData = tasks.data
  const notificationsData = notifications.data
  const selected =
    tasksData === undefined ? undefined : tasksData.tasks.find((t) => t.id === selectedId)
  async function act(path: string, method = 'POST', body?: RequestBody) {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      await api.request(path, method, body)
      await Promise.all([tasks.refresh(), notifications.refresh()])
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }
  const visible =
    tasksData === undefined
      ? []
      : tasksData.tasks.filter((t) => (showDone ? t.status !== 'open' : t.status === 'open'))
  const groups = [
    {
      title: 'Overdue',
      items: visible.filter((t) => t.status === 'open' && t.dueAt !== null && t.dueAt < now),
    },
    {
      title: showDone ? 'Settled' : 'On your plate',
      items: visible.filter((t) => t.status !== 'open' || t.dueAt === null || t.dueAt >= now),
    },
  ]
  const refresh = () => {
    void tasks.refresh()
    void notifications.refresh()
  }
  const notificationItems = notificationsData === undefined ? [] : notificationsData.notifications
  return (
    <TodayView
      colors={c}
      onBack={() => navigation.goBack()}
      onNewTask={() => setEditing('new')}
      loading={tasks.loading}
      onRefresh={refresh}
      error={error || tasks.error || notifications.error}
      notifications={notificationItems}
      unreadCount={notificationsData === undefined ? 0 : notificationsData.unreadCount}
      busy={busy}
      openThread={openThread}
      act={act}
      showDone={showDone}
      onToggleDone={() => setShowDone(!showDone)}
      showEmpty={shouldShowTaskEmpty(tasks.loading, tasks.error, visible.length)}
      groups={groups}
      onSelect={setSelectedId}
      selected={selected ?? null}
      onCloseSelected={() => setSelectedId(undefined)}
      onEditSelected={() => {
        if (selected === undefined) return
        setEditing(selected)
        setSelectedId(undefined)
      }}
      onFollowUpSelected={() => {
        if (selected === undefined) return
        setFollowUp(selected)
        setSelectedId(undefined)
      }}
      editing={editing ?? null}
      onCloseEditor={() => setEditing(undefined)}
      followUp={followUp ?? null}
      onCloseFollowUp={() => setFollowUp(undefined)}
      now={now}
      api={api}
      refreshTasks={tasks.refresh}
    />
  )
}
export function localDate(value: number) {
  const d = new Date(value)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
export function parseDate(value: string) {
  const timestamp = new Date(value.trim().replace(' ', 'T')).getTime()
  if (!Number.isFinite(timestamp)) throw new Error('Use a date and time like 2026-09-15 09:00.')
  return timestamp
}
