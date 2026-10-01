import { Schema } from 'effect'
import { placeRing } from './relay'
import {
  beats,
  laptopAssistant,
  phoneCall,
  ringDelayMs,
  teammate,
  workForTurn,
  type Work,
} from './script'
import { VoiceCall } from './voice'

/** The call Vivid places to the teammate once the talk is over. */
export const Ring = Schema.TaggedUnion({
  /** The talk is still going, or never reached the last beat. */
  Pending: {},
  /** The talk ended; the teammate's phone rings after `ringDelayMs`. */
  Scheduled: {},
  /** The server took the ring; the phone rings as soon as it checks in. */
  Sent: {},
  Failed: {},
})
export type Ring = typeof Ring.Type

/** One line of the work log: what Vivid did, shown as it says it. */
export interface Entry {
  readonly id: number
  readonly work: Work
  readonly at: Date
}

/**
 * The laptop side of the demo: the live voice talk, the work Vivid shows in the Thread as it
 * speaks, and the call it then places to the teammate's phone.
 *
 * Vivid's turns are counted, not guessed: Vapi reports each spoken turn, the greeting is turn
 * one, and every turn after it reveals the work belonging to that beat of the script. Created
 * from the Talk button's click, which is the gesture the microphone needs.
 */
export class CallSession {
  readonly voice: VoiceCall
  #ring: Ring = Ring.cases.Pending.make({})
  #log: readonly Entry[] = []
  #turns = 0
  /** Whether the Person spoke since Vivid's last turn; the greeting needs no prompt. */
  #answered = true
  #listeners = new Set<() => void>()

  /** `held` dials ahead of the click and waits for `release`; `live` talks as soon as it joins. */
  constructor(mode: 'live' | 'held') {
    this.voice = new VoiceCall(laptopAssistant, mode, {
      onSpeak: () => this.#turn(),
      // The laptop is filmed by whatever records the screen in the room; only the phone,
      // which has no screen recorder of its own, films itself.
      onVoiceAudio: () => undefined,
      onPersonSaid: () => {
        this.#answered = true
      },
      // Vivid says it is calling the teammate and the call is over: the demo hangs up itself
      // rather than trusting the model to stop, because the phone must ring right after that
      // line and an assistant that keeps talking would leave the Person waiting on nothing.
      onFinishSpeaking: () => {
        if (this.#turns <= beats.length) return
        this.voice.hangUp()
      },
      onEnd: (failure) => this.#end(failure),
    })
  }

  subscribe = (listener: () => void) => {
    this.#listeners.add(listener)
    const unsubscribe = this.voice.subscribe(listener)
    return () => {
      this.#listeners.delete(listener)
      unsubscribe()
    }
  }

  getRing = () => this.#ring

  /** Starts a held session talking; the click that shows the call calls this. */
  release = () => this.voice.release()

  getLog = () => this.#log

  #changed() {
    for (const listener of this.#listeners) listener()
  }

  /**
   * Vivid started speaking. A turn only counts when the Person spoke since the last one, so a
   * reply that pauses mid-way is not mistaken for the next beat. Each counted turn reveals its
   * work and cues the line for the turn after it, which keeps Vivid on the script in order.
   */
  #turn() {
    if (!this.#answered) return
    this.#answered = false
    this.#turns += 1
    const next = beats[this.#turns - 1]
    if (next !== undefined) this.voice.cue(next.line)
    const work = workForTurn(this.#turns)
    if (work.length === 0) return
    const at = new Date()
    this.#log = [
      ...this.#log,
      ...work.map((item, index) => ({ id: this.#log.length + index, work: item, at })),
    ]
    this.#changed()
  }

  /**
   * The talk is over. The teammate is rung only when Vivid got through the whole script and said
   * it was calling them; a call that dropped or was hung up early rings no one.
   */
  #end(failure: string | null) {
    if (failure !== null || this.#turns <= beats.length) return
    this.#ring = Ring.cases.Scheduled.make({})
    this.#changed()
    setTimeout(() => void this.#send(), ringDelayMs)
  }

  async #send() {
    const sent = await placeRing(phoneCall(teammate))
    this.#ring = sent ? Ring.cases.Sent.make({}) : Ring.cases.Failed.make({})
    this.#changed()
  }
}
