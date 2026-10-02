import { Effect, Result, Schema } from 'effect'
import { useState } from 'react'
import { Clipboard } from 'react-native'
import { Check, Copy as CopyIcon } from 'lucide-react-native'
import { useLiveData } from '../data/live'
import { useTheme } from '../theme'
import { HAIRLINE, Label, Press, radius } from './ui'

/** A refused native clipboard write leaves selectable text as the way to copy by hand. */
class ClipboardRefused extends Schema.TaggedError<ClipboardRefused>()(
  'ClipboardRefused',
  {},
  { title: 'Clipboard refused' },
) {}

/** The installed React Native public Clipboard API writes synchronously on iOS and Android. */
const copy = Effect.fn('Clipboard.copy')(function* (text: string) {
  yield* Effect.try({ try: () => Clipboard.setString(text), catch: () => new ClipboardRefused({}) })
})

const LABEL = { idle: 'Copy', copied: 'Copied', refused: 'Copy it by hand' } as const

/** Copy reads at the press and mirrors the web's success, refusal, words and accessible name. */
export function Copy({ name, read }: { name: string; read: () => string }) {
  const data = useLiveData()
  const { colors: c } = useTheme()
  const [state, setState] = useState<keyof typeof LABEL>('idle')
  const Icon = state === 'copied' ? Check : CopyIcon
  return (
    <Press
      accessibilityRole="button"
      accessibilityLabel={`${LABEL[state]}: ${name}`}
      onPress={() => {
        void data
          .run(copy(read()))
          .then((result) => setState(Result.isSuccess(result) ? 'copied' : 'refused'))
      }}
      style={({ pressed }) => ({
        minHeight: 44,
        paddingHorizontal: 16,
        gap: 8,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: radius.control,
        borderWidth: HAIRLINE,
        borderColor: c['line-3'],
        backgroundColor: pressed ? c['wash-pressed'] : c['surface-2'],
      })}
    >
      <Icon pointerEvents="none" size={17} strokeWidth={1.8} color={c.ink} />
      <Label size="footnote">{LABEL[state]}</Label>
    </Press>
  )
}
