import { dictating } from '@vivid/state'
import { Option } from 'effect'
import { Check, Mic, X } from 'lucide-react-native'
import { useState } from 'react'
import { ActivityIndicator, Linking, View, type LayoutChangeEvent } from 'react-native'
import Animated, {
  Easing,
  ReduceMotion,
  useAnimatedStyle,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated'
import { commit } from '../data/haptics'
import { useTheme } from '../theme'
import { Glyph } from './Glyph'
import { Label, Press, TARGET } from './ui'

/**
 * Dictation in the composer, drawn as T3 Code mobile draws it (`ComposerDictationControl.tsx`):
 *
 * - At rest the microphone is a bare glyph beside Send, 20 points in a 44-point target, with no
 *   ground of its own (`VoiceActionButton`, the plain variant).
 * - While it listens, the composer's row becomes the recording: a cross at the leading end that
 *   throws it away, the live level of the voice and the time in the middle, and a tick in a filled
 *   30-point circle at the trailing end that writes what was said (the primary variant).
 * - While it gets ready or writes, the tick holds a spinner and the middle says which.
 * - A failure is said in the middle in the danger colour, with a cross to put it away.
 *
 * Asking for the microphone is the system's own prompt. When the Person has refused it there,
 * only Settings can allow it, so the microphone opens Settings, as T3's "Open microphone settings"
 * does; nothing is written into the composer about it.
 */

/** How dictation stands for this composer, and the moves it takes. */
export interface Dictating {
  readonly reading: dictating.Reading
  /** Starts listening, or ends it and writes what was said. */
  readonly onTap: () => void
  /** Throws away what is being said, or puts away a failure. */
  readonly onDrop: () => void
  /** The level of the voice, newest last, each from 0 to 1. */
  readonly levels: SharedValue<ReadonlyArray<number>>
  /** How long it has been listening, in whole seconds. */
  readonly seconds: number
}

/** The tick's filled circle, as T3's primary voice action. */
const TICK = 30
/** The waveform's height and the room each bar takes, T3's `WAVEFORM_BAR_HEIGHT` and spacing. */
const WAVE = 32
const BAR_ROOM = 5
/** T3's waveform timing: each bar eases to its new level over a tenth of a second. */
const BAR_TIMING = {
  duration: 100,
  easing: Easing.out(Easing.quad),
  reduceMotion: ReduceMotion.System,
}

/** Whether the row is the recording's (or its failure's) rather than the words'. */
export const isDictating = (dictation: Option.Option<Dictating>): boolean =>
  Option.exists(dictation, ({ reading }) =>
    dictating.Reading.match(reading, {
      Ready: () => false,
      Elsewhere: () => false,
      Starting: () => true,
      Listening: () => true,
      Writing: () => true,
      // A refused microphone is the system's to say; the row stays the words'.
      Refused: ({ why }) => !dictating.Why.guards.NoMicrophone(why),
    }),
  )

/** Settings is the only way back once the Person refused the microphone in the system's prompt. */
const settingsOnly = (reading: dictating.Reading): boolean =>
  dictating.Reading.guards.Refused(reading) &&
  dictating.Why.guards.NoMicrophone(reading.why) &&
  reading.why.settings

/** The microphone at rest: a bare glyph beside Send. */
export function MicButton({ dictation }: { dictation: Option.Option<Dictating> }) {
  const { colors: c } = useTheme()
  if (Option.isNone(dictation) || isDictating(dictation)) return null
  const { reading, onTap, onDrop } = dictation.value
  if (dictating.Reading.guards.Elsewhere(reading)) return null
  const toSettings = settingsOnly(reading)
  return (
    <Press
      accessibilityRole="button"
      accessibilityLabel={toSettings ? 'Open microphone settings' : 'Dictate'}
      onPress={() => {
        commit()
        if (toSettings) {
          onDrop()
          void Linking.openSettings()
        } else onTap()
      }}
      style={({ pressed }) => ({
        width: TARGET,
        height: TARGET,
        alignItems: 'center',
        justifyContent: 'center',
        opacity: pressed ? 0.7 : 1,
      })}
    >
      <Glyph name="mic" fallback={Mic} size={22} color={c.foreground} />
    </Press>
  )
}

/** What the middle of the row says outside listening. */
const wordsOf = (reading: dictating.Reading): Option.Option<{ text: string; failed: boolean }> =>
  dictating.Reading.match(reading, {
    Ready: () => Option.none(),
    Elsewhere: () => Option.none(),
    Listening: () => Option.none(),
    Starting: () => Option.some({ text: 'Preparing', failed: false }),
    Writing: () => Option.some({ text: 'Transcribing', failed: false }),
    Refused: ({ why }) => Option.some({ text: failureOf(why), failed: true }),
  })

/** A failure in the Person's words. A refused microphone never reaches here (`isDictating`). */
const failureOf = (why: dictating.Why): string =>
  dictating.Why.match(why, {
    Unavailable: () => 'This phone cannot write down speech in its language.',
    NoMicrophone: () => 'Vivid needs the microphone to hear you.',
    Unprepared: () => 'The microphone could not start.',
    Interrupted: () => 'The recording was cut off.',
    Unheard: () => 'Nothing was heard.',
    Untranscribed: () => 'What you said could not be written down.',
  })

/** The row while dictating: cancel, the recording, and the tick. */
export function DictationBar({ dictation }: { dictation: Dictating }) {
  const { colors: c } = useTheme()
  const { reading, onTap, onDrop, levels, seconds } = dictation
  const words = wordsOf(reading)
  const busy =
    dictating.Reading.guards.Starting(reading) || dictating.Reading.guards.Writing(reading)
  const failed = dictating.Reading.guards.Refused(reading)
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', height: TARGET }}>
      <Plain label={failed ? 'Dismiss' : 'Throw away the recording'} onPress={onDrop}>
        <Glyph name="xmark" fallback={X} size={18} color={c.foreground} />
      </Plain>
      <View style={{ flex: 1, minWidth: 0, height: TARGET, justifyContent: 'center' }}>
        {Option.match(words, {
          onNone: () => <Recording levels={levels} seconds={seconds} />,
          onSome: ({ text, failed: bad }) => (
            <Label
              size="label"
              tone={bad ? 'status-danger' : 'ink-2'}
              numberOfLines={2}
              style={{ textAlign: bad ? 'left' : 'center', paddingHorizontal: 8 }}
            >
              {text}
            </Label>
          ),
        })}
      </View>
      {failed ? (
        <Plain label="Dictate again" onPress={onTap}>
          <Glyph name="mic" fallback={Mic} size={22} color={c.foreground} />
        </Plain>
      ) : (
        <Press
          accessibilityRole="button"
          accessibilityLabel={busy ? 'Preparing voice input' : 'Finish dictation'}
          accessibilityState={{ busy, disabled: busy }}
          disabled={dictating.Reading.guards.Writing(reading)}
          onPress={() => {
            commit()
            onTap()
          }}
          style={({ pressed }) => ({
            width: TARGET,
            height: TARGET,
            alignItems: 'center',
            justifyContent: 'center',
            opacity: pressed ? 0.7 : 1,
          })}
        >
          <View
            style={{
              width: TICK,
              height: TICK,
              borderRadius: TICK / 2,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: busy ? c.subtle : c.primary,
            }}
          >
            {busy ? (
              <ActivityIndicator size="small" color={c['ink-3']} />
            ) : (
              <Glyph name="checkmark" fallback={Check} size={15} color={c['primary-foreground']} />
            )}
          </View>
        </Press>
      )}
    </View>
  )
}

/** A bare glyph control, 44 points, as T3's plain voice action. */
function Plain({
  label,
  onPress,
  children,
}: {
  label: string
  onPress: () => void
  children: React.ReactNode
}) {
  return (
    <Press
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => ({
        width: TARGET,
        height: TARGET,
        alignItems: 'center',
        justifyContent: 'center',
        opacity: pressed ? 0.7 : 1,
      })}
    >
      {children}
    </Press>
  )
}

/** The live level of the voice across the middle, and the time it has run. */
function Recording({
  levels,
  seconds,
}: {
  levels: SharedValue<ReadonlyArray<number>>
  seconds: number
}) {
  const [bars, setBars] = useState(0)
  const laid = (event: LayoutChangeEvent) =>
    setBars(Math.max(1, Math.floor(event.nativeEvent.layout.width / BAR_ROOM)))
  return (
    <View
      accessible
      accessibilityLabel={`Listening, ${seconds} seconds`}
      style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 4 }}
    >
      <View
        importantForAccessibility="no-hide-descendants"
        onLayout={laid}
        style={{
          flex: 1,
          height: WAVE,
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          overflow: 'hidden',
        }}
      >
        {Array.from({ length: bars }, (_, at) => (
          <Bar key={at} levels={levels} from={bars - at} />
        ))}
      </View>
      <Label size="label" tone="ink-2" style={{ fontVariant: ['tabular-nums'] }}>
        {`${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`}
      </Label>
    </View>
  )
}

/** One bar: the level `from` samples back from the newest, as height and strength. */
function Bar({ levels, from }: { levels: SharedValue<ReadonlyArray<number>>; from: number }) {
  const { colors: c } = useTheme()
  const style = useAnimatedStyle(() => {
    const level = levels.value[levels.value.length - from] ?? 0
    return {
      opacity: withTiming(0.22 + level * 0.78, BAR_TIMING),
      transform: [{ scaleY: withTiming((2 + level * (WAVE - 2)) / WAVE, BAR_TIMING) }],
    }
  })
  return (
    <Animated.View
      style={[{ width: 2, height: WAVE, borderRadius: 1, backgroundColor: c.foreground }, style]}
    />
  )
}
