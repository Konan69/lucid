import * as Clock from 'effect/Clock'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import { NotFound, ThreadListResponse, ThreadResponse } from '@vivid/contracts'
import { ThreadStore } from './store.ts'

export const threadHandlers = {
  ListThreads: Effect.fn('Rpc.ListThreads')(function* () {
    const store = yield* ThreadStore
    return ThreadListResponse.make({ conversations: yield* store.list() })
  }),
  PutThread: Effect.fn('Rpc.PutThread')(function* ({ id, thread }) {
    const store = yield* ThreadStore
    const now = yield* Clock.currentTimeMillis
    const value = yield* store.put({
      id,
      title: thread.title,
      preview: thread.preview,
      updatedAt: thread.updatedAt ?? now,
      archived: thread.archived ?? false,
    })
    return ThreadResponse.make({ conversation: value })
  }),
  PatchThread: Effect.fn('Rpc.PatchThread')(function* ({ id, patch }) {
    const store = yield* ThreadStore
    const current = yield* store.get(id)
    if (Option.isNone(current))
      return yield* Effect.fail(new NotFound({ message: 'Thread not found' }))
    const now = yield* Clock.currentTimeMillis
    const value = yield* store.put({
      id: current.value.id,
      preview: current.value.preview,
      title: patch.title ?? current.value.title,
      archived: patch.archived ?? current.value.archived,
      updatedAt: now,
    })
    return ThreadResponse.make({ conversation: value })
  }),
  DeleteThread: Effect.fn('Rpc.DeleteThread')(function* ({ id }) {
    const store = yield* ThreadStore
    if (!(yield* store.remove(id)))
      return yield* Effect.fail(new NotFound({ message: 'Thread not found' }))
    return yield* Effect.void
  }),
}
