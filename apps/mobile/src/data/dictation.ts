import { useAtomMount, useAtomValue } from '@effect/atom-react'
import AppleTranscription from '@react-native-ai/apple/src/NativeAppleTranscription'
import { dictating } from '@vivid/state'
import { Effect, Layer, Option } from 'effect'
import { AsyncResult } from 'effect/reactivity'
import {
  AudioModule,
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  setIsAudioActiveAsync,
  type AudioRecorder,
  type RecordingStatus,
} from 'expo-audio'
import { randomUUID } from 'expo-crypto'
import { File } from 'expo-file-system'
import { AppState, Platform } from 'react-native'
import { draft } from './drafts'
import type { Dictating } from '../ui/Composer'
import { useLiveData, type LiveData } from './live'

/**
 * The phone's side of dictation (`dictating` in `@vivid/state`): the microphone through
 * `expo-audio`, the words through Apple's SpeechAnalyzer (`@react-native-ai/apple`, iOS 26 and
 * later), and the composer's draft (`drafts.ts`).
 *
 * Ported from T3 Code mobile: the recording options and the audio session from
 * `apps/mobile/src/features/voice-input/VoiceInputProvider.tsx`, the words from
 * `apps/mobile/src/native/voiceTranscription.ios.ts`, and the spacing from
 * `resolveTranscriptCommit` in `packages/client-runtime/src/voice-input/controller.ts`. Android
 * has no words on the phone there either, so the microphone is offered on iOS only.
 *
 * The recorder is made on the first press, not when a composer appears: T3 found that making it
 * holds the JavaScript thread for tens of milliseconds, and most composers never record
 * (`lazyVoiceRecorder.ts` there).
 */

/** The phone's language, as SpeechAnalyzer names it. */
const language = () => Intl.DateTimeFormat().resolvedOptions().locale

/**
 * Whether this phone can make words from speech at all: iOS 26 and a language it knows. Asked of
 * the native module once, on first use, since every composer reads it on every draw.
 */
/** Whether this phone can dictate, once the native module has been asked. */
interface Able {
  known: Option.Option<boolean>
}
const able: Able = { known: Option.none() }
export const canDictate = (): boolean =>
  Option.getOrElse(able.known, () => {
    const now = Platform.OS === 'ios' && AppleTranscription.isAvailable(language())
    able.known = Option.some(now)
    return now
  })

/**
 * T3's recording options: the high-quality preset, flattened for the native constructor as
 * `useAudioRecorder` would, with metering on.
 */
const OPTIONS = {
  extension: RecordingPresets.HIGH_QUALITY.extension,
  sampleRate: RecordingPresets.HIGH_QUALITY.sampleRate,
  numberOfChannels: RecordingPresets.HIGH_QUALITY.numberOfChannels,
  bitRate: RecordingPresets.HIGH_QUALITY.bitRate,
  isMeteringEnabled: true,
  ...(Platform.OS === 'ios'
    ? RecordingPresets.HIGH_QUALITY.ios
    : RecordingPresets.HIGH_QUALITY.android),
}

/** The one recorder, made on first use, and the recordings it has written that are not yet deleted. */
/** The microphone this session made, and recordings not yet deleted. */
interface Held {
  recorder: Option.Option<AudioRecorder>
  files: Set<string>
}
const held: Held = {
  recorder: Option.none(),
  files: new Set(),
}

const recorder = (): AudioRecorder =>
  Option.getOrElse(held.recorder, () => {
    const made = new AudioModule.AudioRecorder(OPTIONS)
    held.recorder = Option.some(made)
    return made
  })

const why = dictating.Why.cases

/**
 * The audio session for recording, as T3 sets it: nothing else plays while the Person talks, and
 * it records with the ringer switch off.
 */
const openSession = Effect.fn('Dictation.openSession')(function* () {
  yield* Effect.tryPromise(() =>
    setAudioModeAsync({
      allowsRecording: true,
      interruptionMode: 'doNotMix',
      playsInSilentMode: true,
      shouldPlayInBackground: false,
    }),
  )
  yield* Effect.tryPromise(() => setIsAudioActiveAsync(true))
})

/**
 * Lets the audio session go. Expo does not deactivate it when recording stops, and only an
 * explicit deactivation lets the music the recording paused carry on (T3's
 * `releaseVoiceRecordingAudio`).
 */
const closeSession = Effect.fn('Dictation.closeSession')(function* () {
  yield* Effect.tryPromise(() => setAudioModeAsync({ allowsRecording: false }))
  yield* Effect.tryPromise(() => setIsAudioActiveAsync(false))
}, Effect.ignore)

const start = Effect.fn('Dictation.start')(function* () {
  const locale = language()
  if (!canDictate()) return yield* Effect.fail(why.Unavailable.make({}))
  const allowed = yield* Effect.tryPromise(() => requestRecordingPermissionsAsync()).pipe(
    Effect.mapError(() => why.Unprepared.make({})),
  )
  if (!allowed.granted)
    return yield* Effect.fail(why.NoMicrophone.make({ settings: !allowed.canAskAgain }))
  yield* Effect.tryPromise(() => AppleTranscription.prepare(locale)).pipe(
    Effect.mapError(() => why.Unavailable.make({})),
  )
  yield* openSession().pipe(Effect.mapError(() => why.Unprepared.make({})))
  const microphone = recorder()
  yield* Effect.tryPromise(() => microphone.prepareToRecordAsync()).pipe(
    Effect.mapError(() => why.Unprepared.make({})),
  )
  Option.map(Option.fromNullishOr(microphone.uri), (uri) => held.files.add(uri))
  microphone.record({ forDuration: dictating.LONGEST_SECONDS })
  return locale
})

/**
 * Waits for the recording to end by itself. Its length limit ends it whole; a call, another app
 * taking the audio, or the app leaving the screen cuts it off (T3 stops on `background` only: iOS
 * says `inactive` while its own permission dialog is up).
 */
const listen: Effect.Effect<void, dictating.Why> = Effect.callback<void, dictating.Why>(
  (resume) => {
    const status = recorder().addListener('recordingStatusUpdate', (now: RecordingStatus) => {
      Option.map(Option.fromNullishOr(now.url), (uri) => held.files.add(uri))
      if (now.hasError || now.mediaServicesDidReset === true)
        resume(Effect.fail(why.Interrupted.make({})))
      else if (now.isFinished) resume(Effect.void)
    })
    const away = AppState.addEventListener('change', (next) => {
      if (next === 'background') resume(Effect.fail(why.Interrupted.make({})))
    })
    return Effect.sync(() => {
      status.remove()
      away.remove()
    })
  },
)

/** Stops the recording and makes it into words, joined as T3 joins SpeechAnalyzer's segments. */
const finish = Effect.fn('Dictation.finish')(function* (locale: string) {
  const microphone = recorder()
  yield* Effect.tryPromise(() => microphone.stop()).pipe(Effect.ignore)
  yield* closeSession()
  const uri = yield* Effect.fromNullishOr(microphone.uri).pipe(
    Effect.mapError(() => why.Untranscribed.make({})),
  )
  held.files.add(uri)
  const audio = yield* Effect.tryPromise(() => new File(uri).arrayBuffer()).pipe(
    Effect.mapError(() => why.Untranscribed.make({})),
  )
  const heard = yield* Effect.tryPromise(() => AppleTranscription.transcribe(audio, locale)).pipe(
    Effect.mapError(() => why.Untranscribed.make({})),
  )
  return heard.segments
    .map((segment) => segment.text)
    .join(' ')
    .trim()
})

/**
 * The words put after what is already in the draft. In English a space goes between them when
 * the draft ends in a word or a stop, as T3's `resolveTranscriptCommit` does for an empty
 * selection; other languages are joined as they are, since not every script spaces its words.
 * Vivid's composer holds no cursor, so the words go at the end.
 */
const joined = (before: string, words: string, locale: string): string => {
  const english = /^en([-_]|$)/iu.test(locale)
  const needsSpace = english && /[A-Za-z0-9.!?,:;)\]}'"]$/u.test(before)
  return `${before}${needsSpace ? ' ' : ''}${words}`
}

const write = (owner: string, words: string, locale: string) =>
  Effect.sync(() => draft.keep(owner, joined(draft.in(owner), words, locale)))

/** Stops a recording still running, lets the session go, and deletes every recording kept. */
const release = Effect.fn('Dictation.release')(function* () {
  yield* Option.match(held.recorder, {
    onNone: () => Effect.void,
    onSome: (microphone) =>
      microphone.isRecording
        ? Effect.tryPromise(() => microphone.stop()).pipe(Effect.ignore)
        : Effect.void,
  })
  yield* closeSession()
  for (const uri of held.files) yield* Effect.try(() => new File(uri).delete()).pipe(Effect.ignore)
  held.files.clear()
})

const machine = dictating.makeDictating(
  Layer.succeed(dictating.Dictation, {
    start: start(),
    listen,
    finish,
    write,
    release: release(),
  }),
)

const EMPTY = dictating.Reading.cases.Ready.make({})

/** How dictation stands for one composer, by its draft's place. */
export const useDictation = (owner: string): dictating.Reading => {
  const result = useAtomValue(machine.result)
  return AsyncResult.isSuccess(result) ? dictating.readingOf(result.value, owner) : EMPTY
}

/** The microphone tapped in a composer: start, or stop and write what was said. */
export const tapMicrophone = (data: LiveData, owner: string, reading: dictating.Reading) =>
  dictating.Reading.match(reading, {
    Ready: () =>
      data.registry.set(
        machine.send,
        dictating.DictatingEvents.Start({ attempt: randomUUID(), owner }),
      ),
    Refused: () =>
      data.registry.set(
        machine.send,
        dictating.DictatingEvents.Start({ attempt: randomUUID(), owner }),
      ),
    Listening: ({ attempt }) =>
      data.registry.set(machine.send, dictating.DictatingEvents.Stop({ attempt })),
    Starting: ({ attempt }) =>
      data.registry.set(machine.send, dictating.DictatingEvents.Cancel({ attempt })),
    Writing: () => undefined,
    Elsewhere: () => undefined,
  })

/** Throws away what is being said, or puts away the word about a refusal. */
export const dropDictation = (data: LiveData, reading: dictating.Reading) =>
  dictating.Reading.match(reading, {
    Ready: () => undefined,
    Elsewhere: () => undefined,
    Starting: ({ attempt }) =>
      data.registry.set(machine.send, dictating.DictatingEvents.Cancel({ attempt })),
    Listening: ({ attempt }) =>
      data.registry.set(machine.send, dictating.DictatingEvents.Cancel({ attempt })),
    Writing: ({ attempt }) =>
      data.registry.set(machine.send, dictating.DictatingEvents.Cancel({ attempt })),
    Refused: ({ attempt }) =>
      data.registry.set(machine.send, dictating.DictatingEvents.Dismiss({ attempt })),
  })

/**
 * The microphone for one composer, by its draft's place, on a phone that can make words from
 * speech; none on Android or an iPhone before iOS 26. Mounting it keeps the session's machine
 * running while a composer is on screen.
 */
export const useMicrophone = (owner: string): Option.Option<Dictating> => {
  const data = useLiveData()
  useAtomMount(machine.snapshot)
  const reading = useDictation(owner)
  if (!canDictate()) return Option.none()
  return Option.some({
    reading,
    onTap: () => tapMicrophone(data, owner, reading),
    onDrop: () => dropDictation(data, reading),
  })
}
