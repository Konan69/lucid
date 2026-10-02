import { Workspace, type MeResponse, type Suggestion } from '@vivid/contracts'
import { greetingAt } from '@vivid/state'
import { useId } from 'react'
import { View } from 'react-native'
import Svg, { Circle, Defs, RadialGradient, Stop } from 'react-native-svg'
import { ArrowDownLeft } from 'lucide-react-native'
import { useNow } from '../../data/foreground'
import { tick } from '../../data/haptics'
import { useTheme } from '../../theme'
import { Rise } from '../../ui/motion/Rise'
import { Face, HAIRLINE, Label, Press, radius } from '../../ui/ui'

/** The Person's first name, when their name has one to take. */
const firstName = (me: MeResponse): string => me.person.name.trim().split(/\s+/u, 1).join('')

/** Vivid's face on this screen: large, because here it is who the Person is talking to. */
const FACE = 64

/** How far the light around the face reaches past it on every side. */
const REACH = 40

/**
 * The inset of everything written on this screen. The suggestions and the composer under them
 * are 12 points from the glass with 16 of padding inside, so their words start at 28; the face
 * and the greeting start there too, and the screen reads as one column down to the keyboard.
 */
const EDGE = 12
const INSET = 16

/**
 * The soft light Vivid sits in on the first screen: one radial of its own colour, drawn once.
 * It does not move. The strength is `accent-soft`'s in each palette; a gradient stop takes its
 * colour and its opacity apart, so the token's own alpha cannot be handed to it whole.
 */
function Aura() {
  const { colors: c, dark } = useTheme()
  // `useId` embeds colons, which are not legal in an SVG fragment identifier.
  const id = useId().replace(/:/g, '')
  const size = FACE + REACH * 2
  return (
    <Svg
      width={size}
      height={size}
      pointerEvents="none"
      style={{ position: 'absolute', left: -REACH, top: -REACH }}
    >
      <Defs>
        <RadialGradient id={id} cx="50%" cy="50%" r="50%">
          <Stop offset="0" stopColor={c.accent} stopOpacity={dark ? 0.18 : 0.12} />
          <Stop offset="1" stopColor={c.accent} stopOpacity={0} />
        </RadialGradient>
      </Defs>
      <Circle cx={size / 2} cy={size / 2} r={size / 2} fill={`url(#${id})`} />
    </Svg>
  )
}

/**
 * What the first screen shows before there is any Thread: Vivid, a greeting for the hour, and
 * things the Person could say. There is nothing to set up and nothing to choose. The suggestions
 * are the server's, drawn from this Person's own Tasks, Routines and Library; choosing one puts
 * its words in the composer, where they can be changed before they are sent.
 *
 * The web puts its composer in the middle of the page, under the greeting, because there writing
 * is the only thing to do. On a phone the composer belongs on the keyboard, under the thumb, so
 * this screen comes down to meet it instead: Home sets it at the foot of the screen, directly
 * above the composer, and the greeting, the suggestions and the field are one column.
 *
 * It arrives in the order it is read (the greeting, then each suggestion a beat after the one
 * before), once, when the screen opens. That is `Rise`; nothing here moves afterwards.
 */
export function First({
  me,
  suggestions,
  sending,
  onChoose,
}: {
  me: MeResponse
  suggestions: ReadonlyArray<Suggestion>
  /** The Person's first words are on their way to Vivid, which is already thinking about them. */
  sending: boolean
  onChoose: (text: string) => void
}) {
  const { colors: c } = useTheme()
  const name = firstName(me)
  // The hour is the one the app was last brought to the front in, not a ticking clock: a greeting
  // that changed under someone reading it would be a glitch, and one left open overnight should
  // not still say "Evening" when the phone is picked up in the morning.
  const hello = greetingAt(new Date(useNow()).getHours())
  return (
    <View style={{ paddingHorizontal: EDGE, paddingTop: 32, paddingBottom: 4 }}>
      <Rise place={0} style={{ paddingHorizontal: INSET }}>
        <View style={{ width: FACE, height: FACE }}>
          <Aura />
          <Face size={FACE} mood={sending ? 'thinking' : 'happy'} />
        </View>
        <Label accessibilityRole="header" size="opening" style={{ marginTop: 22 }}>
          {name.length === 0 ? `${hello}.` : `${hello}, ${name}.`}
        </Label>
        <Label size="title" tone="ink-3" style={{ marginTop: 6, fontWeight: '400' }}>
          {Workspace.match(me.workspace, {
            Personal: () => 'What should I take off your plate?',
            Company: ({ company }) => `What should I take off your plate at ${company.name}?`,
          })}
        </Label>
      </Rise>
      <View style={{ marginTop: 26, gap: 8 }}>
        {suggestions.map((suggestion, position) => (
          <Rise key={suggestion.text} place={position + 1}>
            <Press
              accessibilityRole="button"
              accessibilityHint="Puts this in the message field"
              onPress={() => {
                // Felt as well as seen: the words land in the field under the thumb.
                tick()
                onChoose(suggestion.text)
              }}
              style={({ pressed }) => ({
                flexDirection: 'row',
                alignItems: 'flex-start',
                gap: 12,
                paddingHorizontal: INSET,
                paddingVertical: 14,
                borderRadius: radius.card,
                borderWidth: HAIRLINE,
                borderColor: c['line-2'],
                backgroundColor: pressed ? c['surface-3'] : c['surface-2'],
              })}
            >
              <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
                <Label size="body" style={{ fontWeight: '500' }}>
                  {suggestion.text}
                </Label>
                <Label size="label" tone="ink-3">
                  {suggestion.reason}
                </Label>
              </View>
              {/* Points at the field the words go to, the way a phone's own search suggestions
                  mark "put this in the field" apart from "go". */}
              <ArrowDownLeft
                pointerEvents="none"
                size={16}
                strokeWidth={1.8}
                color={c['ink-4']}
                style={{ marginTop: 3 }}
              />
            </Press>
          </Rise>
        ))}
      </View>
    </View>
  )
}
