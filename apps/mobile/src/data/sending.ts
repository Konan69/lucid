import type { ThreadId } from '@vivid/contracts'
import { sending, titleFromMessage, type Live } from '@vivid/state'
import { Effect, Layer, Option } from 'effect'
import type { Atom } from 'effect/reactivity'
import { start } from './app'
import { firstKey, type Start } from './first'

/**
 * Sending in a Thread, as the phone does it: the shared machine (`@vivid/state` `sending.ts`),
 * one for each Thread of the session, on the session's socket and in its registry. A Thread's
 * screen draws from the machine's state and sends through `say`; nothing about a delivery is
 * kept in the screen.
 */

/**
 * Subscribe before issuing a command and hear its next publication. Reading the state before
 * that command was processed would mistake the previous attempt's failure for this attempt.
 */
const admission = (
  engine: Live,
  waiting: { readonly state: Atom.Atom<Option.Option<sending.SendingState>>; readonly key: string },
  sends: () => void,
): Promise<sending.Admission> =>
  start(
    Effect.callback<sending.Admission>((resume) => {
      const stop = engine.registry.subscribe(waiting.state, (now) => {
        Option.map(sending.admissionOf(now, waiting.key), (answered) => {
          stop()
          resume(Effect.succeed(answered))
        })
      })
      sends()
      return Effect.sync(stop)
    }),
  )

/** A session's sending owns creation, admission and every queued delivery across screen departure. */
export function makeSending(engine: Live) {
  const machines = sending.makeSending(
    Layer.succeed(sending.Delivering, sending.delivering(engine.run)),
  )
  const stateIn = (thread: ThreadId) => sending.stateOf(machines(thread))
  const firstArrival = (thread: ThreadId, sends: () => void) =>
    admission(engine, { state: stateIn(thread), key: firstKey(thread) }, sends)
  const arrival = (thread: ThreadId, key: string, sends: () => void): Promise<boolean> =>
    admission(engine, { state: stateIn(thread), key }, sends).then((answered) =>
      sending.Admission.match(answered, {
        Accepted: () => true,
        Uncreated: () => false,
        Unanswered: () => false,
      }),
    )

  return {
    stateIn,
    /** First words occupy the queue before creation, including every follow-up from this phone. */
    beginFirst: (
      thread: ThreadId,
      first: Pick<Start, 'words' | 'projectId'>,
    ): Promise<sending.Admission> =>
      firstArrival(thread, () =>
        sending.begin(engine.registry, machines(thread), {
          creation: {
            id: thread,
            title: titleFromMessage(first.words),
            projectId: first.projectId,
          },
          delivery: { thread, key: firstKey(thread), words: first.words, pictures: [] },
        }),
      ),
    /** Explicit retry retains creation identity and all deliveries after a refusal or Stop. */
    againFirst: (thread: ThreadId): Promise<sending.Admission> =>
      firstArrival(thread, () =>
        sending.sendAgain(engine.registry, machines(thread), { seen: { shown: [], ended: [] } }),
      ),
    /**
     * Sends one delivery and answers whether it arrived. Whatever sent the words (a card with a
     * choice on it, a form) closes while they are on their way and needs the answer to know
     * whether to stay closed. Words that did not arrive are kept by the machine, to be sent
     * again as the same delivery.
     *
     * The answer is read from the machine as it moves, never from where it stands at the moment
     * of sending: a delivery sent again stands as not arrived until the machine has taken the
     * new send, and that is the last attempt's ending, not this one's.
     */
    say: (said: Parameters<typeof sending.send>[2]): Promise<boolean> => {
      const { thread, key } = said.delivery
      return arrival(thread, key, () => sending.send(engine.registry, machines(thread), said))
    },
    /**
     * Sends everything that did not arrive in a Thread again, and answers whether the delivery
     * that was under `key` arrived. Every retry keeps its original key and payload.
     */
    again: (
      thread: ThreadId,
      at: { readonly drawn: Pick<sending.Drawing, 'unsent' | 'seen'>; readonly key: string },
    ): Promise<boolean> => {
      return arrival(thread, at.key, () =>
        sending.sendAgain(engine.registry, machines(thread), { seen: at.drawn.seen }),
      )
    },
    /**
     * Tells a Thread's sending that the Person stopped Vivid: nothing that was waiting to be
     * sent from this phone is sent after it (`SendingEvents.Stop`).
     */
    stopped: (thread: ThreadId): void => sending.stopped(engine.registry, machines(thread)),
  }
}

export type Sending = ReturnType<typeof makeSending>
