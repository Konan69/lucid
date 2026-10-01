import { Data, Result } from 'effect'
import type { PhoneCallRequest } from '@vivid/contracts'
import { RingWait } from '@vivid/contracts'
import { film, type Film } from './film'
import { waitForRing } from './relay'
import { phoneAssistant } from './script'
import { VoiceCall, VoicePhase, type VoiceControls } from './voice'

/**
 * The phone side of the demo. The Person opens `/phone` on their phone, taps once so the page
 * may play a ringtone and use the microphone, then the page waits for Vivid's ring. A ring shows
 * an incoming-call screen; answering starts a live Vapi call with Vivid.
 *
 * The page must stay open in the foreground: a browser suspends background tabs, and iOS keeps
 * Web Audio silent while the ring/silent switch is on.
 */
export type PhoneScreen = Data.TaggedEnum<{
  /** Not armed yet: no gesture has unlocked audio and the microphone. */
  Asleep: {}
  /** The browser refused the microphone, so no call could be answered here. */
  /** The microphone was refused; `reason` is what the browser called it, shown to the Person. */
  Blocked: { readonly reason: string }
  Waiting: {}
  Incoming: { readonly call: PhoneCallRequest }
  Talking: { readonly voice: VoiceControls }
}>
/** Constructors and `$match`; a live `VoiceCall` rules out a Schema. */
export const PhoneScreen = Data.taggedEnum<PhoneScreen>()

/** Back-off after the server could not be reached, so a dead link does not spin. */
const retryMs = 2_000

/**
 * A two-tone ring like a landline's: 440 Hz + 480 Hz for 2 s, then 4 s of silence, repeated.
 * Generated with Web Audio so no sound file ships.
 */
class Ringtone {
  #timer: ReturnType<typeof setInterval> | undefined

  constructor(private readonly audio: AudioContext) {}

  start() {
    this.stop()
    const burst = () => {
      const gain = this.audio.createGain()
      gain.gain.value = 0.15
      gain.connect(this.audio.destination)
      for (const frequency of [440, 480]) {
        const tone = this.audio.createOscillator()
        tone.frequency.value = frequency
        tone.connect(gain)
        tone.start()
        tone.stop(this.audio.currentTime + 2)
      }
    }
    burst()
    this.#timer = setInterval(burst, 6_000)
  }

  stop() {
    if (this.#timer !== undefined) clearInterval(this.#timer)
    this.#timer = undefined
  }
}

export class PhoneLine {
  #screen: PhoneScreen = PhoneScreen.Asleep()
  #listeners = new Set<() => void>()
  #ringtone: Ringtone | undefined
  #film: Film | undefined
  /** The call to Vivid, dialled the moment the phone rings so answering is instant. */
  #warm: VoiceCall | undefined

  subscribe = (listener: () => void) => {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  getSnapshot = () => this.#screen

  #show(screen: PhoneScreen) {
    this.#screen = screen
    for (const listener of this.#listeners) listener()
  }

  /**
   * The one tap that makes the phone reachable. Inside this gesture the page unlocks audio for
   * the ringtone, asks for the microphone once so answering does not stop at a prompt, and keeps
   * the screen awake where the browser allows it.
   */
  arm = async () => {
    // The microphone is asked for first, before anything is awaited. Mobile Safari only honours
    // a permission request made directly out of the tap that started it, and an earlier `await`
    // spends that gesture, which is what made the phone answer "try again" on a tap that had in
    // fact allowed nothing yet.
    const microphone = await navigator.mediaDevices
      .getUserMedia({ audio: true })
      .catch((refusal: unknown): string => (refusal instanceof Error ? refusal.name : 'unknown'))
    // Without a microphone there is no call to answer, so say so rather than waiting in silence.
    if (typeof microphone === 'string')
      return this.#show(PhoneScreen.Blocked({ reason: microphone }))
    for (const track of microphone.getTracks()) track.stop()
    const audio = new AudioContext()
    await audio.resume()
    this.#ringtone = new Ringtone(audio)
    // Keeping the screen awake is a nicety, and browsers refuse it in plenty of ordinary
    // situations; a refusal must never stop the phone from being reachable.
    if ('wakeLock' in navigator) await navigator.wakeLock.request('screen').catch(() => undefined)
    this.#show(PhoneScreen.Waiting())
    void this.#listen()
  }

  /** Wait for rings for as long as the phone is waiting; each wait is bounded by the server. */
  async #listen() {
    while (PhoneScreen.$is('Waiting')(this.#screen)) {
      const result = await waitForRing()
      if (Result.isFailure(result)) {
        await new Promise((resolve) => setTimeout(resolve, retryMs))
        continue
      }
      if (RingWait.guards.Ring(result.success)) {
        this.#ringtone?.start()
        navigator.vibrate?.([800, 400, 800])
        this.#show(PhoneScreen.Incoming({ call: result.success.call }))
        // Dial Vivid now, held: the seconds a call takes to join pass while the phone rings,
        // so the moment it is answered Vivid is already on the line.
        this.#warm = this.#dial(result.success.call)
        // Filming starts with the ring, silently, so the whole call — including the phone
        // ringing and being answered — lands in one video on the server.
        void this.#roll()
      }
    }
  }

  /**
   * Films the call as it happens. The scene is read from this line's own state, so the video
   * shows what the phone shows: the orb, the status and the caption being spoken.
   */
  async #roll() {
    this.#film = await film({
      orb: () => document.querySelector('canvas[data-mood]'),
      status: () =>
        PhoneScreen.$match(this.#screen, {
          Asleep: () => '',
          Blocked: () => '',
          Waiting: () => '',
          Incoming: () => 'is calling…',
          Talking: ({ voice }) =>
            VoicePhase.guards.Ended(voice.getSnapshot().phase) ? 'Call ended' : 'On a call',
        }),
      caption: () =>
        PhoneScreen.$match(this.#screen, {
          Asleep: () => '',
          Blocked: () => '',
          Waiting: () => '',
          Incoming: () => '',
          Talking: ({ voice }) => {
            const { live, captions } = voice.getSnapshot()
            return live.length > 0 ? live : (captions.at(-1)?.text ?? '')
          },
        }),
    })
  }

  #dial(call: PhoneCallRequest) {
    return new VoiceCall(phoneAssistant(call), 'held', {
      onSpeak: () => undefined,
      onVoiceAudio: (element) => this.#film?.attachVoice(element),
      onPersonSaid: () => undefined,
      onFinishSpeaking: () => undefined,
      onEnd: () => setTimeout(() => this.#film?.stop(), 1_500),
    })
  }

  /** Answer: stop ringing and release the call already dialled, so Vivid speaks at once. */
  answer = (call: PhoneCallRequest) => {
    this.#ringtone?.stop()
    const voice = this.#warm ?? this.#dial(call)
    this.#warm = undefined
    voice.release()
    this.#show(PhoneScreen.Talking({ voice }))
  }

  /** Decline, or close a finished call: back to waiting for the next ring. */
  idle = () => {
    this.#ringtone?.stop()
    // Declining hangs up the call that was dialled for the ring, so it stops costing minutes.
    this.#warm?.hangUp()
    this.#warm = undefined
    this.#film?.stop()
    this.#film = undefined
    this.#show(PhoneScreen.Waiting())
    void this.#listen()
  }
}
