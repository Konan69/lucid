import { nativeMetrics as m } from '@vivid/tokens/native'
import { Data } from 'effect'
import type { ReactNode } from 'react'
import { StyleSheet, View } from 'react-native'
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
import { useAppearance } from '../data/vivid'
import { useTheme } from '../theme'
import { AnimatedGlassMaterial } from './Glass'
import { APPEAR, LEAVE, MORPH } from './motion/morph'
import { Face, Label, TARGET, type Tone } from './ui'

/**
 * Vivid at the top centre of a screen: a capsule of the system's glass holding its face and its
 * name, between the bar's own buttons. It is where a Person looks to see how Vivid is doing, so
 * while Vivid works the capsule widens to the orb and the word for it, and what the Person sends
 * rises to it from the composer.
 *
 * The buttons either side are the system's bar items (`ui/Bar.tsx`). The capsule is the same
 * material the composer is (`AnimatedGlassMaterial`), placed where the bar's title would be: the
 * owner's reference, the ChatGPT iPhone app, has a round glass button at each end of the bar and
 * a glass capsule in the middle, each floating on its own.
 */

/**
 * How Vivid stands at the top of a screen. One of three things, never a mix: there is no state in
 * which it is both thinking and saying something else.
 */
export type Stand = Data.TaggedEnum<{
  /** Nothing to report: its face, in the mood of the moment, and its name. */
  Resting: { readonly mood: 'happy' | 'thinking' }
  /** At work on what this screen shows: the orb, and the word for it. */
  Thinking: {}
  /** Something for the Person to read: that Vivid is waiting for them, or who is typing. */
  Saying: { readonly words: string; readonly tone: Tone }
}>
export const Stand = Data.taggedEnum<Stand>()

/** The word beside the orb. The web says the same beside its own (`apps/web/src/screen/Thread.tsx`). */
const THINKING = 'Thinking…'

/**
 * The capsule's measures. It is as tall as a bar button (44), so it fills the bar exactly as the
 * system's glass buttons do. The face or orb stands in a 24-point slot 10 points in from the
 * leading edge, which is the same 10 it has above and below, so the round end of the capsule is
 * concentric with what it holds. The words have 16 at the trailing end, where nothing round
 * balances them.
 */
const SLOT = 24
const LEAD_ROOM = (TARGET - SLOT) / 2
const TRAIL_ROOM = 16
const BETWEEN = 8
/** The orb is one of the library's two tuned sizes; it is centred in the face's slot. */
const ORB = 20

/**
 * The height of an iPhone's navigation bar under the status bar, which is where the capsule is
 * placed when it floats. The reference uses the same number for a glass bar's room
 * (T3 Code mobile `src/lib/layoutMetrics.ts`, `IOS_NAV_BAR_HEIGHT`).
 */
const BAR = 44

/** What a screen reader says for the capsule: Vivid's name, then how it stands. */
const spokenOf = (name: string, stand: Stand): string =>
  Stand.$match(stand, {
    Resting: () => name,
    Thinking: () => `${name}. ${THINKING}`,
    Saying: ({ words }) => `${name}. ${words}`,
  })

/**
 * One piece of the capsule that replaces another: the face for the orb, a name for a sentence.
 * Where the capsule morphs, the old piece fades out as the new one fades in; elsewhere the new
 * one is simply drawn. The caller keys it by what it shows, which is what makes it a new piece.
 */
function Piece({
  morphs,
  entering,
  shrinks,
  children,
}: {
  morphs: boolean
  entering: typeof APPEAR
  /** The words give way when the capsule has less room than they need; the face does not. */
  shrinks: boolean
  children: ReactNode
}) {
  return (
    <Animated.View
      entering={morphs ? entering : undefined}
      exiting={morphs ? LEAVE : undefined}
      style={shrinks ? { flexShrink: 1, minWidth: 0 } : undefined}
    >
      {children}
    </Animated.View>
  )
}

/**
 * The orb comes in as the disc that rose from the composer reaches it (`Floating`), so the two
 * are never both at the capsule at full strength. With reduced motion there is no disc and the
 * orb is drawn at once.
 */
const LAND = FadeIn.duration(180).delay(140).reduceMotion(ReduceMotion.System)

/**
 * The capsule itself: glass behind, and in front the face or the orb, then the words.
 *
 * It is built as the composer's shape is (`ui/Composer.tsx`, `Surface`; the reference's
 * `ComposerSurface`): an outline that clips, the passive glass material behind, and the content
 * in front as the material's sibling, all on one layout transition, so the capsule widens around
 * its new words instead of showing them outside itself first.
 *
 * `morphs` is false where the capsule sits in the system bar's own title slot (`ui/Bar.tsx`, on a
 * solid bar). The reference found that natively driven animation blanks a view the bar has taken
 * in (`src/features/home/WorkspaceConnectionTitle.tsx`, `StatusFadeIn`), so there nothing in the
 * capsule is moved by the animation library: its shape and its pieces change at once, and a face
 * in a new mood is a new face, not the old one turning (`Face` eases its tilt). The orb still
 * draws itself, on a canvas of its own that no animated value drives.
 *
 * `slot` is where the face or the orb stands, for the disc that flies to it.
 */
export function Capsule({
  stand,
  morphs,
  limit,
  slot,
}: {
  stand: Stand
  morphs: boolean
  /** The widest the capsule may be between the bar's buttons; longer words are cut with an ellipsis. */
  limit: number
  slot?: AnimatedRef<Animated.View>
}) {
  const { dark } = useTheme()
  const vivid = useAppearance()
  const layout = morphs ? MORPH : undefined
  const thinking = Stand.$is('Thinking')(stand)
  const words = Stand.$match(stand, {
    Resting: () => vivid.name,
    Thinking: () => THINKING,
    Saying: (saying) => saying.words,
  })
  const tone: Tone = Stand.$is('Saying')(stand) ? stand.tone : 'ink'
  const mood = Stand.$is('Resting')(stand) ? stand.mood : 'neutral'
  return (
    <Animated.View
      accessible
      accessibilityRole="header"
      accessibilityLabel={spokenOf(vivid.name, stand)}
      // Said again when it changes: it is where a Thread says that Vivid has started working, or
      // is now waiting for the Person.
      accessibilityLiveRegion="polite"
      layout={layout}
      style={{
        height: TARGET,
        maxWidth: limit,
        borderRadius: TARGET / 2,
        borderCurve: 'continuous',
        overflow: 'hidden',
        // Lighter than the composer's: a small shape beside the system's own buttons, which the
        // system lifts only a little.
        boxShadow: dark ? '0 4px 16px rgba(0, 0, 0, 0.28)' : '0 4px 16px rgba(0, 0, 0, 0.1)',
      }}
    >
      <AnimatedGlassMaterial
        layout={layout}
        style={[StyleSheet.absoluteFill, { borderRadius: TARGET / 2, borderCurve: 'continuous' }]}
      />
      <Animated.View
        collapsable={false}
        layout={layout}
        style={{
          height: TARGET,
          flexDirection: 'row',
          alignItems: 'center',
          gap: BETWEEN,
          paddingLeft: LEAD_ROOM,
          paddingRight: TRAIL_ROOM,
        }}
      >
        {/* Drawn whole the first time: a screen that opens does not fade its own bar in. */}
        <LayoutAnimationConfig skipEntering>
          <Animated.View
            ref={slot}
            // Kept as a view of its own, so there is always something to measure.
            collapsable={false}
            style={{ width: SLOT, height: SLOT, alignItems: 'center', justifyContent: 'center' }}
          >
            {thinking ? (
              <Piece key="orb" morphs={morphs} entering={LAND} shrinks={false}>
                {/* The words beside it name it, so a screen reader is not told twice. */}
                <ThinkingOrb
                  state="breathing"
                  size={ORB}
                  theme={dark ? 'dark' : 'light'}
                  accessibilityLabel=""
                />
              </Piece>
            ) : (
              <Piece
                key={morphs ? 'face' : `face-${mood}`}
                morphs={morphs}
                entering={APPEAR}
                shrinks={false}
              >
                <Face size={SLOT} mood={mood} label="" />
              </Piece>
            )}
          </Animated.View>
          <Piece key={words} morphs={morphs} entering={APPEAR} shrinks>
            <Label
              numberOfLines={1}
              // The capsule is as tall as a bar button whatever the text size, as the system's own
              // bar is, so its words grow with the Person's setting only as far as they fit.
              maxFontSizeMultiplier={1.3}
              tone={tone}
              style={{ fontWeight: m['weight-strong'], lineHeight: SLOT }}
            >
              {words}
            </Label>
          </Piece>
        </LayoutAnimationConfig>
      </Animated.View>
    </Animated.View>
  )
}

/**
 * Where "thinking" leaves from: the composer's button, and each time the Person sends with it.
 * A screen makes one (`useOrigin`) and hands it to its composer, which puts `button` on the
 * button's round and counts a send in `sends`, and to its bar, which flies the disc.
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
 * The capsule floating over a screen, under the system's transparent bar, and the disc that
 * carries a send up to it.
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
 * The layer takes no touches. `zIndex` puts it over the conversation and the composer, which are
 * drawn after it.
 */
export function Floating({
  stand,
  limit,
  origin,
}: {
  stand: Stand
  limit: number
  origin: Origin
}) {
  const { colors: c } = useTheme()
  const insets = useSafeAreaInsets()
  const layer = useAnimatedRef<Animated.View>()
  const slot = useAnimatedRef<Animated.View>()
  const flight = useSharedValue(0)
  // Where the flight began, and where the layer itself is, both in the window's own points.
  const from = useSharedValue(NOWHERE)
  const ground = useSharedValue(NOWHERE)

  useAnimatedReaction(
    () => origin.sends.get(),
    (now, before) => {
      // `before` is null when the screen is first drawn: nothing has been sent from it yet.
      if (before === null || now === before) return
      const button = measure(origin.button)
      const frame = measure(layer)
      if (button === null || frame === null) return
      from.set({ x: button.pageX + button.width / 2, y: button.pageY + button.height / 2 })
      ground.set({ x: frame.pageX, y: frame.pageY })
      flight.set(0)
      flight.set(withTiming(1, FLIGHT))
    },
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
      pointerEvents="none"
      style={[StyleSheet.absoluteFill, { zIndex: 1 }]}
    >
      <View
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
        <Capsule stand={stand} morphs limit={limit} slot={slot} />
      </View>
      <Animated.View
        // Decoration: the capsule says the state to a screen reader.
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
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
