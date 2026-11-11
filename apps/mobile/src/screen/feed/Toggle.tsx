import { Pressable } from 'react-native'
import Animated, {
  Easing,
  useAnimatedProps,
  useDerivedValue,
  useReducedMotion,
  withTiming,
  type DerivedValue,
} from 'react-native-reanimated'
import Svg, { Rect } from 'react-native-svg'
import { tick } from '../../data/haptics'
import { useTheme } from '../../theme'
import { TARGET } from '../../ui/ui'

const AnimatedRect = Animated.createAnimatedComponent(Rect)

/** One glyph rectangle on a 24 grid: x, y, width, height, corner, opacity. */
type Pane = readonly [number, number, number, number, number, number]

/**
 * The two glyphs, each three rounded rectangles, so one morphs into the other by moving and
 * resizing the same three (the morphing-icons rule: one structure shared by every state).
 * List: two cards, one under the other; the third waits inside the second, unseen. Stack: one
 * card with two edges under it, each narrower. Drawn at stroke 2, the menu glyph's weight.
 */
const LIST: ReadonlyArray<Pane> = [
  [3.5, 4, 17, 6.5, 2.2, 1],
  [3.5, 13.5, 17, 6.5, 2.2, 1],
  [3.5, 13.5, 17, 6.5, 2.2, 0],
]
const STACK: ReadonlyArray<Pane> = [
  [3.5, 3, 17, 11, 2.6, 1],
  [5.5, 17.25, 13, 0.5, 0.25, 1],
  [8, 20.75, 8, 0.5, 0.25, 1],
]

/** Exponential ease-out over 250 ms: most of the move lands early, as the skill's morph curve does. */
const MORPH = { duration: 250, easing: Easing.bezier(0.19, 1, 0.22, 1) } as const

/** One rectangle of the glyph, placed between its list and stack shapes by `stacked` (0 to 1). */
function Piece({ at, stacked, ink }: { at: number; stacked: DerivedValue<number>; ink: string }) {
  const animatedProps = useAnimatedProps(() => {
    const t = stacked.get()
    const from = LIST[at]
    const to = STACK[at]
    const mix = (k: number) => from[k] + (to[k] - from[k]) * t
    return { x: mix(0), y: mix(1), width: mix(2), height: mix(3), rx: mix(4), opacity: mix(5) }
  })
  return (
    <AnimatedRect
      animatedProps={animatedProps}
      fill="none"
      stroke={ink}
      strokeWidth={2}
      strokeLinejoin="round"
    />
  )
}

/**
 * Shows the Feed's waiting cards as a list or as one stack (the owner, 11 November 2026: "deck
 * should be one of the views w a toggle", "one that morphs is enough"). The glyph shows how the
 * cards are now and morphs to the other on a press; the name says what a press does. A press ticks.
 */
export function Toggle({ stacked, onPress }: { stacked: boolean; onPress: () => void }) {
  const { colors: c } = useTheme()
  const still = useReducedMotion()
  const progress = useDerivedValue<number>(
    () => (still ? (stacked ? 1 : 0) : withTiming(stacked ? 1 : 0, MORPH)),
    [stacked, still],
  )
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={stacked ? 'Show the cards as a list' : 'Stack the cards'}
      hitSlop={4}
      onPress={() => {
        tick()
        onPress()
      }}
      style={({ pressed }) => ({
        width: TARGET,
        height: TARGET,
        borderRadius: TARGET / 2,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: pressed ? c['wash-pressed'] : 'transparent',
        transform: [{ scale: pressed ? 0.94 : 1 }],
      })}
    >
      <Svg width={22} height={22} viewBox="0 0 24 24">
        {[0, 1, 2].map((at) => (
          <Piece key={at} at={at} stacked={progress} ink={c.foreground} />
        ))}
      </Svg>
    </Pressable>
  )
}
