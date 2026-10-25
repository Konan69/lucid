import { stopThread } from './stop.ts'
import { watchConversation, sendToThread } from './socket.ts'
import { ThreadTitles } from './generation.ts'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Stream from 'effect/Stream'
import {
  Forbidden,
  InvalidRequest,
  type DeliveryScopeRequest,
  ThreadDetail,
  type PersonId,
  type PresenceRequest,
  type ShareThreadRequest,
  type ThreadId,
} from '@vivid/contracts'
import { AuthContext, AuthState } from '@vivid/contracts/auth'
import { ApprovalStore } from '../approvals/store.ts'
import { requireActor, requirePerson, summaryOf, type Actor } from '../auth/access.ts'
import { InputStore } from '../inputs/store.ts'
import { Topic } from '../live/changes.ts'
import { live } from '../live/query.ts'
import { Notifier } from '../notifications/notifier.ts'
import { requireThread } from './access.ts'
import { Presence } from './presence.ts'
import { RunStore } from './runs.ts'
import { LiveLink } from '../rpc/link.ts'
import { ThreadStore, type Shared } from './store.ts'
import { openFirstThread } from './arrival.ts'

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

/**
 * Notify newly named People after the share commits, using only its saved id, title and Company.
 * Notification delivery remains outside the metadata transaction and belongs to the Notifier.
 */
const announceShare = Effect.fn('Threads.announceShare')(function* (
  thread: Pick<Shared['thread'], 'id' | 'title'> & Pick<Shared, 'companyId'>,
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

export const threadHandlers = {
  WatchConversation: watchConversation,
  SendToThread: sendToThread,
  /** First arrival is a signed-in Person's act; scope comes exclusively from authentication. */
  OpenFirstThread: Effect.fn('Rpc.OpenFirstThread')(function* () {
    yield* requirePerson()
    return yield* openFirstThread(yield* requireActor())
  }),
  /** Only the unattributed runtime token may retrieve authority; sessions/devices and acting calls cannot. */
  GetDeliveryScope: Effect.fn('Rpc.GetDeliveryScope')(function* (request: DeliveryScopeRequest) {
    const auth = yield* AuthContext
    if (!AuthState.$is('Runtime')(auth))
      return yield* new Forbidden({ message: 'Only the runtime may read delivery scope' })
    return yield* (yield* RunStore).scope(request)
  }),
  ListThreads: Effect.fn('Rpc.ListThreads')(function* () {
    return yield* listThreads(yield* requireActor())
  }),
  WatchThreads: () => live('WatchThreads', ['activity'], listThreads),
  GetThread: Effect.fn('Rpc.GetThread')(function* ({ id }: { readonly id: ThreadId }) {
    return yield* detail(yield* requireActor(), id)
  }),
  WatchThread: ({ id }: { readonly id: ThreadId }) =>
    live('WatchThread', ['activity'], (actor) => detail(actor, id), [Topic.thread(id)]),
  /** The store commits metadata, creator read receipt and announcement before returning. */
  CreateThread: Effect.fn('Rpc.CreateThread')(function* (
    request: Parameters<ThreadStore['Service']['create']>[1],
  ) {
    // Starting a Thread is a Person's act. Vivid works in the Thread it was spoken to in.
    yield* requirePerson()
    const actor = yield* requireActor()
    const thread = yield* (yield* ThreadStore).create(actor, request)
    return { thread }
  }),
  /** The locked store write owns publication; the saved result needs no late authorization read. */
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
    return { thread }
  }),
  /** Same authority as PatchThread: any Person who may rename this Thread may ask Vivid to name it. */
  RegenerateThreadTitle: Effect.fn('Rpc.RegenerateThreadTitle')(function* ({
    thread,
  }: {
    readonly thread: ThreadId
  }) {
    const actor = yield* requireActor()
    const stored = yield* requireThread(thread, actor.person.id)
    return { title: yield* (yield* ThreadTitles).regenerate(stored, actor.person.id) }
  }),
  /** Sharing and audit commit in the store; newly named People are notified from its saved result. */
  ShareThread: Effect.fn('Rpc.ShareThread')(function* ({
    id,
    audience,
  }: {
    readonly id: ThreadId
    readonly audience: ShareThreadRequest
  }) {
    const auth = yield* requirePerson()
    const shared = yield* (yield* ThreadStore).share(auth.person.id, id, audience)
    // The committed Shared result owns every notification field; no late reread can fail the share.
    yield* announceShare(
      { id: shared.thread.id, title: shared.thread.title, companyId: shared.companyId },
      summaryOf(auth.person).name,
      shared.added,
    )
    return { thread: shared.thread }
  }),
  /** The store captures and announces the deleted audience while holding its Thread lock. */
  DeleteThread: Effect.fn('Rpc.DeleteThread')(function* ({ id }: { readonly id: ThreadId }) {
    const auth = yield* requirePerson()
    yield* (yield* ThreadStore).remove(auth.person.id, id)
  }),
  /** The store announces the Person alongside their read receipt under its key-share lock. */
  MarkThreadRead: Effect.fn('Rpc.MarkThreadRead')(function* ({ id }: { readonly id: ThreadId }) {
    const auth = yield* requirePerson()
    yield* (yield* ThreadStore).markRead(auth.person.id, id)
  }),
  StopThread: Effect.fn('Rpc.StopThread')(function* ({ id }: { readonly id: ThreadId }) {
    const auth = yield* requirePerson()
    yield* requireThread(id, auth.person.id)
    yield* stopThread(auth.person.id, id)
  }),
  /**
   * Presence is the call itself: held for as long as the client keeps it open on its live link
   * (`threads/presence.ts`). Over `/api/rpc` there is no link to hold it on, so it is refused.
   */
  BePresent: (request: PresenceRequest) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const auth = yield* requirePerson()
        yield* requireThread(request.threadId, auth.person.id)
        const link = yield* Effect.serviceOption(LiveLink)
        if (Option.isNone(link))
          return yield* new InvalidRequest({ message: 'Presence is held on the live socket.' })
        yield* (yield* Presence).hold(
          request.threadId,
          summaryOf(auth.person),
          request.typing,
          link.value,
        )
        return Stream.never
      }),
    ),
}
