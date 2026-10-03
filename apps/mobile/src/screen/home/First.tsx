import { Workspace, type MeResponse } from '@vivid/contracts'
import { greetingAt } from '@vivid/state'
import { View } from 'react-native'
import { useNow } from '../../data/foreground'
import { Label } from '../../ui/ui'

/** The Person's first name, when their name has one to take. */
const firstName = (me: MeResponse): string => me.person.name.trim().split(/\s+/u, 1).join('')

/**
 * The inset of everything written on this screen. The composer under it is 12 points from the
 * glass with 16 of padding inside, so its words start at 28; the greeting starts there too, and
 * the screen reads as one column down to the keyboard.
 */
const INSET = 28

/**
 * Home's whole content: a greeting for the hour and one question. There is nothing to set up and
 * nothing to choose; the composer under it is the only thing to do.
 *
 * It is type alone. Vivid's face is the mark at the top of this screen, which is also the way to
 * the drawer, so a second, larger face here would be decoration; the light it used to sit in is
 * gone for the same reason. Suggestion cards were removed by the owner on 3 October 2026.
 *
 * Nothing here moves: the screen is drawn whole.
 */
export function First({ me }: { me: MeResponse }) {
  const name = firstName(me)
  // The hour is the one the app was last brought to the front in, not a ticking clock: a greeting
  // that changed under someone reading it would be a glitch, and one left open overnight should
  // not still say "Evening" when the phone is picked up in the morning.
  const hello = greetingAt(new Date(useNow()).getHours())
  return (
    <View style={{ paddingHorizontal: INSET, paddingBottom: 14 }}>
      <Label accessibilityRole="header" size="opening">
        {name.length === 0 ? `${hello}.` : `${hello}, ${name}.`}
      </Label>
      <Label size="title" tone="ink-2" style={{ marginTop: 6, fontWeight: '400' }}>
        {Workspace.match(me.workspace, {
          Personal: () => 'What should I take off your plate?',
          Company: ({ company }) => `What should I take off your plate at ${company.name}?`,
        })}
      </Label>
    </View>
  )
}
