import VapiImport from '@vapi-ai/web'
import { Option, Schema } from 'effect'

/**
 * A live voice conversation with Vivid over Vapi's browser SDK. Audio goes browser-to-Vapi over
 * WebRTC; Vapi runs the transcriber, the model and Vivid's voice. The class is an external store
 * so screens render snapshots through `useSyncExternalStore` and no React effect owns the call.
 * Source: https://docs.vapi.ai/quickstart/web
 */

/**
 * `@vapi-ai/web` is CommonJS (`exports.default = Vapi`). Depending on how a bundler applies
 * interop, the default import is either the class or the module record holding it, so the class
 * is taken from whichever arrived. Without this the dev server throws "Vapi is not a constructor".
 */
const Vapi =
  typeof VapiImport === 'function'
    ? VapiImport
    : (VapiImport as { readonly default: typeof VapiImport }).default

/** Vapi's publishable browser key. It can start web calls only, never read or change the account. */
const publicKey = Schema.decodeUnknownSync(Schema.String.check(Schema.isNonEmpty()))(
  import.meta.env.VITE_VAPI_PUBLIC_KEY,
)

/** The part of Daily's call object this module reaches for; see `#plainMicrophone`. */
interface DailyInput {
  readonly updateInputSettings: (settings: {
    readonly audio: { readonly processor: { readonly type: 'none' } }
  }) => Promise<unknown> | undefined
}

/** The assistant a call runs with: an inline, per-call definition rather than a saved one. */
export type Assistant = Exclude<Parameters<InstanceType<typeof Vapi>['start']>[0], string | undefined>

/** Who is talking, before, during and after the call. */
export const VoicePhase = Schema.TaggedUnion({
  Connecting: {},
  Speaking: {},
  Listening: {},
  /** A call that ended normally has no failure; one Vapi refused carries what it said. */
  Ended: { failure: Schema.NullOr(Schema.String) },
})
export type VoicePhase = typeof VoicePhase.Type

/** One finished caption line. */
export interface Caption {
  readonly speaker: 'Vivid' | 'Person'
  readonly text: string
}

export interface VoiceSnapshot {
  readonly phase: VoicePhase
  readonly captions: readonly Caption[]
  /** The line being spoken right now, before its transcript is final. */
  readonly live: string
  /** Counts transcript updates; the waveform reshapes on each, never on a frame loop. */
  readonly beat: number
  /** Whether the Person's microphone is muted. */
  readonly muted: boolean
  /** Whole seconds since the call connected; 0 until then. Ticks once a second. */
  readonly elapsed: number
}

/** The subset of Vapi's `message` event this call reads: live transcript lines. */
const Transcript = Schema.Struct({
  type: Schema.Literal('transcript'),
  role: Schema.Literals(['assistant', 'user'] as const),
  transcriptType: Schema.Literals(['partial', 'final'] as const),
  transcript: Schema.String,
})
const decodeTranscript = Schema.decodeUnknownOption(Transcript)

/**
 * Whether the microphone has already been granted for this origin. Browsers without the
 * Permissions API, or without a microphone entry in it, answer `false`, which only means the
 * prompt is spent from a gesture rather than skipped.
 */
const granted = async (): Promise<boolean> =>
  navigator.permissions === undefined
    ? false
    : navigator.permissions
        .query({ name: 'microphone' as PermissionName })
        .then((status) => status.state === 'granted')
        .catch(() => false)

/** Vapi reports failures as loosely shaped objects; this keeps whatever text they carry. */
const describe = (problem: unknown): string => {
  if (typeof problem === 'string') return problem
  if (problem instanceof Error) return problem.message
  return JSON.stringify(problem ?? 'Vapi ended the call').slice(0, 300)
}

/** What a voice card needs from a call: its snapshots and the Person's two controls. */
export interface VoiceControls {
  readonly subscribe: (listener: () => void) => () => void
  readonly getSnapshot: () => VoiceSnapshot
  readonly toggleMute: () => void
  readonly hangUp: () => void
  /**
   * Loudness 0–1 of whoever is talking: Vivid's voice while Vivid speaks, the Person's
   * microphone otherwise. Read by the orb once per animation frame, and kept out of the
   * snapshot on purpose: it changes many times a second and must not re-render React.
   */
  readonly loudness: () => number
}

export class VoiceCall implements VoiceControls {
  #vapi = new Vapi(publicKey)
  #snapshot: VoiceSnapshot = {
    phase: VoicePhase.cases.Connecting.make({}),
    captions: [],
    live: '',
    beat: 0,
    muted: false,
    elapsed: 0,
  }
  #listeners = new Set<() => void>()
  #vividLoudness = 0
  #personLoudness = 0
  #clock: ReturnType<typeof setInterval> | undefined
  /** Vivid's first line, spoken on release; `null` once said or when the call started live. */
  #opening: string | null
  #connected = false
  /** The assistant this call dials with, kept so a failed join can be retried with it. */
  #dialled: Assistant | undefined
  /**
   * Silent redials left for a join that died before Vivid ever spoke. Vapi ends a call that has
   * heard no audio fifteen seconds in, and on a slow link the first join spends most of that
   * downloading Daily's call machine and Krisp's noise-cancellation model. A second attempt runs
   * on warm caches and connects well inside the window, so the Person sees one unbroken
   * "Connecting…" instead of a call that quietly failed. Once Vivid has spoken the call is real
   * and is never retried behind the Person's back.
   */
  #redials = 2
  /** Whether Vivid has spoken on this call; a call that has is never silently restarted. */
  #spoke = false

  /**
   * Dials Vapi at once. A `live` call starts talking as soon as it connects. A `held` call
   * connects and waits for `release` before saying anything: joining a call takes
   * seconds (create the call, find the room, open WebRTC, warm the voice), so dialling early
   * and releasing on the click or the answer makes Vivid speak almost immediately. The
   * microphone stays live while held: Vapi ends a call that has heard no customer audio for
   * fifteen seconds, so muting the hold is what was killing every pre-dialled call.
   * `onEnd` fires once, however the call ends.
   */
  constructor(
    assistant: Assistant,
    mode: 'live' | 'held',
    handlers: {
      /** Vivid has begun a spoken turn; the demo counts these to follow its script. */
      readonly onSpeak: () => void
      /** Vivid finished a spoken turn; the demo ends the call after the last one. */
      readonly onFinishSpeaking: () => void
      /** The element Vapi plays Vivid's voice through, once the call has connected. */
      readonly onVoiceAudio: (element: HTMLAudioElement) => void
      /** The Person finished a sentence; a final transcript line, not a partial one. */
      readonly onPersonSaid: () => void
      /** The call is over; `failure` is what Vapi said when it did not end normally. */
      readonly onEnd: (failure: string | null) => void
    },
  ) {
    this.#vapi.on('speech-start', () => {
      this.#spoke = true
      this.#set({ phase: VoicePhase.cases.Speaking.make({}) })
      handlers.onSpeak()
    })
    this.#vapi.on('speech-end', () => {
      this.#set({ phase: VoicePhase.cases.Listening.make({}) })
      handlers.onFinishSpeaking()
    })
    this.#vapi.on('audio', (element) => handlers.onVoiceAudio(element))
    this.#vapi.on('volume-level', (level) => {
      this.#vividLoudness = level
    })
    this.#vapi.on('local-volume-level', (level) => {
      this.#personLoudness = level
    })
    this.#vapi.on('call-start', () => {
      this.#connected = true
      this.#plainMicrophone()
      this.#set({ phase: VoicePhase.cases.Listening.make({}) })
    })
    this.#vapi.on('message', (message: unknown) => {
      Option.map(decodeTranscript(message), (line) => {
        this.#hear(line)
        if (line.role === 'user' && line.transcriptType === 'final') handlers.onPersonSaid()
      })
    })
    // A failed start or dropped connection reports `error`, and `call-end` may or may not
    // follow, so both routes settle through one guard that ends the call exactly once.
    const end = (failure: string | null) => {
      if (VoicePhase.guards.Ended(this.#snapshot.phase)) return
      if (!this.#spoke && this.#redials > 0 && this.#dialled !== undefined) {
        this.#redials -= 1
        this.#connected = false
        void this.#dial()
        return
      }
      clearInterval(this.#clock)
      this.#set({ phase: VoicePhase.cases.Ended.make({ failure }), live: '' })
      handlers.onEnd(failure)
    }
    this.#vapi.on('call-end', () => end(null))
    this.#vapi.on('error', (problem: unknown) => end(describe(problem)))
    this.#opening = mode === 'held' ? (assistant.firstMessage ?? null) : null
    this.#dialled =
      mode === 'held'
        ? { ...assistant, firstMessage: undefined, firstMessageMode: 'assistant-waits-for-user' }
        : assistant
    if (mode === 'live') this.#startClock()
    void this.#dial()
  }

  /**
   * Turns Krisp's noise cancellation off for this call.
   *
   * The SDK applies it unconditionally while joining — `updateInputSettings` at vapi.js:1429 has
   * no flag behind it — and Krisp downloads a model and swaps the microphone track to do it,
   * which is work this demo does not need in a quiet room. The SDK itself falls back to
   * `type: 'none'` when its processor errors, so the setting is supported; only the switch is
   * missing. `call` is the SDK's Daily handle, private in TypeScript but present at runtime;
   * `updateInputSettings` is Daily's own public API. Delete this when Vapi exposes the option.
   * Source: https://docs.daily.co/reference/daily-js/instance-methods/update-input-settings
   */
  #plainMicrophone() {
    const daily = (this.#vapi as unknown as { readonly call?: DailyInput }).call
    void daily?.updateInputSettings({ audio: { processor: { type: 'none' } } })?.catch(
      () => undefined,
    )
  }

  /**
   * Takes the microphone, then dials. Vapi ends a call that has heard no audio fifteen seconds
   * after it starts, and Daily asks for the microphone *inside* that window — on a slow link the
   * permission prompt alone spent four of those seconds, and media came up at 13.9s, losing the
   * race by one. Asking first moves the prompt out of the window entirely. Daily reuses the
   * granted permission, so this costs nothing on the second call.
   */
  async #dial() {
    // Only when the permission has not been granted yet. Once it has, Daily's own request is
    // instant, and opening and closing the device first would just make Windows hand the
    // microphone over twice.
    if ((await granted()) === false) {
      const microphone = await navigator.mediaDevices
        .getUserMedia({ audio: true })
        .catch(() => null)
      // Daily takes its own track; this one only existed to spend the permission prompt.
      for (const track of microphone?.getTracks() ?? []) track.stop()
    }
    if (this.#dialled !== undefined) void this.#vapi.start(this.#dialled)
  }

  #startClock() {
    this.#clock = setInterval(() => this.#set({ elapsed: this.#snapshot.elapsed + 1 }), 1_000)
  }

  /**
   * Releases a held call: unmute and have Vivid say its opening line now. If the call is still
   * joining, the line is said the moment it connects.
   */
  release = () => {
    const opening = this.#opening
    if (opening === null) return
    this.#opening = null
    this.#startClock()
    const speak = () => this.#vapi.say(opening)
    if (this.#connected) return speak()
    this.#vapi.on('call-start', speak)
  }

  /**
   * Hands Vivid the line for its next turn as a system note, without making it speak now. The
   * model then says that line when the Person next finishes talking, so the script is followed
   * in order rather than left to the model to track.
   */
  cue = (line: string) => {
    this.#vapi.send({
      type: 'add-message',
      message: { role: 'system', content: `Your next reply is exactly this line: "${line}"` },
      triggerResponseEnabled: false,
    })
  }

  subscribe = (listener: () => void) => {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  getSnapshot = () => this.#snapshot

  loudness = () =>
    VoicePhase.guards.Speaking(this.#snapshot.phase) ? this.#vividLoudness : this.#personLoudness

  #set(patch: Partial<VoiceSnapshot>) {
    this.#snapshot = { ...this.#snapshot, ...patch }
    for (const listener of this.#listeners) listener()
  }

  /** Partial lines update the live caption; a final line joins the transcript. */
  #hear(line: typeof Transcript.Type) {
    const beat = this.#snapshot.beat + 1
    if (line.transcriptType === 'partial') return this.#set({ live: line.transcript, beat })
    const speaker = line.role === 'assistant' ? 'Vivid' : 'Person'
    this.#set({
      captions: [...this.#snapshot.captions, { speaker, text: line.transcript }],
      live: '',
      beat,
    })
  }

  /** Mute or unmute the Person's microphone; Vivid keeps talking either way. */
  toggleMute = () => {
    const muted = !this.#snapshot.muted
    this.#vapi.setMuted(muted)
    this.#set({ muted })
  }

  /** The Person hangs up. Vapi then emits `call-end`, which settles the phase. */
  hangUp = () => {
    void this.#vapi.stop()
  }
}
