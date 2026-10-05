import { MenuView, type MenuAction } from '@react-native-menu/menu'
import { standingWords } from '@vivid/state'
import { nativeMetrics as m } from '@vivid/tokens/native'
import { Option } from 'effect'
import { ChevronDown } from 'lucide-react-native'
import { useSyncExternalStore } from 'react'
import { Platform, StyleSheet, View } from 'react-native'
import Animated, {
  Easing,
  FadeIn,
  interpolate,
  LayoutAnimationConfig,
  measure,
  ReduceMotion,
  useAnimatedReaction,
  useAnimatedRef,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
  type AnimatedRef,
  type SharedValue,
} from 'react-native-reanimated'
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
 * while Vivid works the capsule widens to the orb and the word for it, and what the Person sends
 * rises to it from the composer. Pressing it opens Vivid's own menu: its computer, and what it
 * knows.
 *
 * The buttons either side are the system's bar items (`ui/Bar.tsx`). The capsule is the same
 * material the composer is (`AnimatedGlassMaterial`), placed where the bar's title would be: the
 * owner's reference, the ChatGPT iPhone app, has a round glass button at each end of the bar and
 * a glass capsule in the middle, each floating on its own.
 *
 * It is drawn once, over the whole stack (`Presence`), not by each screen under its own bar. A
 * screen's content is under the system's navigation bar, which takes every touch in its frame, so
 * a capsule drawn by the screen could be seen and never pressed; and drawn in the bar's own title
 * slot it could not change shape (the reference found that natively driven animation blanks a
 * view the bar has taken in, `src/features/home/WorkspaceConnectionTitle.tsx`, `StatusFadeIn`).
 * Over the stack it is an ordinary view, as the composer is, and it is the same view on both
 * platforms. The screen in front says what it should show (`fronting`).
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

/**
 * Where "thinking" leaves from: the composer's button, and each time the Person sends with it.
 * A screen makes one (`useOrigin`) and hands it to its composer, which puts `button` on the
 * button's round and counts a send in `sends`, and to its bar, which passes it on to the capsule.
 *
 * It is the send that starts the flight, not Vivid's state. A Thread that opens with Vivid
 * already at work, or that Vivid starts on by itself, has had nothing leave its composer; and the
 * Person's press is felt at once, before any server has said that Vivid is working.
 */
export interface Origin {
  readonly button: AnimatedRef<Animated.View>
  readonly sends: SharedValue<number>
}

/** One screen's origin. Both parts keep their identity for as long as the screen is mounted. */
export function useOrigin(): Origin {
  const button = useAnimatedRef<Animated.View>()
  const sends = useSharedValue(0)
  return { button, sends }
}

/** What the screen in front says about Vivid, for the one capsule over the stack to show. */
export interface Front {
  readonly stand: Stand
  readonly origin: Origin
  /** The widest the capsule may be between that screen's bar buttons. */
  readonly limit: number
}

/** A screen's own token, by which what it said is known to be its own. */
export type Speaker = symbol

/** The screen that last spoke, and what it said. Nobody, on a screen that has no capsule. */
let front: Option.Option<{ readonly owner: Speaker; readonly said: Front }> = Option.none()
const heard = new Set<() => void>()

const becomes = (next: typeof front) => {
  front = next
  for (const listener of heard) listener()
}

/**
 * How a screen tells the capsule what to show. It is held outside React because the two are in
 * different parts of the tree: the screen is inside the stack and the capsule is over it. `owner`
 * is the screen's own token, so a screen that leaves can never clear what the next one has
 * already said, whichever of the two React happens to run first.
 */
export const fronting = {
  say: (owner: Speaker, said: Front) => becomes(Option.some({ owner, said })),
  leave: (owner: Speaker) => {
    if (Option.isSome(front) && front.value.owner === owner) becomes(Option.none())
  },
}

const listen = (listener: () => void) => {
  heard.add(listener)
  return () => {
    heard.delete(listener)
  }
}
const spoken = () => front

/** The orb comes in as the disc that rose from the composer reaches it, never before it. */
const LAND = FadeIn.duration(180).delay(140).reduceMotion(ReduceMotion.System)

/** What Vivid's menu holds: the places that are Vivid's own. */
export type Place = 'Computer' | 'Memory'

/** The system's symbol for each place in the menu. */
const SYMBOL = {
  Computer: 'desktopcomputer',
  Memory: 'brain',
} as const satisfies Record<Place, string>

/**
 * One row of the menu. iOS draws the system's symbols by name; Android's menu takes a drawable
 * from the app's own resources, of which it has none for these, so there a row is its words.
 */
const rowFor = (place: Place, title: string): MenuAction =>
  Platform.OS === 'ios' ? { id: place, title, image: SYMBOL[place] } : { id: place, title }

/**
 * The capsule itself: glass behind, and in front the face or the orb, the words, and a chevron.
 *
 * It is built as the composer's shape is (`ui/Composer.tsx`, `Surface`; the reference's
 * `ComposerSurface`): an outline that clips, the passive glass material behind, and the content
 * in front as the material's sibling, all on one layout transition, so the capsule widens around
 * its new words instead of showing them outside itself first. The pieces that change (face for
 * orb, a name for a sentence) are keyed by what they show, so the old one fades out as the new
 * one fades in.
 *
 * It is a button: pressing it opens the system's own menu, anchored to it (`MenuView`, a real
 * `UIMenu` on iOS and a popup menu on Android), so the menu is the platform's and nothing of it
 * is drawn here. The menu appearing under the finger is the press's feedback.
 *
 * `slot` is where the face or the orb stands, for the disc that flies to it.
 */
function Capsule({
  stand,
  limit,
  slot,
  onGo,
}: {
  stand: Stand
  limit: number
  slot: AnimatedRef<Animated.View>
  onGo: (place: Place) => void
}) {
  const { colors: c, dark } = useTheme()
  const vivid = useAppearance()
  const thinking = Stand.$is('Thinking')(stand)
  const words = wordsOf(vivid.name, stand)
  const mood = Stand.$is('Resting')(stand) ? stand.mood : 'neutral'
  return (
    <MenuView
      themeVariant={dark ? 'dark' : 'light'}
      actions={[
        rowFor('Computer', `${vivid.name}’s computer`),
        rowFor('Memory', `What ${vivid.name} knows`),
      ]}
      onPressAction={({ nativeEvent }) => {
        if (nativeEvent.event === 'Computer' || nativeEvent.event === 'Memory') {
          onGo(nativeEvent.event)
        }
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
            <Animated.View
              ref={slot}
              // Kept as a view of its own, so there is always something to measure.
              collapsable={false}
              style={{ width: SLOT, height: SLOT, alignItems: 'center', justifyContent: 'center' }}
            >
              {thinking ? (
                <Animated.View key="orb" entering={LAND} exiting={LEAVE}>
                  {/* The words beside it name it, so a screen reader is not told twice. */}
                  <ThinkingOrb
                    state="breathing"
                    size={ORB}
                    theme={dark ? 'dark' : 'light'}
                    accessibilityLabel=""
                  />
                </Animated.View>
              ) : (
                <Animated.View key="face" entering={APPEAR} exiting={LEAVE}>
                  <Face size={SLOT} mood={mood} label="" />
                </Animated.View>
              )}
            </Animated.View>
            <Animated.View
              key={words}
              entering={APPEAR}
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

/** The round the composer's button is drawn as (`ui/Composer.tsx`), which is what leaves it. */
const DISC = 30

/**
 * How the disc travels: one timed movement that starts fast and settles, in three tenths of a
 * second, which is the most the design stack gives anything in the interface. Nothing threw it,
 * so it is not on a spring, and it never starts slowly: the Person has just pressed send and is
 * watching. The curve is the strong ease-out the stack names for anything that arrives.
 */
const FLIGHT = {
  duration: 300,
  easing: Easing.bezier(0.23, 1, 0.32, 1),
  reduceMotion: ReduceMotion.System,
} as const

/** A point in the window. */
interface Point {
  readonly x: number
  readonly y: number
}
const NOWHERE: Point = { x: 0, y: 0 }

/** The disc when it is not flying: not there. */
const LANDED = { opacity: 0, transform: [{ translateX: 0 }, { translateY: 0 }, { scale: 1 }] }

/**
 * The capsule in its place over the stack, and the disc that carries a send up to it.
 *
 * When the Person sends, a disc in the send button's colour leaves that button, rises to the
 * capsule and lands where the face stands, shrinking from the button's size to the orb's, which
 * is what is there by the time it lands. That is the whole morph: what the Person pressed becomes
 * what is now thinking, and it ends at the top centre, where the state stays for the rest of the
 * Run.
 *
 * - It runs on the UI thread and moves by transform and opacity alone; React renders nothing.
 * - It leaves from where the button is at that moment: the composer rides the keyboard.
 * - It lands where the capsule's slot is in the layout of that frame. The capsule widens as
 *   Vivid starts thinking, which moves the slot, and the layout knows the slot's new place as
 *   soon as React has committed it, before the capsule has finished widening. So the place is
 *   read every frame of the flight (about twenty of them) and the disc ends on the orb.
 * - Its sideways travel lags its rise (the square of the progress), so the path curves in toward
 *   the capsule instead of cutting a straight diagonal across the conversation.
 * - With reduced motion nothing travels; the capsule simply shows the orb.
 *
 * The layer takes no touches of its own: only the capsule in it can be pressed.
 */
function Floating({ said, onGo }: { said: Front; onGo: (place: Place) => void }) {
  const { colors: c } = useTheme()
  const insets = useSafeAreaInsets()
  const layer = useAnimatedRef<Animated.View>()
  const slot = useAnimatedRef<Animated.View>()
  const flight = useSharedValue(0)
  // Where the flight began, and where the layer itself is, both in the window's own points.
  const from = useSharedValue(NOWHERE)
  const ground = useSharedValue(NOWHERE)
  const { button, sends } = said.origin

  useAnimatedReaction(
    () => sends.get(),
    (now, before) => {
      // `before` is null when this composer is first listened to: the screen in front has just
      // changed, and nothing has been sent from it since.
      if (before === null || now === before) return
      const leaving = measure(button)
      const frame = measure(layer)
      if (leaving === null || frame === null) return
      from.set({ x: leaving.pageX + leaving.width / 2, y: leaving.pageY + leaving.height / 2 })
      ground.set({ x: frame.pageX, y: frame.pageY })
      flight.set(0)
      flight.set(withTiming(1, FLIGHT))
    },
    [sends, button],
  )

  const flying = useAnimatedStyle(() => {
    const progress = flight.get()
    // At rest, and the one time this runs outside the UI thread, nothing is measured.
    if (progress <= 0 || progress >= 1) return LANDED
    const landing = measure(slot)
    if (landing === null) return LANDED
    const start = from.get()
    const base = ground.get()
    const endX = landing.pageX + landing.width / 2
    const endY = landing.pageY + landing.height / 2
    return {
      // There for the journey only: in over the first steps, and out as it reaches the orb.
      opacity: interpolate(progress, [0, 0.05, 0.92, 1], [0, 1, 1, 0]),
      transform: [
        { translateX: start.x + (endX - start.x) * progress * progress - base.x - DISC / 2 },
        { translateY: start.y + (endY - start.y) * progress - base.y - DISC / 2 },
        { scale: interpolate(progress, [0, 1], [1, ORB / DISC]) },
      ],
    }
  })

  return (
    <Animated.View
      ref={layer}
      collapsable={false}
      pointerEvents="box-none"
      // It arrives and leaves with the screens that have it, quicker going than coming.
      entering={APPEAR}
      exiting={LEAVE}
      style={StyleSheet.absoluteFill}
    >
      <View
        pointerEvents="box-none"
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
        <Capsule stand={said.stand} limit={said.limit} slot={slot} onGo={onGo} />
      </View>
      <Animated.View
        // Decoration: the capsule says the state to a screen reader.
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        pointerEvents="none"
        style={[
          {
            position: 'absolute',
            top: 0,
            left: 0,
            width: DISC,
            height: DISC,
            borderRadius: DISC / 2,
            backgroundColor: c.primary,
          },
          flying,
        ]}
      />
    </Animated.View>
  )
}

/**
 * Vivid's capsule over the stack, for as long as the screen in front has one: Home and a Thread
 * say how Vivid stands (`VividBar`), and every other screen says nothing, so there it is not
 * drawn. It is put after the stack and inside the drawer's page, so it is over the system's bar
 * and under an open drawer.
 *
 * `onGo` goes to one of the places in Vivid's menu.
 */
export function Presence({ onGo }: { onGo: (place: Place) => void }) {
  const now = useSyncExternalStore(listen, spoken, spoken)
  if (Option.isNone(now)) return null
  return <Floating said={now.value.said} onGo={onGo} />
}
