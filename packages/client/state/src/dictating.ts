import { Machine } from '@typeonce/effect-machine'
import { AtomMachine } from '@typeonce/effect-machine/reactivity'
import { Context, Effect, type Layer, Option, Schema } from 'effect'
import { Atom } from 'effect/reactivity'

/**
 * Speaking a message instead of typing it: the Person taps the microphone in the composer, talks,
 * and taps again; what they said is written into the composer, where they can read it, change it
 * and send it. Nothing is sent by itself.
 *
 * Ported from T3 Code mobile's voice input (`packages/client-runtime/src/voice-input/controller.ts`
 * and `apps/mobile/src/features/voice-input/` there): a tap starts it, a second tap ends it, the
 * words are made on the phone (Apple's SpeechAnalyzer on iOS 26), and they go in where the cursor
 * was. T3 keeps the lifecycle in a class with operation tokens; here it is a machine, as every
 * client lifecycle is (`AGENTS.md`, "Lifecycles are machines"), and the tokens are attempt ids.
 *
 * Owner: one machine for the session (there is one microphone). `owner` names the composer that
 * started it (a Thread's draft key), so only that composer shows it listening and only its draft
 * is written to.
 */

/** Why dictation stopped short, which decides what the composer says and offers. */
export const Why = Schema.TaggedUnion({
  /** This phone cannot make words from speech (no iOS 26, or not this language). */
  Unavailable: {},
  /** The microphone was not allowed. `settings`: only Settings can allow it now. */
  NoMicrophone: { settings: Schema.Boolean },
  /** The microphone or the words could not be got ready. */
  Unprepared: {},
  /** The recording was cut off: a call, another app's audio, or the app leaving the screen. */
  Interrupted: {},
  /** Nothing was said that could be written. */
  Unheard: {},
  /** The recording could not be made into words. */
  Untranscribed: {},
})
export type Why = typeof Why.Type

/** A failure of one attempt's work, carrying the attempt so a late one is declined. */
export class Stopped extends Schema.TaggedError<Stopped>()(
  'DictationStopped',
  { attempt: Schema.String, why: Why },
  { title: 'DictationStopped' },
) {}

/** What the surface does: the microphone, the words, and the composer's draft. */
export interface DictationService {
  /**
   * Asks for the microphone, gets the words ready for this phone's language, and starts
   * recording. Answers with that language, which decides how the words are spaced.
   */
  readonly start: Effect.Effect<string, Why>
  /** Ends when the recording stops by itself (its length limit), or fails when it is cut off. */
  readonly listen: Effect.Effect<void, Why>
  /** Stops the recording and makes it into words. */
  readonly finish: (locale: string) => Effect.Effect<string, Why>
  /** Writes the words into an owner's draft where its cursor is. */
  readonly write: (owner: string, words: string, locale: string) => Effect.Effect<void>
  /** Lets the microphone go and deletes the recording. Doing it twice does nothing more. */
  readonly release: Effect.Effect<void>
}

/** The surface's microphone, words and draft. */
export class Dictation extends Context.Service<Dictation, DictationService>()(
  '@vivid/state/dictating/Dictation',
) {}

/** One attempt: its id (made by the presser) and the composer it writes into. */
const attempt = { attempt: Schema.String, owner: Schema.String }

export const DictatingStates = Machine.state({
  states: {
    /** Nothing held. The microphone and any recording are let go here. */
    Idle: { fields: {} },
    /** Asking for the microphone and getting the words ready. */
    Starting: { fields: attempt },
    /** Recording. `locale` is the language the words will be made in. */
    Listening: { fields: { ...attempt, locale: Schema.String } },
    /** Making the recording into words and writing them into the draft. */
    Writing: { fields: { ...attempt, locale: Schema.String } },
    /** It stopped short, and why. The microphone is let go here too. */
    Refused: { fields: { ...attempt, why: Why } },
  },
})
export type DictatingState = Parameters<typeof DictatingStates.matches>[0]

export const DictatingEvents = Machine.events({
  /** The microphone tapped in a composer. */
  Start: attempt,
  /** The microphone tapped again: what was said is written. */
  Stop: { attempt: Schema.String },
  /** Thrown away: nothing is written. */
  Cancel: { attempt: Schema.String },
  /** The word about a refusal put away. */
  Dismiss: { attempt: Schema.String },
})

const starting = ({
  event,
}: {
  readonly event: { readonly attempt: string; readonly owner: string }
}) => ({
  attempt: event.attempt,
  owner: event.owner,
})

/** What Listening hands to Writing: the same attempt, owner and language. */
const listened = (state: {
  readonly attempt: string
  readonly owner: string
  readonly locale: string
}) => ({ attempt: state.attempt, owner: state.owner, locale: state.locale })

/** Takes an event only when it names the attempt in this state. */
const current = ({
  state,
  event,
}: {
  readonly state: { readonly attempt: string }
  readonly event: { readonly attempt: string }
}) => state.attempt === event.attempt

export const DictatingMachine = Machine.make({
  id: 'Dictating',
  root: DictatingStates,
  events: DictatingEvents,
  effects: {
    // `at` is the state letting go, only so the work has an input; releasing is the same from both.
    release: (_at: 'Idle' | 'Refused') => Dictation.use((service) => service.release),
    start: (input: { readonly attempt: string }) =>
      Dictation.use((service) => service.start).pipe(
        Effect.map((locale) => ({ attempt: input.attempt, locale })),
        Effect.mapError((why) => new Stopped({ attempt: input.attempt, why })),
      ),
    listen: (input: { readonly attempt: string }) =>
      Dictation.use((service) => service.listen).pipe(
        Effect.as(input.attempt),
        Effect.mapError((why) => new Stopped({ attempt: input.attempt, why })),
      ),
    // The words are written in the same work that made them, so a Cancel that leaves this state
    // before they exist leaves nothing written.
    write: (input: { readonly attempt: string; readonly owner: string; readonly locale: string }) =>
      Effect.gen(function* () {
        const service = yield* Dictation
        const words = yield* service.finish(input.locale)
        if (words.trim().length === 0) return yield* Effect.fail(Why.cases.Unheard.make({}))
        yield* service.write(input.owner, words.trim(), input.locale)
        return input.attempt
      }).pipe(Effect.mapError((why) => new Stopped({ attempt: input.attempt, why }))),
  },
  branches: {
    started: { listening: { target: 'Listening' } },
    heard: { writing: { target: 'Writing' } },
    written: { idle: { target: 'Idle' } },
    refused: { refused: { target: 'Refused' } },
  },
}).handle({
  initial: { target: 'Idle' },
  states: {
    Idle: {
      invoke: { src: 'release', input: () => 'Idle' as const, onDone: { none: true } },
      on: { Start: { target: 'Starting', data: starting } },
    },
    Starting: {
      invoke: {
        src: 'start',
        input: ({ state }) => ({ attempt: state.attempt }),
        onDone: {
          branches: 'started',
          declinable: true,
          resolve: (context) =>
            context.output.attempt === context.state.attempt
              ? context.select.listening({
                  data: {
                    attempt: context.state.attempt,
                    owner: context.state.owner,
                    locale: context.output.locale,
                  },
                })
              : context.decline(),
        },
        onFailure: {
          branches: 'refused',
          declinable: true,
          resolve: (context) =>
            context.error.attempt === context.state.attempt
              ? context.select.refused({
                  data: {
                    attempt: context.state.attempt,
                    owner: context.state.owner,
                    why: context.error.why,
                  },
                })
              : context.decline(),
        },
      },
      on: { Cancel: { target: 'Idle', guard: current } },
    },
    Listening: {
      invoke: {
        src: 'listen',
        input: ({ state }) => ({ attempt: state.attempt }),
        // The recording reached its length limit: what was said so far is written.
        onDone: {
          branches: 'heard',
          declinable: true,
          resolve: (context) =>
            context.output === context.state.attempt
              ? context.select.writing({ data: listened(context.state) })
              : context.decline(),
        },
        onFailure: {
          branches: 'refused',
          declinable: true,
          resolve: (context) =>
            context.error.attempt === context.state.attempt
              ? context.select.refused({
                  data: {
                    attempt: context.state.attempt,
                    owner: context.state.owner,
                    why: context.error.why,
                  },
                })
              : context.decline(),
        },
      },
      on: {
        Stop: { target: 'Writing', guard: current, data: ({ state }) => listened(state) },
        Cancel: { target: 'Idle', guard: current },
      },
    },
    Writing: {
      invoke: {
        src: 'write',
        input: ({ state }) => ({
          attempt: state.attempt,
          owner: state.owner,
          locale: state.locale,
        }),
        onDone: {
          branches: 'written',
          declinable: true,
          resolve: (context) =>
            context.output === context.state.attempt
              ? context.select.idle({ data: {} })
              : context.decline(),
        },
        onFailure: {
          branches: 'refused',
          declinable: true,
          resolve: (context) =>
            context.error.attempt === context.state.attempt
              ? context.select.refused({
                  data: {
                    attempt: context.state.attempt,
                    owner: context.state.owner,
                    why: context.error.why,
                  },
                })
              : context.decline(),
        },
      },
      on: { Cancel: { target: 'Idle', guard: current } },
    },
    Refused: {
      invoke: { src: 'release', input: () => 'Refused' as const, onDone: { none: true } },
      on: {
        Start: { target: 'Starting', data: starting },
        Dismiss: { target: 'Idle', guard: current },
      },
    },
  },
})

/** What a composer reads about dictation, for its own Thread. */
export type Reading = Schema.Schema.Type<typeof Reading>
export const Reading = Schema.TaggedUnion({
  /** Not dictating here: the microphone can be tapped. */
  Ready: {},
  /** Dictating in another composer: this one's microphone waits. */
  Elsewhere: {},
  Starting: { attempt: Schema.String },
  Listening: { attempt: Schema.String },
  Writing: { attempt: Schema.String },
  Refused: { attempt: Schema.String, why: Why },
})

/** The machine as one composer reads it: its own attempt, someone else's, or none. */
export const readingOf = (state: DictatingState, owner: string): Reading =>
  Option.getOrElse(
    Option.firstSomeOf([
      Option.map(DictatingStates.get(state, 'Starting'), (at) =>
        mine(at, owner, Reading.cases.Starting.make({ attempt: at.attempt })),
      ),
      Option.map(DictatingStates.get(state, 'Listening'), (at) =>
        mine(at, owner, Reading.cases.Listening.make({ attempt: at.attempt })),
      ),
      Option.map(DictatingStates.get(state, 'Writing'), (at) =>
        mine(at, owner, Reading.cases.Writing.make({ attempt: at.attempt })),
      ),
      Option.map(DictatingStates.get(state, 'Refused'), (at) =>
        at.owner === owner
          ? Reading.cases.Refused.make({ attempt: at.attempt, why: at.why })
          : Reading.cases.Ready.make({}),
      ),
    ]),
    () => Reading.cases.Ready.make({}),
  )

/** An attempt's reading in its own composer; every other composer waits for it. */
const mine = (at: { readonly owner: string }, owner: string, reading: Reading): Reading =>
  at.owner === owner ? reading : Reading.cases.Elsewhere.make({})

/** The longest a recording runs, in seconds, as T3 Code mobile's `VOICE_RECORDING_LIMIT_SECONDS`. */
export const LONGEST_SECONDS = 5 * 60

/** Creates the session's dictation machine in the app registry with the surface's microphone. */
export const makeDictating = (services: Layer.Layer<Dictation>) =>
  AtomMachine.bind(Atom.runtime(services)).make(DictatingMachine)
export type DictatingAtoms = ReturnType<typeof makeDictating>
