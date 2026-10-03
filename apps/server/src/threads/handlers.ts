import * as Effect from 'effect/Effect'
import {
  AuditEvent,
  Forbidden,
  type DeliveryScopeRequest,
  ThreadDetail,
  type PersonId,
  type PresenceRequest,
  type ShareThreadRequest,
  type ThreadId,
} from '@vivid/contracts'
import { AuthContext, AuthState } from '@vivid/contracts/auth'
import { ApprovalStore } from '../approvals/store.ts'
import { Audit } from '../audit/record.ts'
import { requireActor, requirePerson, summaryOf, type Actor } from '../auth/access.ts'
import { InputStore } from '../inputs/store.ts'
import { changed, Changes, Topic } from '../live/changes.ts'
import { live } from '../live/query.ts'
import { Notifier } from '../notifications/notifier.ts'
import { Runtime } from '../runtime/client.ts'
import { audienceTopics, requireThread, type StoredThread } from './access.ts'
import { Presence } from './presence.ts'
import { RunStore } from './runs.ts'
import { ThreadStore } from './store.ts'

/**
 * Everything beside the conversation that draws one Thread. The conversation itself is Flue's
 * stream, read through the gateway; this is who is in it, who Vivid acted for in each Run, what is
 * waiting on someone, and who is looking at it now.
 */
const detail = Effect.fn('Threads.detail')(function* (actor: Actor, id: ThreadId) {
  const stored = yield* requireThread(id, actor.person.id)
  return ThreadDetail.make({
    thread: yield* (yield* ThreadStore).view(stored, actor.person.id),
    runs: yield* (yield* RunStore).list(id),
    present: yield* (yield* Presence).here(id),
    approvals: yield* (yield* ApprovalStore).inThread(id),
    requests: yield* (yield* InputStore).inThread(id),
  })
})

const listThreads = Effect.fn('Threads.list')(function* (actor: Actor) {
  return { threads: yield* (yield* ThreadStore).list(actor) }
})

/** The words the audit record uses for an audience. It names the reach, never the People. */
const audienceName = (audience: ShareThreadRequest) =>
  ({ Private: 'only its creator', People: 'named people', Company: 'the whole Company' })[
    audience._tag
  ]

/** Tells the People a Thread was just shared with that it now exists for them. */
const announceShare = Effect.fn('Threads.announceShare')(function* (
  thread: StoredThread,
  sharer: string,
  added: ReadonlyArray<PersonId>,
) {
  const notifier = yield* Notifier
  yield* Effect.forEach(
    added,
    (personId) =>
      notifier.notify({
        personId,
        companyId: thread.companyId,
        kind: 'shared',
        title: thread.title,
        body: `${sharer} shared a Thread with you.`,
        threadId: thread.id,
      }),
    { discard: true },
  )
})

/** Tells everyone who can see a Thread, and anyone who just stopped being able to, that it moved. */
const announce = Effect.fn('Threads.announce')(function* (
  thread: StoredThread,
  also: ReadonlyArray<PersonId>,
) {
  const people = yield* (yield* ThreadStore).participants(thread.id)
  yield* (yield* Changes).publish([...audienceTopics(thread, people), ...also.map(Topic.person)])
})

export const threadHandlers = {
  /** Only the unattributed runtime token may retrieve authority; sessions/devices and acting calls cannot. */
  GetDeliveryScope: Effect.fn('Rpc.GetDeliveryScope')(function* (request: DeliveryScopeRequest) {
    const auth = yield* AuthContext
    if (!AuthState.$is('Runtime')(auth))
      return yield* Effect.fail(
        new Forbidden({ message: 'Only the runtime may read delivery scope' }),
      )
    return yield* (yield* RunStore).scope(request)
  }),
  ListThreads: Effect.fn('Rpc.ListThreads')(function* () {
    return yield* listThreads(yield* requireActor())
  }),
  WatchThreads: () => live(listThreads),
  GetThread: Effect.fn('Rpc.GetThread')(function* ({ id }: { readonly id: ThreadId }) {
    return yield* detail(yield* requireActor(), id)
  }),
  WatchThread: ({ id }: { readonly id: ThreadId }) =>
    live((actor) => detail(actor, id), [Topic.thread(id)]),
  CreateThread: Effect.fn('Rpc.CreateThread')(function* (
    request: Parameters<ThreadStore['Service']['create']>[1],
  ) {
    // Starting a Thread is a Person's act. Vivid works in the Thread it was spoken to in.
    const auth = yield* requirePerson()
    const actor = yield* requireActor()
    const thread = yield* (yield* ThreadStore).create(actor, request)
    yield* changed(auth)
    return { thread }
  }),
  PatchThread: Effect.fn('Rpc.PatchThread')(function* ({
    id,
    patch,
  }: {
    readonly id: ThreadId
    readonly patch: Parameters<ThreadStore['Service']['patch']>[2]
  }) {
    const actor = yield* requireActor()
    const store = yield* ThreadStore
    const thread = yield* store.patch(actor.person.id, id, patch)
    yield* announce(yield* requireThread(id, actor.person.id), [])
    return { thread }
  }),
  ShareThread: Effect.fn('Rpc.ShareThread')(function* ({
    id,
    audience,
  }: {
    readonly id: ThreadId
    readonly audience: ShareThreadRequest
  }) {
    const auth = yield* requirePerson()
    const actor = yield* requireActor()
    const shared = yield* (yield* ThreadStore).share(auth.person.id, id, audience)
    const stored = yield* requireThread(id, auth.person.id)
    yield* (yield* Audit).record(
      actor,
      AuditEvent.cases.ThreadShared.make({
        title: stored.title,
        audience: audienceName(audience),
      }),
    )
    yield* announceShare(stored, summaryOf(auth.person).name, shared.added)
    // People who lost the Thread are no longer in its audience, so they are named here.
    yield* announce(stored, shared.removed)
    return { thread: shared.thread }
  }),
  DeleteThread: Effect.fn('Rpc.DeleteThread')(function* ({ id }: { readonly id: ThreadId }) {
    const auth = yield* requirePerson()
    const store = yield* ThreadStore
    const people = yield* store.participants(id)
    const removed = yield* store.remove(auth.person.id, id)
    yield* (yield* Changes).publish(audienceTopics(removed, people))
  }),
  MarkThreadRead: Effect.fn('Rpc.MarkThreadRead')(function* ({ id }: { readonly id: ThreadId }) {
    const auth = yield* requirePerson()
    yield* (yield* ThreadStore).markRead(auth.person.id, id)
    yield* (yield* Changes).publish([Topic.person(auth.person.id)])
  }),
  StopThread: Effect.fn('Rpc.StopThread')(function* ({ id }: { readonly id: ThreadId }) {
    const auth = yield* requirePerson()
    yield* requireThread(id, auth.person.id)
    yield* (yield* Runtime).stop(id)
  }),
  ReportPresence: Effect.fn('Rpc.ReportPresence')(function* (request: PresenceRequest) {
    const auth = yield* requirePerson()
    yield* requireThread(request.threadId, auth.person.id)
    const moved = yield* (yield* Presence).report(
      request.threadId,
      summaryOf(auth.person),
      request.typing,
    )
    if (moved) yield* (yield* Changes).publish([Topic.thread(request.threadId)])
  }),
}
