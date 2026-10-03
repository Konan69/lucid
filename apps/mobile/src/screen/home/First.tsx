import { Workspace, type MeResponse } from '@vivid/contracts'
import { greetingAt } from '@vivid/state'
import { useId } from 'react'
import { View } from 'react-native'
import Svg, { Circle, Defs, RadialGradient, Stop } from 'react-native-svg'
import { useNow } from '../../data/foreground'
import { useTheme } from '../../theme'
import { Face, Label } from '../../ui/ui'

/** The Person's first name, when their name has one to take. */
const firstName = (me: MeResponse): string => me.person.name.trim().split(/\s+/u, 1).join('')

/** Vivid's face on this screen: large, because here it is who the Person is talking to. */
const FACE = 64

/** How far the light around the face reaches past it on every side. */
const REACH = 40

/**
 * The inset of everything written on this screen. The composer under it is 12 points from the
 * glass with 16 of padding inside, so its words start at 28; the face and the greeting start
 * there too, and the screen reads as one column down to the keyboard.
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
 * What the first screen shows before there is any Thread: Vivid and a greeting for the hour.
 * There is nothing to set up and nothing to choose; the composer is the only thing to do.
 *
 * It showed suggestion cards and a "More ideas" row above the composer. The owner removed them
 * on 3 October 2026: they read as filler between the greeting and the field.
 *
 * The web puts its composer in the middle of the page, under the greeting, because there writing
 * is the only thing to do. On a phone the composer belongs on the keyboard, under the thumb, so
 * this screen comes down to meet it instead: Home sets it at the foot of the screen, directly
 * above the composer, and the greeting and the field are one column.
 *
 * Nothing here moves: the screen is drawn whole.
 */
export function First({
  me,
  sending,
}: {
  me: MeResponse
  /** The Person's first words are on their way to Vivid, which is already thinking about them. */
  sending: boolean
}) {
  const name = firstName(me)
  // The hour is the one the app was last brought to the front in, not a ticking clock: a greeting
  // that changed under someone reading it would be a glitch, and one left open overnight should
  // not still say "Evening" when the phone is picked up in the morning.
  const hello = greetingAt(new Date(useNow()).getHours())
  return (
    <View style={{ paddingHorizontal: EDGE, paddingTop: 32, paddingBottom: 4 }}>
      <View style={{ paddingHorizontal: INSET }}>
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
      </View>
    </View>
  )
}
