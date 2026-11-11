import type { MeResponse, ThreadId, ThreadListResponse } from '@vivid/contracts'
import { sending, type Live, type LiveResult } from '@vivid/state'
import { Effect, Layer, Option, Semaphore } from 'effect'
import type { Atom } from 'effect/reactivity'
import { launch, start } from './app'
import { keepFile, recallFile } from './storage'
import { recording } from './telemetry'

/**
 * Sending in a Thread, as the phone does it: the shared machine (`@vivid/state` `sending.ts`),
 * one for each Thread of the session, on the session's socket and in its registry. A Thread's
 * screen draws from the machine's state and sends through `say`; nothing about a delivery is
 * kept in the screen.
 *
 * A Thread's first words are not sent through it: the first screen makes the Thread and says
 * them (`data/first.ts`), and nothing more can be said in the Thread until they are with Vivid.
 */

/**
 * Whether the delivery under `key` arrived, heard from the machine as it moves.
 *
 * It subscribes before the command is said and hears the command's own outcome: the state at
 * the moment of sending can still be the last attempt's ending, when the same words are sent
 * again under the same key.
 */
const arrival = (
  engine: Live,
  waiting: { readonly state: Atom.Atom<Option.Option<sending.SendingState>>; readonly key: string },
  sends: () => void,
): Promise<boolean> =>
  start(
    Effect.callback<boolean>((resume) => {
      const stop = engine.registry.subscribe(waiting.state, (now) => {
        Option.map(sending.arrivalOf(now, waiting.key), (arrived) => {
          stop()
          resume(Effect.succeed(arrived))
        })
      })
      sends()
      return Effect.sync(stop)
    }),
  )

// A file, as drafts are (`drafts.ts`): unsent words can run to pages.
const FILE = 'unsent.json'

/**
 * What this phone kept of every Thread's unsent words (`sending.Kept`). A store that will not
 * open kept none.
 */
const recalled = recallFile(FILE).pipe(
  Effect.catchTag('StorageUnavailable', () => Effect.succeed(Option.none<string>())),
  Effect.map(sending.readKept),
)

/**
 * One change to the file at a time, each read when its turn comes: a write handed to the native
 * side is answered later, and one begun earlier must not land over a newer one.
 */
const file = Semaphore.makeUnsafe(1)

/**
 * One change to the kept unsent words, in the file's turn and read from it when that turn comes,
 * so a change asked for earlier never lands over a newer one. A store that refuses leaves the
 * words in the machines for this run only.
 */
const changeUnsent = (revise: (held: sending.Kept) => sending.Kept) =>
  Semaphore.withPermit(
    file,
    Effect.gen(function* () {
      const next = revise(yield* recalled)
      const text = sending.writeKept(next)
      if (Option.isSome(text)) yield* keepFile(FILE, text.value)
      return next
    }).pipe(Effect.catchTag('StorageUnavailable', () => Effect.succeed<sending.Kept>({}))),
  )

/** The session's own answers that say who is signed in, where, and that workspace's Threads. */
interface WhereaboutsSources {
  readonly me: Atom.Atom<LiveResult<MeResponse>>
  readonly threads: Atom.Atom<LiveResult<ThreadListResponse>>
}

/** A session's sending: every Thread's machine, which outlives the screen that sent. */
export function makeSending(engine: Live, server: WhereaboutsSources) {
  const transport = sending.delivering(engine.run, recording)
  const machines = sending.makeSending(Layer.succeed(sending.Delivering, transport), {
    registry: engine.registry,
    whereabouts: sending.whereaboutsOf(server.me, server.threads),
    change: changeUnsent,
    launch,
  })
  const stateIn = (thread: ThreadId) => sending.stateOf(machines(thread))

  return {
    stateIn,
    /**
     * Hands one delivery to the server the way every Thread's machine does, outside a machine:
     * a Thread's first words, which are said before its screen keeps one (`data/first.ts`). It
     * asks again once, says why it did not arrive (`sending.Unarrival`) and records what the
     * Person saw fail, as a machine's send does.
     */
    deliver: transport.send,
    /**
     * Sends one delivery and answers whether it arrived. Whatever sent the words (a card with a
     * choice on it, a form) closes while they are on their way and needs the answer to know
     * whether to stay closed. Words that did not arrive are kept by the machine, to be sent
     * again as the same delivery.
     */
    say: (said: Parameters<typeof sending.send>[2]): Promise<boolean> => {
      const { thread, key } = said.delivery
      return arrival(engine, { state: stateIn(thread), key }, () =>
        sending.send(engine.registry, machines(thread), said),
      )
    },
    /**
     * Sends everything that did not arrive in a Thread again, and answers whether the delivery
     * that was under `key` arrived. Every one keeps its key and what it carried.
     */
    again: (
      thread: ThreadId,
      at: { readonly seen: sending.Seen; readonly key: string },
    ): Promise<boolean> =>
      arrival(engine, { state: stateIn(thread), key: at.key }, () =>
        sending.sendAgain(engine.registry, machines(thread), { seen: at.seen }),
      ),
    /**
     * Tells a Thread's sending that the Person stopped Vivid: nothing that was waiting to be
     * sent from this phone is sent after it (`SendingEvents.Stop`).
     */
    stopped: (thread: ThreadId): void => sending.stopped(engine.registry, machines(thread)),
  }
}
