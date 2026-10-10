import { Workspace, type MeResponse } from '@vivid/contracts'
import { greetingAt } from '@vivid/state'
import { View } from 'react-native'
import Animated from 'react-native-reanimated'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { arrive } from '../../data/computer'
import { useNow } from '../../data/foreground'
import { useLiveData } from '../../data/live'
import { useAppearance } from '../../data/vivid'
import { APPEAR } from '../../ui/motion/morph'
import { ON_GREETING, VividMenu, type Menu } from '../../ui/Presence'
import { Face, Label } from '../../ui/ui'
import { useFront, useGo } from '../../workspace'

/** The Person's first name, when their name has one to take. */
const firstName = (me: MeResponse): string => me.person.name.trim().split(/\s+/u, 1).join('')

/** Vivid's face over the greeting: large enough to be the page's picture, not a row's mark. */
const FACE = 56

/**
 * A page with no conversation on it yet: Vivid's face, a line in the opening type and, under it,
 * a quieter one, all centred in the room the page has. It is the first screen's greeting and an
 * empty Thread's invitation, so the two read as the same place.
 *
 * The arrangement is the owner's reference for an empty first screen, the Claude iPhone app (its
 * mark over "Happy Tuesday, Konan", centred, with the composer at the foot; his screenshot of
 * 6 October 2026). It used to be type alone, set at the foot of the page above the composer, with
 * the rest of the screen bare. While a page is this, Vivid is not also at the top of the screen:
 * its avatar floats there only over a conversation (`VividAtTop`, `ui/Bar.tsx`).
 *
 * The face is the way to Vivid's own menu here, as its avatar at the top of a Thread is: its
 * computer and what it knows. A new Thread is not offered, because this page is one being started.
 *
 * Nothing here moves: the page is drawn whole. `mood` is the face's expression.
 */
export function Opening({
  mood,
  title,
  line,
}: {
  mood: 'happy' | 'thinking'
  title: string
  line?: string
}) {
  const vivid = useAppearance()
  const go = useGo()
  const front = useFront()
  const data = useLiveData()
  const menu: Menu = {
    places: ON_GREETING,
    onGo: (place) => {
      if (place === 'Fresh') return front.fresh()
      if (place === 'Computer') arrive(data)
      go.navigate(place)
    },
  }
  return (
    <View
      style={{
        flexGrow: 1,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: 28,
        // A little above the middle of the room, which is where a lone block reads as centred.
        paddingBottom: 48,
      }}
    >
      <VividMenu menu={menu}>
        <View
          accessible
          accessibilityRole="button"
          accessibilityLabel={vivid.name}
          accessibilityHint={`Opens ${vivid.name}’s menu`}
        >
          <Face size={FACE} mood={mood} label="" />
        </View>
      </VividMenu>
      <Label
        accessibilityRole="header"
        size="opening"
        style={{ marginTop: 20, textAlign: 'center' }}
      >
        {title}
      </Label>
      {line !== undefined && (
        <Label
          size="title"
          tone="ink-2"
          textBreakStrategy="balanced"
          style={{ marginTop: 6, fontWeight: '400', textAlign: 'center', maxWidth: 320 }}
        >
          {line}
        </Label>
      )}
    </View>
  )
}

/**
 * Home's whole content for someone Vivid has met: a greeting for the hour and one question. There
 * is nothing to set up and nothing to choose; the composer under it is the only thing to do.
 *
 * Someone Vivid has not met never sees it. The server opens their first Thread and Vivid speaks
 * first there, for real (`data/arrival.ts`); until that Thread is open Home is `Waiting`. This
 * greeting is what Home is afterwards, and what it is if that Thread could not be opened.
 *
 * Suggestion cards were removed by the owner on 3 October 2026.
 */
export function First({ me, mood }: { me: MeResponse; mood: 'happy' | 'thinking' }) {
  const name = firstName(me)
  // The hour is the one the app was last brought to the front in, not a ticking clock: a greeting
  // that changed under someone reading it would be a glitch, and one left open overnight should
  // not still say "Evening" when the phone is picked up in the morning.
  const hello = greetingAt(new Date(useNow()).getHours())
  return (
    <Opening
      mood={mood}
      title={name.length === 0 ? `${hello}.` : `${hello}, ${name}.`}
      line={Workspace.match(me.workspace, {
        Personal: () => 'What should I take off your plate?',
        Company: ({ company }) => `What should I take off your plate at ${company.name}?`,
      })}
    />
  )
}

/**
 * About the room the composer takes at the foot of Home, without the safe area under it. The
 * waiting face is centred in what is left above it, so it stands where the eye already is when
 * the Thread opens and not in the middle of the bare glass.
 */
const COMPOSER_ROOM = 64

/**
 * Home while a Person's first Thread is being opened: Vivid's face alone, thinking. There is no
 * greeting and nowhere to type, because Vivid is about to speak first and anything typed here
 * would start a second Thread beside the one being opened.
 *
 * It is the face the app shows while it connects (`App.tsx`), at the same size, so launching into
 * a first arrival reads as one wait and not two screens. The face fades in once and nothing else
 * moves; with reduced motion it is simply there.
 */
export function Waiting() {
  const insets = useSafeAreaInsets()
  return (
    <View
      // One thing to a screen reader: that the app is busy, not a picture inside a container.
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel="Loading"
      accessibilityState={{ busy: true }}
      style={{
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        paddingBottom: insets.bottom + COMPOSER_ROOM,
      }}
    >
      <Animated.View entering={APPEAR}>
        <Face size={44} mood="thinking" />
      </Animated.View>
    </View>
  )
}
