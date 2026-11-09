import type { Thread, ThreadListResponse } from '@vivid/contracts'
import type { makeLive, LiveQuery } from '@vivid/state'
import { Effect } from 'effect'
import * as AsyncResult from 'effect/reactivity/AsyncResult'
import { awareness } from './awareness'
import { launch } from './app'

const statuses = {
  NeedsYou: 'Waiting for you',
  Working: 'Working',
  Unread: 'New activity',
  Quiet: 'Up to date',
} satisfies Record<Thread['attention'], string>

/** The widget receives only the session's readable Thread projection, never credentials. */
const update = (threads: ReadonlyArray<Thread>) => {
  if (awareness === null) return
  const bridge = awareness
  const snapshot = JSON.stringify({
    rows: threads
      .filter((thread) => !thread.archived)
      .slice(0, 3)
      .map((thread) => ({
        id: thread.id,
        title: thread.title,
        status: statuses[thread.attention],
        updatedAt: thread.updatedAt,
      })),
  })
  launch(
    Effect.tryPromise(() => bridge.updateWidget(snapshot)).pipe(
      Effect.catch(() => Effect.logWarning('Widget snapshot unavailable')),
    ),
  )
}

/** The session owns its subscription and removes private titles when it ends. */
export const followWidget = (
  engine: ReturnType<typeof makeLive>,
  threads: LiveQuery<ThreadListResponse>,
) => {
  const stop = engine.registry.subscribe(threads.atom, (result) => {
    if (AsyncResult.isSuccess(result)) update(result.value.threads)
  })
  return () => {
    stop()
    update([])
  }
}
