import type { DraftListResponse, DraftSaved, SaveDraftRequest, ThreadId } from '@vivid/contracts'
import { Effect, Option, Result } from 'effect'
import {
  abandoned,
  heard,
  owed,
  resolved,
  sameWorkspace,
  saved,
  saveOf,
  type DraftScope,
  type Drafts,
  type Owed,
} from './drafts.js'
import { isFinal, type ProductFailure } from './live.js'

/**
 * The timing around the draft model (`drafts.ts`): when a device's unsaved keystrokes are sent,
 * and when what the server holds is laid over the device's copy. Web and phone build one of these
 * each, over their own store and their own socket, so the two cannot drift apart in the rules.
 *
 * It holds no drafts. The device's store is the one copy; this reads it, asks the model what is
 * owed, and writes back what the model says an answer changed.
 */

/**
 * How long a place's words rest before they are saved. Long enough that a sentence being typed is
 * one save, not one per letter; short enough that putting the laptop down and picking the phone
 * up finds the words already there.
 */
const REST = '700 millis'

export interface DraftSyncInput {
  /** The name this installation made up for itself (`SaveDraftRequest.device`). */
  readonly device: string
  /** The device's drafts as they stand, or none while its store has not answered yet. */
  readonly read: () => Option.Option<Drafts>
  /** Changes the device's drafts, from what they are at that moment. */
  readonly update: (change: (drafts: Drafts) => Drafts) => void
  /**
   * Who is signed in and where they are working, once the server itself has said so in this
   * session. It is never what the device kept from its last run: until the server confirms who
   * this is, nothing is sent on their behalf and no list is applied.
   */
  readonly scope: () => Option.Option<DraftScope>
  /** The Threads of where the Person is, once their list has answered (`resolved`). */
  readonly threads: () => Option.Option<ReadonlySet<ThreadId>>
  /** One `SaveDraft` call, its refusal in the value. */
  readonly save: (
    request: SaveDraftRequest,
  ) => Effect.Effect<Result.Result<DraftSaved, ProductFailure>>
  /** Starts a program on the app's runtime and hands back the way to stop it. */
  readonly launch: (program: Effect.Effect<void>) => () => void
}

/** One place's save on its way: the words it carries, and how to call it off. */
interface Underway {
  readonly text: string
  readonly stop: () => void
}

export function makeDraftSync(input: DraftSyncInput) {
  const underway = new Map<string, Underway>()

  /** What the model does with the server's answer to one save made in `scope`. */
  const settle = (
    scope: DraftScope,
    sent: Owed,
    answer: Result.Result<DraftSaved, ProductFailure>,
  ) =>
    Result.match(answer, {
      onSuccess: (outcome) => input.update((drafts) => saved(drafts, scope, sent, outcome)),
      // A save that did not get through is not said while someone types: the words are on the
      // device, and the next change or the next reconnect sends them. Only a refusal that asking
      // again cannot change (the Thread is gone) stops the place owing them.
      onFailure: (failure) => {
        if (isFinal(failure)) input.update((drafts) => abandoned(drafts, sent))
      },
    })

  /**
   * Saves one place once it has rested. There is one save per place at a time, and a newer state
   * of the place replaces it wherever it stands: waiting, or already sent and not yet answered.
   * An answer that is never read costs nothing, because the save that replaced it carries newer
   * words and brings back a newer revision.
   */
  const send = (scope: DraftScope, sent: Owed) => {
    const before = underway.get(sent.where)
    if (before !== undefined) before.stop()
    const mine: Underway = {
      text: sent.text,
      stop: input.launch(
        Effect.sleep(REST).pipe(
          Effect.andThen(input.save(saveOf(sent, input.device))),
          Effect.flatMap((answer) =>
            Effect.sync(() => {
              // Let go of first: settling changes the store, which asks what is owed again.
              if (underway.get(sent.where) === mine) underway.delete(sent.where)
              settle(scope, sent, answer)
            }),
          ),
        ),
      ),
    }
    underway.set(sent.where, mine)
  }

  /**
   * What `WatchDrafts` last said, while it cannot be used yet: the server has not said who is
   * signed in and where, the device's store has not answered, or the list is for a workspace
   * the Person is not in. The last happens around a change of workspace, in either order: the
   * list for the new workspace can arrive before the word that the Person is there, and is then
   * kept until that word comes; the list for the old one can arrive after it, and then waits
   * here, unapplied, until a list for the right workspace replaces it.
   */
  let waiting = Option.none<DraftListResponse>()

  /**
   * Brings the device's copy and the server's together as far as is possible right now: words an
   * earlier build kept find their place, a list that was waiting is laid over the drafts, and
   * every owed place that is not already on its way with the same words is sent.
   */
  const reconcile = () => {
    const scope = input.scope()
    if (Option.isNone(scope) || Option.isNone(input.read())) return
    const threads = input.threads()
    // Only when a waiting draft finds its Thread is anything written. Words kept for a Thread of
    // another workspace, or by another Person on this device, stay waiting; writing the same
    // drafts back for them told the store it had changed, the store called this again, and the
    // page went round until it stopped drawing (a blank Home, live proof of 5 October 2026).
    // `resolved` answers the very drafts it was given when nothing was found.
    if (
      Option.isSome(threads) &&
      Option.exists(
        input.read(),
        (drafts) => resolved(drafts, scope.value, threads.value) !== drafts,
      )
    ) {
      input.update((drafts) => resolved(drafts, scope.value, threads.value))
    }
    const list = Option.filter(waiting, (held) =>
      sameWorkspace(held.workspace, scope.value.workspace),
    )
    if (Option.isSome(list)) {
      waiting = Option.none()
      input.update((drafts) => heard(drafts, scope.value, input.device, list.value))
    }
    for (const place of Option.match(input.read(), {
      onNone: () => [],
      onSome: (drafts) => owed(drafts, scope.value),
    })) {
      const before = underway.get(place.where)
      if (before === undefined || before.text !== place.text) send(scope.value, place)
    }
  }

  return {
    /**
     * Something this depends on changed: the Person typed, an answer was written back, the
     * device's store answered, the Thread list did, or the server said who is signed in and
     * where.
     */
    changed: reconcile,
    /**
     * `WatchDrafts` said what the server holds. It says so again each time the socket comes
     * back, which makes this the reconnect rule as well: places with nothing unsaved take the
     * server's, and every place with unsaved keystrokes is saved, including one whose last save
     * was lost with the old socket.
     */
    heard: (list: DraftListResponse) => {
      waiting = Option.some(list)
      reconcile()
    },
    /** Calls off every save on its way, when the session that would carry them ends. */
    stop: () => {
      for (const save of underway.values()) save.stop()
      underway.clear()
      waiting = Option.none()
    },
  }
}
