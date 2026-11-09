import * as Arr from 'effect/Array'
import * as Clock from 'effect/Clock'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Predicate from 'effect/Predicate'
import * as Result from 'effect/Result'
import {
  AuditEvent,
  Conflict,
  DropOwedRequest,
  Forbidden,
  ForgetChange,
  ForgetDone,
  ForgetRemaining,
  MemoryAuthority,
  MemoryCitation,
  MemoryClosure,
  MemoryForgetId,
  MemoryForgetReceipt,
  MemoryForgetStale,
  MemorySource,
  NotFound,
  ThreadId,
  WatchState,
  type MemoryAddress,
  type MemoryForgetPlan,
  type MemoryRevision,
  type OwedId,
  type PlanMemoryForgetRequest,
  type SavedMemory,
  type WatchId,
  SignalCue,
} from '@vivid/contracts'
import type { Actor } from '../auth/access.ts'
import { Audit } from '../audit/record.ts'
import { OwedStore } from '../owed/store.ts'
import { CellMemory } from '../runtime/client.ts'
import { findThread } from '../threads/access.ts'
import {
  Conversation,
  DeliveryMessage,
  DeliverySpeaker,
  StoredRunOrigin,
} from '../threads/conversation.ts'
import { ThreadStore } from '../threads/store.ts'
import { Watches } from '../watches/lifecycle.ts'
import { WatchStore } from '../watches/store.ts'
import { ForgetState, ForgetStore } from './store.ts'

const addressOf = (change: ForgetChange): MemoryAddress =>
  ForgetChange.match(change, {
    Retract: ({ address }) => address,
    Rewrite: ({ entry }) => ({ layer: entry.layer, file: entry.file }),
  })

/** Only Vivid inside a Run plans and carries out a forget, in that Run's own Thread. */
const runThread = (actor: Actor) =>
  Effect.fromOption(actor.threadId).pipe(
    Effect.mapError(() => new Forbidden({ message: 'Only Vivid in a Run can do this' })),
  )

/** The Threads an entry rests on: the messages it cites and the reply that wrote it. */
const citedThreads = (saved: SavedMemory): ReadonlyArray<ThreadId> =>
  saved.citations.flatMap((citation) =>
    MemoryCitation.match(citation, {
      ThreadMessage: ({ threadId }) => [threadId],
      Run: ({ source }) => (MemorySource.guards.ThreadRun(source) ? [source.threadId] : []),
    }),
  )

/** A Watch the plan names must be this Person's. */
const ownWatch = Effect.fn('Forget.ownWatch')(function* (
  person: Actor['person']['id'],
  id: WatchId,
) {
  const found = yield* (yield* WatchStore).find(id)
  if (!Option.exists(found, (record) => record.personId === person))
    return yield* new NotFound({ message: 'Watch not found' })
})

/**
 * Check Vivid's plan against the acting Person's own records, add what data alone shows, and keep
 * it. Every entry must still be at the revision Vivid read; every Watch and owed record must be
 * this Person's. A cited Thread another Person created holds its learning in their cell, which
 * this forget cannot stop, so it is listed now and reported as remaining later.
 */
export const planForget = Effect.fn('Forget.plan')(function* (
  actor: Actor,
  request: PlanMemoryForgetRequest,
) {
  const threadId = yield* runThread(actor)
  const person = actor.person.id
  const cell = yield* CellMemory
  const read = yield* Effect.forEach(request.changes, (change) =>
    cell.read(person, addressOf(change)),
  )
  if (Arr.zip(read, request.changes).some(([saved, change]) => saved.revision !== change.expected))
    return yield* new Conflict({ message: 'A memory entry changed. Read it again and plan again.' })
  yield* Effect.forEach(request.watches, (id) => ownWatch(person, id))
  const owed = yield* (yield* OwedStore).list(actor)
  if (request.owed.some((id) => !owed.some((record) => record.id === id)))
    return yield* new NotFound({ message: 'Waiting-on record not found' })
  const cited = [...new Set(read.flatMap(citedThreads))]
  const threads = yield* Effect.forEach(cited, findThread)
  const shared = threads.flatMap((thread) =>
    Option.isSome(thread) && thread.value.personId !== person ? [thread.value.id] : [],
  )
  return yield* (yield* ForgetStore).plan({ person, threadId, request, shared })
})

/**
 * Stop one Watch the plan names. An already stopped Watch counts as stopped; one that cannot be
 * found or stopped from this workspace remains.
 */
const stopWatch = Effect.fn('Forget.stopWatch')(function* (actor: Actor, id: WatchId) {
  const found = yield* (yield* WatchStore).find(id)
  if (Option.isNone(found)) return Option.some(ForgetRemaining.cases.Watch.make({ id }))
  if (WatchState.guards.Stopped(found.value.watch.state)) return Option.none()
  const stopped = yield* Effect.result((yield* Watches).stop(actor, found.value.watch.name))
  return Result.isSuccess(stopped)
    ? Option.none()
    : Option.some(ForgetRemaining.cases.Watch.make({ id }))
})

/** Drop one owed record so nothing chases it. One already closed counts as dropped. */
const dropOwed = Effect.fn('Forget.dropOwed')(function* (actor: Actor, id: OwedId) {
  const dropped = yield* Effect.result(
    (yield* OwedStore).drop(
      actor,
      new DropOwedRequest({ id, why: 'The Person asked Vivid to forget what this was about.' }),
    ),
  )
  const closed = Result.match(dropped, {
    onSuccess: () => true,
    onFailure: Predicate.isTagged('Conflict'),
  })
  return closed ? Option.none() : Option.some(ForgetRemaining.cases.Owed.make({ id }))
})

/** Every entry of the plan is still at the revision it was planned at, or the plan is stale. */
const unchanged = Effect.fn('Forget.unchanged')(function* (
  person: Actor['person']['id'],
  plan: MemoryForgetPlan,
) {
  const cell = yield* CellMemory
  const current = yield* Effect.forEach(plan.changes, (change) =>
    Effect.result(cell.read(person, addressOf(change))),
  )
  return Arr.zip(current, plan.changes).every(([read, change]) =>
    Result.match(read, {
      onSuccess: (saved) => saved.revision === change.expected,
      onFailure: () => false,
    }),
  )
})

/**
 * Carry out the newest plan in the Run's Thread, the Person having confirmed it: stop the Watches
 * and owed records first so nothing new acts on the fact, then let the Person's cell stop learning,
 * change the entries and read them back. The receipt is Completed only when nothing remains.
 */
export const carryOut = Effect.fn('Forget.carryOut')(function* (actor: Actor) {
  const threadId = yield* runThread(actor)
  const person = actor.person.id
  const store = yield* ForgetStore
  const planned = yield* store.planned(person, threadId)
  if (Option.isNone(planned))
    return yield* new NotFound({ message: 'There is no forget plan in this conversation.' })
  const plan = planned.value
  if (!(yield* unchanged(person, plan))) return yield* new MemoryForgetStale({ id: plan.id })
  const watches = yield* Effect.forEach(plan.watches, (id) => stopWatch(actor, id))
  const owed = yield* Effect.forEach(plan.owed, (id) => dropOwed(actor, id))
  const closed = yield* (yield* CellMemory).close(
    person,
    MemoryClosure.make({
      changes: plan.changes,
      authority: MemoryAuthority.make({
        actor: person,
        source: MemorySource.cases.Forget.make({ forgetId: plan.id }),
      }),
      writer: threadId,
    }),
  )
  const stuckWatches = watches.flatMap(Option.toArray)
  const stuckOwed = owed.flatMap(Option.toArray)
  const at = yield* Clock.currentTimeMillis
  const receipt = yield* store.close(
    person,
    plan.id,
    ForgetState.cases.Closed.make({
      at,
      done: ForgetDone.make({
        retracted: closed.retracted,
        rewritten: closed.rewritten,
        watches: plan.watches.length - stuckWatches.length,
        owed: plan.owed.length - stuckOwed.length,
        learning: closed.learning,
      }),
      remaining: [
        ...closed.remaining,
        ...stuckWatches,
        ...stuckOwed,
        ...plan.shared.map((id) => ForgetRemaining.cases.SharedLearning.make({ threadId: id })),
      ],
    }),
  )
  yield* (yield* Audit).record(actor, AuditEvent.cases.MemoryForgotten.make({ scope: 'Person' }))
  return receipt
})

/** What Vivid reads in the background Thread a Settings press opens. */
const settingsInstruction = (address: MemoryAddress, expected: MemoryRevision) =>
  [
    'The Person pressed Forget in Settings on one memory entry. That press is their confirmation: do not ask them again, and do not post to the Feed.',
    `The entry: layer ${address.layer}, file ${address.file}, revision ${expected}.`,
    'Read it, then follow the forget-something skill without its question: find every memory with the same meaning, every Watch whose instruction uses it and every waiting-on record about it, call plan_forget, then forget_memory at once. Finish silently.',
  ].join('\n\n')

/**
 * A Settings Forget press. The Person cannot judge meaning from a list of Watches, and the server
 * cannot either, so Vivid plans and carries it out in a background Thread of its own; the
 * receipt is Pending until that Run carries it out (`store.ts` `receipt`).
 */
export const forgetFromSettings = Effect.fn('Forget.fromSettings')(function* (
  actor: Actor,
  address: MemoryAddress,
  expected: MemoryRevision,
) {
  const person = actor.person.id
  const id = MemoryForgetId.make(crypto.randomUUID())
  const threadId = ThreadId.make(`forget-${id}`)
  const thread = yield* (yield* ThreadStore).ensureBackground({
    id: threadId,
    title: 'Forgetting',
    titleSource: 'Assigned',
    personId: person,
    companyId: null,
  })
  yield* (yield* ForgetStore).request({ id, person, threadId: thread.id, address, expected })
  yield* (yield* Conversation).deliver({
    speaker: DeliverySpeaker.cases.Acting.make({}),
    threadId: thread.id,
    personId: person,
    message: DeliveryMessage.cases.Signal.make({
      cue: SignalCue.cases.Forget.make({ body: settingsInstruction(address, expected) }),
    }),
    origin: StoredRunOrigin.cases.Forget.make({}),
    idempotencyKey: `forget:${id}`,
  })
  return MemoryForgetReceipt.cases.Pending.make({ id })
})
