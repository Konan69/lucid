import type { Shown } from '@vivid/contracts'
import { togglePicked } from '@vivid/state'
import { useState } from 'react'
import { View } from 'react-native'
import { Check, ChevronRight } from 'lucide-react-native'
import type { Say } from '../../data/delivery'
import { commit, tick } from '../../data/haptics'
import { useTheme } from '../../theme'
import { Button, HAIRLINE, Label, Press, radius } from '../../ui/ui'
import { Frame } from './Frame'

type Ask = Extract<Shown, { readonly _tag: 'Options' }>

/**
 * A question with its answers laid out as large rows, all on the card, so a choice is one tap
 * with a thumb. A single pick answers at once; a multi-pick toggles rows and ends with one
 * confirm fixed at the foot of the card, so the Person is never hunting for the way to say it.
 *
 * Only the newest finished reply is live. An older card is the record of what was asked and
 * shows the rows as plain text, which is also how it must read: nothing on it looks tappable.
 * What is chosen is said as the Person's next message, in plain words.
 */
export function Options({ ask, live, onSay }: { ask: Ask; live: boolean; onSay: Say }) {
  const [picked, setPicked] = useState<ReadonlyArray<string>>([])
  // Once words are on their way the card must not say them twice, however fast the taps come.
  // When they do not arrive it opens again: the card used to stay shut for good, so a choice
  // that failed on a bad connection could be sent again from the foot of the Thread but never
  // changed.
  const [sent, setSent] = useState(false)
  const open = live && !sent
  const say = (words: string) => {
    commit()
    setSent(true)
    void onSay(words).then(setSent)
  }
  const pick = (label: string) => {
    if (!open) return
    if (!ask.many) {
      setPicked([label])
      say(label)
      return
    }
    tick()
    setPicked((now) => togglePicked(now, label))
  }
  return (
    <Frame title={ask.question}>
      <View style={{ gap: 8 }}>
        {ask.options.map((option) => (
          <Choice
            key={option.label}
            option={option}
            many={ask.many}
            chosen={picked.includes(option.label)}
            open={open}
            onPress={() => pick(option.label)}
          />
        ))}
      </View>
      {ask.many && open && (
        <Button
          kind="primary"
          label={picked.length === 0 ? 'Pick one or more' : `Send ${picked.length}`}
          disabled={picked.length === 0}
          onPress={() => say(picked.join(', '))}
        />
      )}
    </Frame>
  )
}

/** The look every row shares, open or closed. */
const ROW = {
  minHeight: 60,
  paddingHorizontal: 16,
  paddingVertical: 12,
  flexDirection: 'row',
  alignItems: 'center',
  gap: 12,
} as const

/** The label of an answer, and the line Vivid gave under it when it gave one. */
function Words({ option, tone }: { option: Ask['options'][number]; tone: 'ink' | 'ink-2' }) {
  return (
    <View style={{ flex: 1, gap: 2 }}>
      <Label size="footnote" tone={tone}>
        {option.label}
      </Label>
      {option.detail !== undefined && (
        <Label size="label" tone="ink-2">
          {option.detail}
        </Label>
      )}
    </View>
  )
}

/** A check box, so a multi-pick row shows its state without relying on colour. */
function Box({ chosen }: { chosen: boolean }) {
  const { colors: c } = useTheme()
  return (
    <View
      style={{
        width: 22,
        height: 22,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: 6,
        borderWidth: chosen ? 0 : 1.5,
        borderColor: c.border,
        backgroundColor: chosen ? c.primary : 'transparent',
      }}
    >
      {chosen && (
        <Check pointerEvents="none" size={15} strokeWidth={3} color={c['primary-foreground']} />
      )}
    </View>
  )
}

/** A row on a card that is no longer asking: plain text, with a check beside what was chosen. */
function Closed({ option, chosen }: { option: Ask['options'][number]; chosen: boolean }) {
  const { colors: c } = useTheme()
  return (
    <View
      style={[
        ROW,
        {
          borderRadius: radius.control,
          backgroundColor: chosen ? c['thread-selected'] : 'transparent',
        },
      ]}
    >
      <Words option={option} tone={chosen ? 'ink' : 'ink-2'} />
      {chosen && <Check pointerEvents="none" size={18} color={c['primary-text']} />}
    </View>
  )
}

/**
 * One answer. A multi-pick row carries a check box; a single-pick row carries a chevron, the
 * platform's mark for "this goes on". A card that is no longer asking draws it static.
 */
function Choice({
  option,
  many,
  chosen,
  open,
  onPress,
}: {
  option: Ask['options'][number]
  many: boolean
  chosen: boolean
  open: boolean
  onPress: () => void
}) {
  const { colors: c } = useTheme()
  if (!open) return <Closed option={option} chosen={chosen} />
  return (
    <Press
      accessibilityRole={many ? 'checkbox' : 'button'}
      accessibilityState={{ checked: many ? chosen : undefined }}
      onPress={onPress}
      style={({ pressed }) => [
        ROW,
        {
          borderRadius: radius.control,
          backgroundColor: pressed ? c['wash-pressed'] : c[chosen ? 'accent-soft' : 'surface-2'],
          borderWidth: chosen ? 1 : HAIRLINE,
          borderColor: chosen ? c.primary : c.border,
        },
      ]}
    >
      {many && <Box chosen={chosen} />}
      <Words option={option} tone="ink" />
      {!many && <ChevronRight pointerEvents="none" size={18} color={c.chevron} />}
    </Press>
  )
}
