import { MenuView, type MenuAction } from '@react-native-menu/menu'
import { standingWords } from '@vivid/state'
import { nativeMetrics as m } from '@vivid/tokens/native'
import { Option } from 'effect'
import { ChevronDown } from 'lucide-react-native'
import { useSyncExternalStore, type ReactNode } from 'react'
import { Platform, useWindowDimensions, View } from 'react-native'
import Animated, { FadeIn, LayoutAnimationConfig, ReduceMotion } from 'react-native-reanimated'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Stand } from '../data/stand'
import { useAppearance } from '../data/vivid'
import { useTheme } from '../theme'
import { cast, lifted } from './elevation'
import { APPEAR, LEAVE } from './motion/morph'
import { Face, Label, TARGET, type Tone } from './ui'

/**
 * Vivid at the top centre of a Thread: its face, large, with its name in a small pill under
 * it, between the bar's own buttons. The pill says how Vivid stands with the Person: under its
 * own name, waiting for them, or who else is writing. That Vivid is at work is said just above
 * the composer (`ui/Thinking.tsx`); here it only changes the mood of the face. Pressing either
 * opens Vivid's own menu: a new Thread, its computer, and what it knows.
 *
 * The arrangement is the owner's two references of 6 October 2026: the "dot" phone app (a round
 * menu button, a large round avatar in the top centre with a pill under it that holds the name,
 * a round call button) and OpenMuse (`refs/openmuse/apps/mobile/App.tsx`, the header's `Mascot`
 * at 49 points over the name). It was one capsule the height of a bar button, holding a small
 * face beside the name. On a screen with no conversation yet the avatar is not up here at all:
 * it stands in the middle of the page, over the greeting (`Opening`, `screen/home/First.tsx`),
 * where his third reference, the Claude iPhone app, has its mark.
 *
 * It is drawn once, over the whole stack (`Presence`), not by each screen under its own bar. A
 * screen's content is under the system's navigation bar, which takes every touch in its frame, so
 * an avatar drawn by the screen could be seen and never pressed; and drawn in the bar's own title
 * slot it could not change shape (the reference found that natively driven animation blanks a
 * view the bar has taken in, `src/features/home/WorkspaceConnectionTitle.tsx`, `StatusFadeIn`).
 * Over the stack it is an ordinary view, the same on both platforms. The screen in front says
 * what it should show (`presence`), and a screen that says nothing has none.
 */

/**
 * The measures. The avatar is a little larger than a bar button, as both references have it, and
 * starts level with the buttons' top, so it hangs below their row; the pill is under it.
 */
const AVATAR = 52
const PILL = 30
const BETWEEN = 4
/** The chevron is small and quiet: it says "this opens", it is not a second control. */
const CHEVRON = 12

/**
 * The height of the system's bar under the status bar: 44 points on an iPhone (the reference's
 * own number for a glass bar's room, T3 Code mobile `src/lib/layoutMetrics.ts`,
 * `IOS_NAV_BAR_HEIGHT`), and the 56 of Android's toolbar, whose buttons are 44 in the middle of it.
 */
const BAR = Platform.OS === 'ios' ? 44 : 56
const ABOVE = (BAR - TARGET) / 2

/**
 * How far Vivid hangs below the bar, in points. A Thread keeps this much clear at the top of its
 * conversation, so its oldest words can be read under the name and not behind it.
 */
export const HANG = ABOVE + AVATAR + BETWEEN + PILL - BAR

/**
 * The pill's words for each way of standing. Waiting for the Person is said as the web says it
 * (`standingWords`), because nothing else on a Thread does.
 */
const wordsOf = (name: string, stand: Stand): string =>
  Stand.$match(stand, {
    Resting: () => name,
    Waiting: () => standingWords.NeedsYou,
    Typing: ({ names }) => `${names.join(', ')} typing…`,
  })

/** The ink those words are in: the state's own where it asks something of the Person. */
const TONE = {
  Resting: 'ink',
  Waiting: 'status-attention',
  Typing: 'ink-2',
} as const satisfies Record<Stand['_tag'], Tone>

/** What a screen reader says: Vivid's name, then how it stands. */
const spokenOf = (name: string, stand: Stand): string =>
  Stand.$is('Resting')(stand) ? name : `${name}. ${wordsOf(name, stand)}`

/** What the Thread in front says about Vivid, for the one avatar over the stack to show. */
export interface Told {
  readonly stand: Stand
}

/** A screen's own token, by which what it said is known to be its own. */
export type Speaker = symbol

/** The screen that last spoke, and what it said. Nobody, on a screen that has no avatar up here. */
let told: Option.Option<{ readonly owner: Speaker; readonly said: Told }> = Option.none()
const heard = new Set<() => void>()

const becomes = (next: typeof told) => {
  told = next
  for (const listener of heard) listener()
}

/**
 * How a screen tells the avatar over the stack what to show. It is held outside React because the
 * two are in different parts of the tree: the screen is inside the stack and the avatar is over
 * it. `owner` is the screen's own token, so a screen that leaves can never clear what the next
 * one has already said, whichever of the two React happens to run first.
 */
export const presence = {
  say: (owner: Speaker, said: Told) => becomes(Option.some({ owner, said })),
  leave: (owner: Speaker) => {
    if (Option.isSome(told) && told.value.owner === owner) becomes(Option.none())
  },
}

const listen = (listener: () => void) => {
  heard.add(listener)
  return () => {
    heard.delete(listener)
  }
}
const spoken = () => told

/**
 * New words come in as the old ones have nearly gone. Both stand in the same place, and fading
 * one in while the other was still strong drew two sentences through each other for a moment
 * (seen frame by frame on a device). The old words leave in 150 ms (`LEAVE`); these wait 90 and
 * take 180, so the change is over in 270.
 */
const ARRIVE = FadeIn.duration(180).delay(90).reduceMotion(ReduceMotion.System)

/**
 * What Vivid's menu can hold: a new Thread with it, and the places that are Vivid's own. Whoever
 * draws the menu says which of them there are right now (a new Thread is not offered where one
 * is already being started).
 */
export type Place = 'Fresh' | 'Computer' | 'Memory'

/** Vivid's menu: what is in it right now, and where each row leads. */
export interface Menu {
  readonly places: ReadonlyArray<Place>
  readonly onGo: (place: Place) => void
}

/** The rows of Vivid's menu, in order. One list each, so a render does not make a new one. */
export const IN_THREAD: ReadonlyArray<Place> = ['Fresh', 'Computer', 'Memory']
export const ON_GREETING: ReadonlyArray<Place> = ['Computer', 'Memory']

/** The system's symbol for each row of the menu. */
const SYMBOL = {
  Fresh: 'square.and.pencil',
  Computer: 'desktopcomputer',
  Memory: 'brain',
} as const satisfies Record<Place, string>

/** Each row's words, with the name the Person gave Vivid. */
const titleOf = (place: Place, name: string): string =>
  ({
    Fresh: 'New thread',
    Computer: `${name}’s computer`,
    Memory: `What ${name} knows`,
  })[place]

/**
 * One row of the menu. iOS draws the system's symbols by name; Android's menu takes a drawable
 * from the app's own resources, of which it has none for these, so there a row is its words.
 */
const rowFor = (place: Place, title: string): MenuAction =>
  Platform.OS === 'ios' ? { id: place, title, image: SYMBOL[place] } : { id: place, title }

/**
 * Vivid's menu around whatever is pressed to open it: its avatar at the top of a Thread, or the
 * one in the middle of a page with no conversation yet. It is the system's own menu, anchored to
 * what it wraps (`MenuView`, a real `UIMenu` on iOS and a popup menu on Android), so nothing of
 * it is drawn here, and the menu appearing under the finger is the press's feedback.
 */
export function VividMenu({ menu, children }: { menu: Menu; children: ReactNode }) {
  const { dark } = useTheme()
  const vivid = useAppearance()
  return (
    <MenuView
      themeVariant={dark ? 'dark' : 'light'}
      actions={menu.places.map((place) => rowFor(place, titleOf(place, vivid.name)))}
      onPressAction={({ nativeEvent }) => {
        // The menu answers with a row's id, which is text: it is one of these places or nothing.
        const chosen = menu.places.find((place) => place === nativeEvent.event)
        if (chosen !== undefined) menu.onGo(chosen)
      }}
    >
      {children}
    </MenuView>
  )
}

/**
 * The avatar and the pill under it.
 *
 * The pill is an opaque bubble in the colour of the Person's own messages, with the compact
 * tier's ring and stack. It was the system's clear glass, as the composer is, and the
 * conversation that runs behind it showed through so much that the owner read it as fully
 * transparent (26 October 2026). The words are keyed by what they say, so the old ones fade out
 * as the new ones fade in; the face only changes its expression.
 *
 * The pill takes its new width at once. It used to ease to it on a layout transition, as the
 * reference's shape does, and on a device that sometimes left it at the old width with the new
 * words cut off ("Waiting fo", an Android emulator, 6 October 2026): the words change while the
 * layer is still arriving, and the transition then starts from a frame that is not the one
 * drawn. A pill that is always as wide as its words is worth more than one that glides there.
 */
function Avatar({ stand }: { stand: Stand }) {
  const { colors: c } = useTheme()
  const vivid = useAppearance()
  const window = useWindowDimensions().width
  const words = wordsOf(vivid.name, stand)
  const mood = Stand.$is('Resting')(stand) ? stand.mood : 'neutral'
  return (
    <View
      accessible
      accessibilityRole="button"
      accessibilityLabel={spokenOf(vivid.name, stand)}
      accessibilityHint={`Opens ${vivid.name}’s menu`}
      // Said again when it changes: it is where a Thread says that Vivid is now waiting for the
      // Person, or that someone else is writing.
      accessibilityLiveRegion="polite"
      style={{ alignItems: 'center' }}
    >
      <View
        // A solid disc is its own edge, so it takes the compact tier's stack with no ring.
        style={[{ width: AVATAR, height: AVATAR, borderRadius: AVATAR / 2 }, cast('sm')]}
      >
        <Face size={AVATAR} mood={mood} label="" />
      </View>
      <View
        style={[
          {
            marginTop: BETWEEN,
            height: PILL,
            // Under the bar's buttons, not between them, so only the window limits it.
            maxWidth: window - 96,
            borderRadius: PILL / 2,
            borderCurve: 'continuous',
            backgroundColor: c['user-bubble'],
          },
          lifted('sm', c.border),
        ]}
      >
        <View
          style={{
            height: PILL,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 4,
            paddingLeft: 12,
            paddingRight: 8,
          }}
        >
          {/* Drawn whole the first time: the pill does not fade its own words in. */}
          <LayoutAnimationConfig skipEntering>
            <Animated.View
              key={words}
              entering={ARRIVE}
              exiting={LEAVE}
              // The words give way when the pill has less room than they need.
              style={{ flexShrink: 1, minWidth: 0 }}
            >
              <Label
                numberOfLines={1}
                size="footnote"
                // The pill keeps its height whatever the text size, as the system's own bar
                // does, so its words grow with the Person's setting only as far as they fit.
                maxFontSizeMultiplier={1.3}
                tone={TONE[stand._tag]}
                style={{ fontWeight: m['weight-strong'] }}
              >
                {words}
              </Label>
            </Animated.View>
          </LayoutAnimationConfig>
          <ChevronDown pointerEvents="none" size={CHEVRON} strokeWidth={2.4} color={c['ink-3']} />
        </View>
      </View>
    </View>
  )
}

/**
 * Vivid in its place over the stack: centred, its top level with the bar's buttons. The layer is
 * as tall as what it holds and takes no touches of its own, so the bar's buttons either side are
 * still the system's to press.
 */
function Floating({ said, menu }: { said: Told; menu: Menu }) {
  const insets = useSafeAreaInsets()
  return (
    <Animated.View
      pointerEvents="box-none"
      // It fades in with the screen that has it, and is gone at once when that screen gives it
      // up: an empty page draws Vivid in its own middle from the same frame, and a fading
      // avatar here would be a second one for a moment.
      entering={APPEAR}
      style={{
        position: 'absolute',
        top: insets.top + ABOVE,
        left: 0,
        right: 0,
        alignItems: 'center',
      }}
    >
      <VividMenu menu={menu}>
        <Avatar stand={said.stand} />
      </VividMenu>
    </Animated.View>
  )
}

/**
 * Vivid over the stack, for as long as the screen in front has it there: a Thread says how Vivid
 * stands (`VividAtTop`), and every other screen says nothing, so there it is not drawn. It is
 * put after the stack and inside the drawer's page, so it is over the system's bar and under an
 * open drawer.
 */
export function Presence({ menu }: { menu: Menu }) {
  const now = useSyncExternalStore(listen, spoken, spoken)
  if (Option.isNone(now)) return null
  return <Floating said={now.value.said} menu={menu} />
}
