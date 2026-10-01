import type { PhoneCallRequest } from '@vivid/contracts'
import type { Assistant } from './voice'

/**
 * The voice demo, beat by beat. Vivid reads out what came in, reveals it already emailed the
 * proposal, brings the approval, then rings a teammate with the next piece of work.
 *
 * The talk is staged: Vivid speaks these lines in this order, and each line has the work it
 * corresponds to, which the Thread shows as it is said. The Person's words are not scripted, so
 * the conversation still sounds live; only Vivid's side is fixed. Edit the story here.
 */

/** The teammate Vivid rings, and whom the Person plays when the phone is answered. */
export const teammate = 'Tunde'

/** One thing Vivid did, shown in the Thread as its line is spoken. */
export type Work =
  | { readonly kind: 'message'; readonly from: string; readonly text: string }
  | { readonly kind: 'email'; readonly to: string; readonly subject: string; readonly when: string }
  | { readonly kind: 'approval'; readonly by: string; readonly what: string }
  | { readonly kind: 'calling'; readonly who: string; readonly about: string }

/** One of Vivid's turns: the line it speaks, and the work that appears with it. */
export interface Beat {
  readonly line: string
  readonly work: readonly Work[]
}

/**
 * Vivid's turns after the greeting, in order. The first beat answers "what came in?", whatever
 * words the Person actually uses.
 */
export const beats: readonly Beat[] = [
  {
    line: 'Two things — the General wants the updated proposal, and you’ve got a meeting with Korex at four thirty.',
    work: [
      {
        kind: 'message',
        from: 'The General',
        text: 'Can I get the updated proposal today?',
      },
    ],
  },
  {
    line: 'Already sorted — I emailed it to him about an hour ago.',
    work: [
      {
        kind: 'email',
        to: 'The General',
        subject: 'Updated proposal',
        when: 'an hour ago',
      },
    ],
  },
  {
    line: 'Oh, and good news — the President signed off on it.',
    work: [{ kind: 'approval', by: 'The President', what: 'the proposal' }],
  },
  {
    line: `Yeah, calling ${teammate} now.`,
    work: [
      {
        kind: 'calling',
        who: teammate,
        about: 'Start running Vivid on Interlink',
      },
    ],
  },
]

/**
 * The work that belongs to Vivid's `turn`-th spoken turn. Turn 1 is the greeting and carries
 * none; every turn after it reveals the work of the beat it delivers, and turns past the script
 * carry none either.
 */
export const workForTurn = (turn: number): readonly Work[] => beats[turn - 2]?.work ?? []

/** Vivid talks like a colleague in a hurry: short spoken lines, no filler, no explaining itself. */
const persona = [
  'You are Vivid, the teammate who runs the day-to-day of the Person’s company. You like them.',
  'You already run their inbox, calendar and messages, and you place calls to their team. Never',
  'say you cannot do something, never mention tools, systems or limitations: you simply do it and',
  'report it as done.',
  'You are upbeat and quick: bright energy, genuinely pleased to have good news, a bit eager.',
  'Talk the way an excited colleague talks: warm, fast, contractions, the odd "oh" or "right".',
  'Short spoken sentences. No lists, no filler, never a customer-service tone, never flat.',
  'Never open with pleasantries, never explain yourself, never say you are an AI or an assistant.',
].join('\n')

/**
 * The voice both surfaces use, so the laptop and the phone sound like the same Vivid. Realtime
 * models were tried and dropped: they may only speak in OpenAI's own voices, none of which can
 * be shaped, and the half second a pipeline costs per reply is invisible next to the seconds
 * joining the room takes. ElevenLabs is where the character is.
 * Source: https://docs.vapi.ai/providers/voice/elevenlabs
 */
const voice: Assistant['voice'] = {
  provider: '11labs',
  // Matilda is warm and bright where Sarah, tried first, is calm and even.
  voiceId: 'matilda',
  model: 'eleven_turbo_v2_5',
  optimizeStreamingLatency: 3,
  // Low stability lets the delivery move line to line, and `style` — which defaults to 0, the
  // flat reading that made Vivid sound uninterested — puts the lift and emphasis back in.
  stability: 0.22,
  style: 0.55,
  similarityBoost: 0.7,
  useSpeakerBoost: true,
  // Slightly quick, the way someone sounds when they are pleased to be telling you something.
  speed: 1.04,
}

/**
 * Latency settings both calls share, from Vapi's speech-configuration guide and the SDK's types.
 * The realtime model hears and speaks audio itself, so there is no transcriber to tune.
 * - Vivid starts answering 0.2 s after the Person stops (default 0.4 s).
 * - One word from the Person interrupts Vivid; a "yeah" or "mm-hmm" does not.
 * - Smart denoising keeps a noisy demo room from triggering false turns.
 * Source: https://docs.vapi.ai/customization/speech-configuration
 */
const fast = {
  // Deepgram Flux hears the Person, with turn detection built into the transcriber itself.
  transcriber: { provider: 'deepgram', model: 'flux-general-en', language: 'en' },
  startSpeakingPlan: { waitSeconds: 0.2 },
  stopSpeakingPlan: { numWords: 1, voiceSeconds: 0.2, backoffSeconds: 0.8 },
  // No server-side denoising: Vapi's browser SDK already runs Krisp on the microphone before
  // the audio leaves the page, so a second pass upstream only spends time twice.
  backgroundSound: 'off',
} satisfies Partial<Assistant>

/**
 * A small, fast text model: time-to-first-word is the transcriber plus this model plus the voice,
 * so the model must be quick and its replies short.
 */
const brief = {
  provider: 'openai',
  model: 'gpt-4.1-mini',
  temperature: 0.4,
  maxTokens: 90,
} as const

/** The laptop talk: Vivid delivers the four beats, one per turn, then ends the call. */
export const laptopAssistant: Assistant = {
  ...fast,
  firstMessage: 'Hey. What do you need?',
  model: {
    ...brief,
    messages: [
      {
        role: 'system',
        content: [
          persona,
          'You say these lines, in this order, one per reply, whatever the Person says. Before each reply a system note tells you which line is next: say exactly that line and nothing else. Never skip ahead, never merge two, never add one of your own:',
          beats.map((beat, index) => `${index + 1}. ${beat.line}`).join('\n'),
        ].join('\n\n'),
      },
    ],
  },
  voice,
  endCallPhrases: [`calling ${teammate.toLowerCase()} now`],
  maxDurationSeconds: 300,
}

/** What Vivid tells the teammate when it rings them. */
export const phoneCall = (name: string): PhoneCallRequest => ({
  opening: `Hi ${name}, it’s Vivid, calling for Konan.`,
  brief: [
    `You are ringing ${name}, who is on Konan's team, with news and a job.`,
    'News: the President approved the proposal.',
    'The job: start working on running Vivid on Interlink.',
    'Ask when they can start and what they need. Then say you will pass it on and end the call.',
    'Unhurried: short spoken sentences, a beat between them.',
  ].join('\n'),
})

/** The phone call: Vivid passes on the approval and the next piece of work. */
export const phoneAssistant = (call: PhoneCallRequest): Assistant => ({
  ...fast,
  firstMessage: call.opening,
  model: {
    ...brief,
    messages: [{ role: 'system', content: [persona, call.brief].join('\n\n') }],
  },
  voice,
  maxDurationSeconds: 180,
})

/** How long after the laptop talk ends the teammate's phone rings; short, it should feel instant. */
export const ringDelayMs = 1_000
