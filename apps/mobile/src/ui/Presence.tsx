import { MenuView, type MenuAction } from '@react-native-menu/menu'
import { standingWords } from '@vivid/state'
import { nativeMetrics as m } from '@vivid/tokens/native'
import { Option } from 'effect'
import { ChevronDown } from 'lucide-react-native'
import { useSyncExternalStore } from 'react'
import { Platform, StyleSheet, View } from 'react-native'
import Animated, { FadeIn, LayoutAnimationConfig, ReduceMotion } from 'react-native-reanimated'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { ThinkingOrb } from '../../vendor/orb'
import { Stand } from '../data/stand'
import { useAppearance } from '../data/vivid'
import { useTheme } from '../theme'
import { AnimatedGlassMaterial } from './Glass'
import { APPEAR, LEAVE, MORPH } from './motion/morph'
import { Face, Label, TARGET, type Tone } from './ui'

/**
 * Vivid at the top centre of a screen: a capsule of the system's glass holding its face and its
 * name, between the bar's own buttons. It is where a Person looks to see how Vivid is doing, so
 * while Vivid works the capsule widens to the orb and the word for it. Pressing it opens Vivid's
 * own menu: a new Thread, its computer, and what it knows.
 *
 * The buttons either side are the system's bar items (`ui/Bar.tsx`). The capsule is the same
 * material the composer is (`GlassMaterial`, animated here), placed where the bar's title would be: the
 * owner's reference, the ChatGPT iPhone app, has a round glass button at each end of the bar and
 * a glass capsule in the middle, each floating on its own.
 *
 * It is drawn once, over the whole stack (`Presence`), not by each screen under its own bar. A
 * screen's content is under the system's navigation bar, which takes every touch in its frame, so
 * a capsule drawn by the screen could be seen and never pressed; and drawn in the bar's own title
 * slot it could not change shape (the reference found that natively driven animation blanks a
 * view the bar has taken in, `src/features/home/WorkspaceConnectionTitle.tsx`, `StatusFadeIn`).
 * Over the stack it is an ordinary view, as the composer is, and it is the same view on both
 * platforms. The screen in front says what it should show (`capsule`).
 */

/** The word beside the orb. The web says the same beside its own (`apps/web/src/screen/Thread.tsx`). */
const THINKING = 'Thinking…'

/**
 * The capsule's measures. It is as tall as a bar button (44), so it fills the bar exactly as the
 * system's glass buttons do. The face or orb stands in a 24-point slot 10 points in from the
 * leading edge, which is the same 10 it has above and below, so the round end of the capsule is
 * concentric with what it holds. The chevron that says it opens has 14 at the trailing end.
 */
const SLOT = 24
const LEAD_ROOM = (TARGET - SLOT) / 2
const TRAIL_ROOM = 14
const BETWEEN = 8
/** The orb is one of the library's two tuned sizes; it is centred in the face's slot. */
const ORB = 20
/** The chevron is small and quiet: it says "this opens", it is not a second control. */
const CHEVRON = 14

/**
 * The height of the system's bar under the status bar, which the capsule is centred in: 44 points
 * on an iPhone (the reference's own number for a glass bar's room, T3 Code mobile
 * `src/lib/layoutMetrics.ts`, `IOS_NAV_BAR_HEIGHT`), and the 56 of Android's toolbar.
 */
const BAR = Platform.OS === 'ios' ? 44 : 56

/**
 * The capsule's words for each way of standing. Waiting for the Person is said as the web says
 * it (`standingWords`), because nothing else on a Thread does.
 */
const wordsOf = (name: string, stand: Stand): string =>
  Stand.$match(stand, {
    Resting: () => name,
    Thinking: () => THINKING,
    Waiting: () => standingWords.NeedsYou,
    Typing: ({ names }) => `${names.join(', ')} typing…`,
  })

/** The ink those words are in: the state's own where it asks something of the Person. */
const TONE = {
  Resting: 'ink',
  Thinking: 'ink',
  Waiting: 'status-attention',
  Typing: 'ink-2',
} as const satisfies Record<Stand['_tag'], Tone>

/** What a screen reader says for the capsule: Vivid's name, then how it stands. */
const spokenOf = (name: string, stand: Stand): string =>
  Stand.$is('Resting')(stand) ? name : `${name}. ${wordsOf(name, stand)}`

/** What the screen in front says about Vivid, for the one capsule over the stack to show. */
export interface Told {
  readonly stand: Stand
  /** The widest the capsule may be between that screen's bar buttons. */
  readonly limit: number
}

/** A screen's own token, by which what it said is known to be its own. */
export type Speaker = symbol

/** The screen that last spoke, and what it said. Nobody, on a screen that has no capsule. */
let told: Option.Option<{ readonly owner: Speaker; readonly said: Told }> = Option.none()
const heard = new Set<() => void>()

const becomes = (next: typeof told) => {
  told = next
  for (const listener of heard) listener()
}

/**
 * How a screen tells the capsule what to show. It is held outside React because the two are in
 * different parts of the tree: the screen is inside the stack and the capsule is over it. `owner`
 * is the screen's own token, so a screen that leaves can never clear what the next one has
 * already said, whichever of the two React happens to run first.
 */
export const capsule = {
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
 * What takes something's place in the capsule comes in as the old one has nearly gone: the orb
 * for the face, a sentence for the name. Both stand in the same place as what they replace, and
 * fading one in while the other was still strong drew two sentences through each other for a
 * moment (seen frame by frame on a device). What leaves takes 150 ms (`LEAVE`); what arrives
 * waits 90 and takes 180, so the change is over in 270.
 *
 * Nothing travels to the capsule. A disc used to rise to it from the composer's button on every
 * send; the owner did not like the button moving up into Vivid (6 October 2026), so the capsule
 * changes where it stands and the composer's button stays where the thumb left it.
 */
const ARRIVE = FadeIn.duration(180).delay(90).reduceMotion(ReduceMotion.System)

/**
 * What Vivid's menu can hold: a new Thread with it, and the places that are Vivid's own. The
 * shell says which of them there are right now (a new Thread is not offered where one is already
 * being started).
 */
export type Place = 'Fresh' | 'Computer' | 'Memory'

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
 * The capsule itself: glass behind, and in front the face or the orb, the words, and a chevron.
 *
 * It is built as the reference builds its composer's shape (T3 Code mobile `ComposerSurface`,
 * `src/features/threads/ThreadComposer.tsx`): an outline that clips, the passive glass material
 * behind, and the content in front as the material's sibling, all on one layout transition, so
 * the capsule widens around its new words instead of showing them outside itself first. The pieces that change (face for
 * orb, a name for a sentence) are keyed by what they show, so the old one fades out as the new
 * one fades in.
 *
 * It is a button: pressing it opens the system's own menu, anchored to it (`MenuView`, a real
 * `UIMenu` on iOS and a popup menu on Android), so the menu is the platform's and nothing of it
 * is drawn here. The menu appearing under the finger is the press's feedback.
 */
function Capsule({ stand, limit, menu }: { stand: Stand; limit: number; menu: Menu }) {
  const { colors: c, dark } = useTheme()
  const vivid = useAppearance()
  const thinking = Stand.$is('Thinking')(stand)
  const words = wordsOf(vivid.name, stand)
  const mood = Stand.$is('Resting')(stand) ? stand.mood : 'neutral'
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
      <Animated.View
        accessible
        accessibilityRole="button"
        accessibilityLabel={spokenOf(vivid.name, stand)}
        accessibilityHint={`Opens ${vivid.name}’s menu`}
        // Said again when it changes: it is where a Thread says that Vivid has started working,
        // or is now waiting for the Person.
        accessibilityLiveRegion="polite"
        layout={MORPH}
        style={{
          height: TARGET,
          maxWidth: limit,
          borderRadius: TARGET / 2,
          borderCurve: 'continuous',
          overflow: 'hidden',
          // Lighter than the composer's: a small shape beside the system's own buttons, which
          // the system lifts only a little.
          boxShadow: dark ? '0 4px 16px rgba(0, 0, 0, 0.28)' : '0 4px 16px rgba(0, 0, 0, 0.1)',
        }}
      >
        <AnimatedGlassMaterial
          layout={MORPH}
          style={[StyleSheet.absoluteFill, { borderRadius: TARGET / 2, borderCurve: 'continuous' }]}
        />
        <Animated.View
          collapsable={false}
          layout={MORPH}
          style={{
            height: TARGET,
            flexDirection: 'row',
            alignItems: 'center',
            gap: BETWEEN,
            paddingLeft: LEAD_ROOM,
            paddingRight: TRAIL_ROOM,
          }}
        >
          {/* Drawn whole the first time: the capsule does not fade its own contents in. */}
          <LayoutAnimationConfig skipEntering>
            <View
              style={{ width: SLOT, height: SLOT, alignItems: 'center', justifyContent: 'center' }}
            >
              {thinking ? (
                <Animated.View key="orb" entering={ARRIVE} exiting={LEAVE}>
                  {/* The words beside it name it, so a screen reader is not told twice. */}
                  <ThinkingOrb
                    state="breathing"
                    size={ORB}
                    theme={dark ? 'dark' : 'light'}
                    accessibilityLabel=""
                  />
                </Animated.View>
              ) : (
                <Animated.View key="face" entering={ARRIVE} exiting={LEAVE}>
                  <Face size={SLOT} mood={mood} label="" />
                </Animated.View>
              )}
            </View>
            <Animated.View
              key={words}
              entering={ARRIVE}
              exiting={LEAVE}
              // The words give way when the capsule has less room than they need.
              style={{ flexShrink: 1, minWidth: 0 }}
            >
              <Label
                numberOfLines={1}
                // The capsule is as tall as a bar button whatever the text size, as the system's
                // own bar is, so its words grow with the Person's setting only as far as they fit.
                maxFontSizeMultiplier={1.3}
                tone={TONE[stand._tag]}
                style={{ fontWeight: m['weight-strong'], lineHeight: SLOT }}
              >
                {words}
              </Label>
            </Animated.View>
          </LayoutAnimationConfig>
          <Animated.View layout={MORPH}>
            <ChevronDown pointerEvents="none" size={CHEVRON} strokeWidth={2.4} color={c['ink-3']} />
          </Animated.View>
        </Animated.View>
      </Animated.View>
    </MenuView>
  )
}

/** Vivid's menu: what is in it right now, and where each row leads. */
export interface Menu {
  readonly places: ReadonlyArray<Place>
  readonly onGo: (place: Place) => void
}

/**
 * The capsule in its place over the stack: centred in the bar's own height, under the status
 * bar. The layer is that strip and no more, and takes no touches of its own, so the bar's buttons
 * either side of the capsule are still the system's to press.
 */
function Floating({ said, menu }: { said: Told; menu: Menu }) {
  const insets = useSafeAreaInsets()
  return (
    <Animated.View
      pointerEvents="box-none"
      // It arrives and leaves with the screens that have it, quicker going than coming.
      entering={APPEAR}
      exiting={LEAVE}
      style={{
        position: 'absolute',
        top: insets.top,
        left: 0,
        right: 0,
        height: BAR,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Capsule stand={said.stand} limit={said.limit} menu={menu} />
    </Animated.View>
  )
}

/**
 * Vivid's capsule over the stack, for as long as the screen in front has one: the first screen
 * says how Vivid stands (`VividBar`), and every other screen says nothing, so there it is not
 * drawn. It is put after the stack and inside the drawer's page, so it is over the system's bar
 * and under an open drawer.
 */
export function Presence({ menu }: { menu: Menu }) {
  const now = useSyncExternalStore(listen, spoken, spoken)
  if (Option.isNone(now)) return null
  return <Floating said={now.value.said} menu={menu} />
}
