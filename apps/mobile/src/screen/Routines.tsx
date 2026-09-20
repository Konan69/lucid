import { useState } from 'react'
import { ScrollView, View, RefreshControl } from 'react-native'
import type { NativeStackScreenProps } from '@react-navigation/native-stack'
import { Plus, Pause, Play, Repeat2 } from 'lucide-react-native'
import { RoutineId, RoutineListResponse, type Routine } from '@vivid/contracts'
import { useOpenThread, useWorkspace, type Routes } from '../workspace'
import { useResource } from '../data/resource/hook'
import { when } from '../data/date'
import type { RpcProgram } from '../data/api'
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
} from '../ui/ui'
import { templates } from '../../../web/src/data/routines'

type RoutineApi = ReturnType<typeof useWorkspace>['api']
type RoutineAct = <Value>(
  id: string,
  build: (api: RoutineApi, id: string) => RpcProgram<Value>,
) => Promise<void>

/** Renders routine collection states while the screen owns resource orchestration. */
function RoutineList({
  routines,
  hasData,
  loading,
  resourceError,
  actionError,
  busy,
  onRefresh,
  onOpenGallery,
  onSelect,
  onAct,
}: {
  readonly routines: readonly Routine[]
  readonly hasData: boolean
  readonly loading: boolean
  readonly resourceError: string
  readonly actionError: string
  readonly busy: boolean
  readonly onRefresh: () => Promise<void>
  readonly onOpenGallery: () => void
  readonly onSelect: (id: string) => void
  readonly onAct: RoutineAct
}) {
  return (
    <ScrollView
      refreshControl={<RefreshControl refreshing={loading} onRefresh={onRefresh} />}
      contentContainerStyle={styles.page}
    >
      <Feedback error={actionError || resourceError} retry={onRefresh} />
      <ControlPill icon={Repeat2} label="A little inspiration" onPress={onOpenGallery} />
      {!loading && !resourceError && hasData && routines.length === 0 && (
        <Empty
          title="One less thing to remember."
          detail="A morning brief, a weekly check-in. Tell Vivid what to repeat and when."
        />
      )}
      {routines.map((routine) => (
        <Card key={routine.id}>
          <Label size="headline">{routine.name}</Label>
          <Label size="label" tone="ink-3">
            {routine.enabled ? `Next up ${when(routine.nextRunAt)}` : 'Taking a pause'}
          </Label>
          <Label numberOfLines={3} tone="ink-2">
            {routine.prompt}
          </Label>
          {routine.lastMissedAt && (
            <Label tone="status-danger" size="label">
              Missed a run {when(routine.lastMissedAt)}
            </Label>
          )}
          <View style={styles.wrap}>
            <ControlPill label="View routine" onPress={() => onSelect(routine.id)} />
            <ControlPill
              icon={routine.enabled ? Pause : Play}
              accessibilityLabel={
                routine.enabled ? `Pause ${routine.name}` : `Resume ${routine.name}`
              }
              disabled={busy}
              onPress={() =>
                void onAct(routine.id, (api, id) =>
                  api.rpc((client) =>
                    client.PatchRoutine({
                      id: RoutineId.make(id),
                      patch: { enabled: !routine.enabled },
                    }),
                  ),
                )
              }
            />
          </View>
        </Card>
      ))}
    </ScrollView>
  )
}

/** Renders one routine's controls and run history without owning selection state. */
function RoutineDetail({
  selected,
  error,
  busy,
  onClose,
  onEdit,
  onOpenConversation,
  onAct,
}: {
  readonly selected: Routine
  readonly error: string
  readonly busy: boolean
  readonly onClose: () => void
  readonly onEdit: () => void
  readonly onOpenConversation: (conversationId: string) => void
  readonly onAct: RoutineAct
}) {
  return (
    <Sheet title={selected.name} onClose={onClose}>
      <Feedback error={error} />
      <Label>{selected.prompt}</Label>
      <Label tone="ink-3" size="label">
        {selected.cron} · {selected.timezone}
      </Label>
      <View style={styles.wrap}>
        <ControlPill
          primary
          label="Run now"
          disabled={busy}
          onPress={() =>
            void onAct(selected.id, (api, id) =>
              api.rpc((client) => client.RunRoutine({ id: RoutineId.make(id) })),
            )
          }
        />
        <ControlPill label="Edit routine" onPress={onEdit} />
      </View>
      <Label size="headline">What happened</Label>
      {!selected.runs.length && <Label tone="ink-3">Your first run will appear here.</Label>}
      {selected.runs.map((run) => (
        <Card key={run.id}>
          <Label size="label">
            {when(run.startedAt)} · {run.status}
          </Label>
          {run.output && (
            <Label numberOfLines={6} size="label">
              {run.output}
            </Label>
          )}
          {run.error && (
            <Label tone="status-danger" size="label">
              {run.error}
            </Label>
          )}
          <ControlPill
            label="Open conversation"
            onPress={() => onOpenConversation(run.conversationId)}
          />
          {run.status === 'failed' && (
            <ControlPill
              label="Try again"
              disabled={busy}
              onPress={() =>
                void onAct(selected.id, (api, id) =>
                  api.rpc((client) => client.RunRoutine({ id: RoutineId.make(id) })),
                )
              }
            />
          )}
        </Card>
      ))}
      <ControlPill
        danger
        label="Delete routine"
        disabled={busy}
        onPress={() =>
          confirmDelete(
            selected.name,
            () =>
              void onAct(selected.id, (api, id) =>
                api.rpc((client) => client.DeleteRoutine({ id: RoutineId.make(id) })),
              ),
          )
        }
      />
    </Sheet>
  )
}

/** Renders reusable routine ideas without owning gallery state. */
function RoutineGallery({
  onClose,
  onUseTemplate,
}: {
  readonly onClose: () => void
  readonly onUseTemplate: (name: string, prompt: string) => void
}) {
  return (
    <Sheet title="Make a little room" onClose={onClose}>
      <Label tone="ink-3">
        Ideas to make your own. Availability depends on your connected tools.
      </Label>
      {templates.map((template) => (
        <Card key={template.id}>
          <Label size="headline">{template.name}</Label>
          <Label tone="ink-2">{template.summary}</Label>
          <Label size="label" tone="ink-3">
            {template.trigger}
          </Label>
          <ControlPill
            label="Use as a starting point"
            onPress={() => onUseTemplate(template.name, template.actions.join('. '))}
          />
        </Card>
      ))}
    </Sheet>
  )
}

/** Renders routine fields while the screen retains save and refresh authority. */
function RoutineEditor({
  editing,
  onClose,
  onSave,
}: {
  readonly editing: Partial<Routine>
  readonly onClose: () => void
  readonly onSave: (values: Record<string, string>) => Promise<void>
}) {
  return (
    <EditSheet
      title={editing.id ? 'Edit routine' : 'Give it a rhythm'}
      fields={[
        { key: 'name', label: 'Call it something', value: editing.name },
        {
          key: 'prompt',
          label: 'What should Vivid do?',
          value: editing.prompt,
          multiline: true,
        },
        {
          key: 'cron',
          label: 'When should I check in?',
          value: editing.cron ?? '0 9 * * 1-5',
          options: [
            { label: 'Weekdays at 9', value: '0 9 * * 1-5' },
            { label: 'Every day at 9', value: '0 9 * * *' },
            { label: 'Mondays at 9', value: '0 9 * * 1' },
            { label: 'Every hour', value: '0 * * * *' },
          ],
          allowCustom: true,
        },
        {
          key: 'timezone',
          label: 'Timezone',
          value: editing.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
        },
      ]}
      onClose={onClose}
      onSave={onSave}
    />
  )
}

export function Routines({ navigation }: NativeStackScreenProps<Routes, 'Routines'>) {
  const { api } = useWorkspace()
  const open = useOpenThread()
  const resource = useResource(
    api,
    'routines',
    api.rpc((client) => client.ListRoutines()),
    RoutineListResponse,
  )
  const [selectedId, setSelectedId] = useState<string>()
  const [editing, setEditing] = useState<Partial<Routine>>()
  const [gallery, setGallery] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const data = resource.data
  const selected = data === undefined ? undefined : data.routines.find((r) => r.id === selectedId)
  async function act<Value>(id: string, build: (api: RoutineApi, id: string) => RpcProgram<Value>) {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      await api.run(build(api, id))
      await resource.refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }
  const routines = data === undefined ? [] : data.routines
  return (
    <View style={{ flex: 1 }}>
      <Header
        title="Routines"
        onBack={() => navigation.goBack()}
        trailing={
          <ControlPill
            icon={Plus}
            accessibilityLabel="New routine"
            onPress={() => setEditing({})}
          />
        }
      />
      <RoutineList
        routines={routines}
        hasData={data !== undefined}
        loading={resource.loading}
        resourceError={resource.error}
        actionError={error}
        busy={busy}
        onRefresh={resource.refresh}
        onOpenGallery={() => setGallery(true)}
        onSelect={setSelectedId}
        onAct={act}
      />
      {selected && (
        <RoutineDetail
          selected={selected}
          error={error}
          busy={busy}
          onClose={() => setSelectedId(undefined)}
          onEdit={() => {
            setEditing(selected)
            setSelectedId(undefined)
          }}
          onOpenConversation={(conversationId) => {
            open(conversationId, selected.name)
            setSelectedId(undefined)
          }}
          onAct={act}
        />
      )}
      {gallery && (
        <RoutineGallery
          onClose={() => setGallery(false)}
          onUseTemplate={(name, prompt) => {
            setGallery(false)
            setEditing({ name, prompt })
          }}
        />
      )}
      {editing && (
        <RoutineEditor
          editing={editing}
          onClose={() => setEditing(undefined)}
          onSave={async (values) => {
            await api.run(
              api.rpc((client) =>
                editing.id
                  ? client.PatchRoutine({
                      id: RoutineId.make(editing.id),
                      patch: {
                        name: values.name,
                        prompt: values.prompt,
                        cron: values.cron,
                        timezone: values.timezone,
                      },
                    })
                  : client.CreateRoutine({
                      name: values.name,
                      prompt: values.prompt,
                      cron: values.cron,
                      timezone: values.timezone,
                    }),
              ),
            )
            await resource.refresh()
          }}
        />
      )}
    </View>
  )
}
