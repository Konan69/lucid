import type { makeLive, LiveQuery } from '@vivid/state'
import * as AsyncResult from 'effect/reactivity/AsyncResult'
import { Text, VStack } from '@expo/ui/swift-ui'
import { font, foregroundStyle, lineLimit, padding } from '@expo/ui/swift-ui/modifiers'
import type { Thread, ThreadListResponse } from '@vivid/contracts'
import { createWidget, type WidgetEnvironment } from 'expo-widgets'
import { Platform } from 'react-native'

interface Snapshot {
  readonly rows: ReadonlyArray<{
    readonly id: string
    readonly title: string
    readonly status: string
  }>
}

/** The extension evaluates this layout separately, so all display logic stays inside it. */
const layout = (props: Snapshot, environment: WidgetEnvironment) => {
  'widget'
  const compact = environment.widgetFamily === 'accessoryRectangular'
  return (
    <VStack
      alignment="leading"
      spacing={compact ? 2 : 8}
      modifiers={[padding({ all: compact ? 0 : 12 })]}
    >
      {compact ? null : <Text modifiers={[font({ size: 15, weight: 'semibold' })]}>Vivid</Text>}
      {props.rows.slice(0, compact ? 1 : 3).map((row) => (
        <VStack key={row.id} alignment="leading" spacing={2}>
          <Text modifiers={[font({ size: 14, weight: 'medium' }), lineLimit(1)]}>{row.title}</Text>
          <Text modifiers={[font({ size: 12 }), foregroundStyle('secondary'), lineLimit(1)]}>
            {row.status}
          </Text>
        </VStack>
      ))}
      {props.rows.length === 0 ? (
        <Text modifiers={[foregroundStyle('secondary')]}>No recent Threads</Text>
      ) : null}
    </VStack>
  )
}

// Android has no target in app.config.ts. Importing the factory there must not create one.
const widget = Platform.OS === 'ios' ? createWidget<Snapshot>('ThreadActivity', layout) : null

/** A live server snapshot supplies real titles and attention; no synthetic progress is shown. */
const updateWidget = (threads: ReadonlyArray<Thread>) => {
  if (widget === null) return
  const statuses = {
    NeedsYou: 'Waiting for you',
    Working: 'Working',
    Unread: 'New activity',
    Quiet: 'Up to date',
  } satisfies Record<Thread['attention'], string>
  widget.updateSnapshot({
    rows: threads
      .filter((thread) => !thread.archived)
      .slice(0, 3)
      .map((thread) => ({
        id: thread.id,
        title: thread.title,
        status: statuses[thread.attention],
      })),
  })
}

/** A signed-out phone must not leave its previous Person's Thread names on the Home Screen. */
const clearWidget = () => {
  if (widget !== null) widget.updateSnapshot({ rows: [] })
}

/** The session owns the query subscription and clears its private snapshot when it ends. */
export const followWidget = (
  engine: ReturnType<typeof makeLive>,
  threads: LiveQuery<ThreadListResponse>,
) => {
  const stop = engine.registry.subscribe(threads.atom, (result) => {
    if (AsyncResult.isSuccess(result)) updateWidget(result.value.threads)
  })
  return () => {
    stop()
    clearWidget()
  }
}
