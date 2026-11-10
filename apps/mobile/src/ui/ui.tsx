import type { ReactNode, Ref } from 'react'
import {
  Alert,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
  type StyleProp,
  type TextInputProps,
  type TextProps,
  type ViewStyle,
} from 'react-native'
import type { LucideIcon } from 'lucide-react-native'
import { nativeMetrics as m } from '@vivid/tokens/native'
import { MOBILE_TYPOGRAPHY } from '../data/typography'
import { tick } from '../data/haptics'
import { useTheme } from '../theme'
import Animated from 'react-native-reanimated'
import { Press } from './motion/Pressable'
import { APPEAR, LEAVE, MORPH } from './motion/morph'

export { Face } from './Face'
export { Press } from './motion/Pressable'

/**
 * The app's small set of drawn parts. Every screen is built from these and from nothing else, so
 * a control looks and answers the same wherever it appears: a 44-point target, a fill that
 * darkens under a finger, and a solid border in the theme's own colour where structure needs an
 * edge. Only floating chrome (`Glass`) casts a shadow.
 */

/** The web's radii, scaled for a screen held in a hand. Rounded once so edges land on pixels. */
const scaled = (name: 'radius-row' | 'radius-control' | 'radius-card' | 'radius-panel') =>
  Math.round(m[name] * m['phone-radius-factor'])

export const radius = {
  row: scaled('radius-row'),
  control: scaled('radius-control'),
  card: scaled('radius-card'),
  panel: scaled('radius-panel'),
} as const

/** One device pixel: the weight of a separator between two rows of the same group. */
export const HAIRLINE = StyleSheet.hairlineWidth

/**
 * The weight of a shape's own border: a card, a field, a control. One point in the theme's solid
 * `border`, as the reference draws them; a hairline in an alpha ink is what made the old screens
 * read as flat.
 */
export const EDGE = 1

/**
 * The fixed-width face, for what must be read character by character: a sign-in code, a command,
 * a value exactly as it will be sent. Each platform's own; no font is bundled for it.
 */
export const MONO = Platform.select({ ios: 'Menlo', default: 'monospace' })

/** The margin every screen keeps between its content and the edge of the glass. */
export const GUTTER = 20

/** The least a finger needs. A control that draws smaller than this still answers this large. */
export const TARGET = 44

/** The inks text and glyphs are drawn in: the palette's own, and one for each kind of state. */
export type Tone =
  | 'ink'
  | 'ink-2'
  | 'ink-3'
  | 'ink-4'
  | 'ink-on-accent'
  | 'accent-ink'
  | 'foreground-tertiary'
  | 'user-bubble-foreground'
  | 'drawer-foreground-muted'
  | 'status-danger'
  | 'status-success'
  | 'status-working'
  | 'status-attention'
  | 'status-approve'

/** Text in one step of the type scale and one tone of ink. Nothing else in the app sets type. */
export function Label({
  tone = 'ink',
  size = 'body',
  style,
  ...props
}: TextProps & { tone?: Tone; size?: keyof typeof MOBILE_TYPOGRAPHY }) {
  const { colors } = useTheme()
  return (
    <Text
      {...props}
      style={[
        { color: colors[tone], fontWeight: m['weight-meta'] },
        MOBILE_TYPOGRAPHY[size],
        style,
      ]}
    />
  )
}

/**
 * What a button is for decides how it is drawn.
 *
 * - `primary`: the one thing this surface is asking for.
 * - `plain`: an ordinary action, on a quiet filled shape.
 * - `ghost`: a way out or a lesser action, with no shape until it is pressed.
 * - `danger`: something that removes or refuses.
 */
export type ButtonKind = 'primary' | 'plain' | 'ghost' | 'danger'

const BUTTON_PAINT = {
  primary: { fill: 'primary', ink: 'ink-on-accent', line: false },
  plain: { fill: 'subtle', ink: 'ink', line: true },
  ghost: { fill: 'transparent', ink: 'ink-2', line: false },
  danger: { fill: 'status-danger-soft', ink: 'status-danger', line: false },
} as const satisfies Record<ButtonKind, { fill: string; ink: Tone; line: boolean }>

/** How present a control is: faint when it cannot be used, slightly dimmed while it is held. */
const presence = (disabled: boolean, pressed: boolean): number => {
  if (disabled) return 0.4
  return pressed ? 0.82 : 1
}

/**
 * A labelled action. The label never wraps: a button that breaks onto two lines reads as broken.
 *
 * A button whose label changes while it is on screen ("Continue" to "One moment…") is given
 * `morph`: its outline eases to the new width and the new words fade in over the old, instead of
 * the shape snapping. The pattern and its timings are `ui/motion/morph.ts`.
 */
export function Button({
  label,
  icon: Icon,
  kind = 'plain',
  disabled = false,
  morph = false,
  onPress,
  containerStyle,
}: {
  label: string
  icon?: LucideIcon
  kind?: ButtonKind
  disabled?: boolean
  morph?: boolean
  onPress: () => void
  containerStyle?: StyleProp<ViewStyle>
}) {
  const { colors: c } = useTheme()
  const paint = BUTTON_PAINT[kind]
  const fill = paint.fill === 'transparent' ? 'transparent' : c[paint.fill]
  return (
    <Press
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      containerStyle={containerStyle}
      layout={morph ? MORPH : undefined}
      style={({ pressed }) => ({
        minHeight: 48,
        paddingHorizontal: 20,
        gap: 8,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        // A full pill, as the reference's actions are: the one shape that reads as "press me"
        // against the squarer cards and fields around it.
        borderRadius: 24,
        backgroundColor: pressed && kind === 'ghost' ? c['wash-pressed'] : fill,
        borderWidth: paint.line ? EDGE : 0,
        borderColor: c.border,
        opacity: presence(disabled, pressed),
      })}
    >
      {Icon !== undefined && (
        <Icon pointerEvents="none" size={17} strokeWidth={1.8} color={c[paint.ink]} />
      )}
      {morph ? (
        // Keyed by its words, so a new label is a new view: the old one fades out as this fades in.
        <Animated.View key={label} entering={APPEAR} exiting={LEAVE}>
          <Label size="footnote" tone={paint.ink} numberOfLines={1} style={{ fontWeight: '600' }}>
            {label}
          </Label>
        </Animated.View>
      ) : (
        <Label size="footnote" tone={paint.ink} numberOfLines={1} style={{ fontWeight: '600' }}>
          {label}
        </Label>
      )}
    </Press>
  )
}

/**
 * An action drawn as its icon alone. The glyph is small; the target around it is the full 44
 * points, and the name a screen reader says is required because the picture says nothing to it.
 */
export function IconButton({
  icon: Icon,
  label,
  tone = 'ink-2',
  disabled = false,
  onPress,
}: {
  icon: LucideIcon
  label: string
  tone?: Tone
  disabled?: boolean
  onPress: () => void
}) {
  const { colors: c } = useTheme()
  return (
    <Press
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({
        width: TARGET,
        height: TARGET,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: radius.control,
        backgroundColor: pressed ? c['wash-pressed'] : 'transparent',
        opacity: disabled ? 0.35 : 1,
      })}
    >
      <Icon pointerEvents="none" size={21} strokeWidth={1.7} color={c[tone]} />
    </Press>
  )
}

/**
 * A bordered shape that groups what belongs together. It is the theme's `grouped-card` inside a
 * solid border: the edge is what separates it from the page, so it needs no fill of its own and
 * no shadow.
 */
export function Card({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const { colors: c } = useTheme()
  return (
    <View
      style={[
        {
          padding: 16,
          gap: 10,
          borderRadius: radius.card,
          borderCurve: 'continuous',
          backgroundColor: c['grouped-card'],
          borderWidth: EDGE,
          borderColor: c.border,
        },
        style,
      ]}
    >
      {children}
    </View>
  )
}

/**
 * Somewhere to type. Its text is the reading size, which is also what keeps it legible, on the
 * line a field is given (`MOBILE_TYPOGRAPHY.typing`).
 */
export function Field({ ref, style, ...props }: TextInputProps & { ref?: Ref<TextInput> }) {
  const { colors: c } = useTheme()
  return (
    <TextInput
      ref={ref}
      {...props}
      placeholderTextColor={c.placeholder}
      selectionColor={c.primary}
      style={[
        {
          minHeight: 52,
          paddingHorizontal: 16,
          paddingVertical: 13,
          borderRadius: radius.control,
          borderCurve: 'continuous',
          backgroundColor: c.input,
          borderWidth: EDGE,
          borderColor: c['input-border'],
          color: c.foreground,
        },
        MOBILE_TYPOGRAPHY.typing,
        style,
      ]}
    />
  )
}

/** A field under the word that says what it is for. */
export function Labelled({ label, children }: { label: string; children: ReactNode }) {
  return (
    <View style={{ gap: 8 }}>
      <Label size="label" tone="ink-2">
        {label}
      </Label>
      {children}
    </View>
  )
}

/** Something the server or the device refused, said where the Person was looking. */
export function Notice({ message }: { message: string }) {
  const { colors: c } = useTheme()
  return (
    <View
      accessibilityRole="alert"
      accessibilityLiveRegion="polite"
      style={{
        paddingHorizontal: 14,
        paddingVertical: 12,
        borderRadius: radius.control,
        backgroundColor: c['status-danger-soft'],
      }}
    >
      <Label size="label" tone="status-danger">
        {message}
      </Label>
    </View>
  )
}

/** The mark of an empty place: a soft tile a little larger than a row's, with the place's icon. */
const EMPTY_MARK = 64
/**
 * How much of the window an empty page's block is centred in, from where the page's content
 * starts under its bar. Six tenths puts the block a little above the middle of the screen, which
 * is where the eye rests on a page with nothing else on it; the true middle reads as sunk.
 */
const EMPTY_SHARE = 0.6

/**
 * A screen or list with nothing in it yet. It says three things, in this order: which place this
 * is (its mark, the same icon the menu shows for it), what is missing (the title), and how it
 * fills (one line). Under them is the one action that puts something there, as the page's
 * primary button.
 *
 * It used to be one grey sentence and a quiet button at the top of the page, on the gutter, with
 * the rest of the screen bare; the owner asked for the empty states to be redesigned (6 October
 * 2026). The arrangement is the platform's own for a place with no content, iOS's
 * `UIContentUnavailableView`: a picture, a title and a line, centred, with at most one button.
 * The mark is in the accent the Person chose, soft, so an empty page is still this Person's
 * Vivid and not a grey sheet.
 *
 * `room` says where it stands. A `page` has nothing else on it, so the block is centred in most
 * of the window, and the page leaves out the line that says what the place is while it is empty:
 * this says it, and a second sentence on the gutter above a centred block is a stray edge. A
 * `section` shares its sheet or page with other things and takes only the room it needs.
 *
 * Vivid's face is not here. It is drawn only where Vivid is present (greeting, thinking,
 * speaking), and an empty list is not Vivid saying anything.
 *
 * The block fades in once, when the list it stands for has answered that it is empty; nothing
 * else moves, and with reduced motion it is simply there.
 */
export function Empty({
  icon: Icon,
  title,
  line,
  room,
  children,
}: {
  icon: LucideIcon
  title: string
  line?: string
  room: 'page' | 'section'
  /** The one action that fills this place. */
  children?: ReactNode
}) {
  const { colors: c } = useTheme()
  const { height } = useWindowDimensions()
  return (
    <Animated.View
      entering={APPEAR}
      style={{
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: room === 'page' ? Math.round(height * EMPTY_SHARE) : undefined,
        paddingVertical: 32,
        paddingHorizontal: 12,
      }}
    >
      <View
        pointerEvents="none"
        style={{
          width: EMPTY_MARK,
          height: EMPTY_MARK,
          alignItems: 'center',
          justifyContent: 'center',
          borderRadius: 20,
          borderCurve: 'continuous',
          backgroundColor: c['accent-soft'],
        }}
      >
        <Icon size={28} strokeWidth={1.7} color={c['accent-ink']} />
      </View>
      <Label
        accessibilityRole="header"
        size="title"
        style={{ marginTop: 20, textAlign: 'center', maxWidth: 320 }}
      >
        {title}
      </Label>
      {line !== undefined && (
        <Label
          tone="ink-2"
          // Two lines of about the same length, not one long and a word left over. Android
          // balances them itself; the narrow measure does most of it on iOS, which cannot.
          textBreakStrategy="balanced"
          style={{ marginTop: 6, textAlign: 'center', maxWidth: 280 }}
        >
          {line}
        </Label>
      )}
      {children !== undefined && <View style={{ marginTop: 24 }}>{children}</View>}
    </Animated.View>
  )
}

/**
 * A choice between a few named things, all visible at once. The chosen one sits on a thumb that
 * slides to it; the rest darken under a finger. Each segment is a radio to assistive technology.
 *
 * Ported from T3 Code mobile `src/components/SegmentedControl.tsx`: equal segments in a pill
 * track, and one absolutely placed thumb whose `start` is the chosen index's share of the width,
 * moved by a 200 ms ease-out layout transition (`MORPH`). The reference hands Android to a
 * Material control; Vivid draws the same control on both, since the thumb needs nothing iOS-only.
 */
export function Segmented<Value extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: Value
  options: ReadonlyArray<{ readonly value: Value; readonly label: string }>
  onChange: (value: Value) => void
}) {
  const { colors: c } = useTheme()
  const share = 100 / options.length
  const at = Math.max(
    0,
    options.findIndex((option) => option.value === value),
  )
  return (
    <View
      accessibilityRole="radiogroup"
      accessibilityLabel={label}
      style={{
        flexDirection: 'row',
        borderRadius: 22,
        backgroundColor: c.card,
        borderWidth: EDGE,
        borderColor: c.border,
        overflow: 'hidden',
      }}
    >
      <Animated.View
        pointerEvents="none"
        layout={MORPH}
        style={{
          position: 'absolute',
          top: 0,
          bottom: 0,
          width: `${share}%`,
          start: `${at * share}%`,
          borderRadius: 22,
          backgroundColor: c['subtle-strong'],
        }}
      />
      {options.map((option) => {
        const selected = option.value === value
        return (
          <Press
            key={option.value}
            accessibilityRole="radio"
            accessibilityState={{ selected }}
            containerStyle={{ flex: 1 }}
            onPress={() => {
              if (selected) return
              tick()
              onChange(option.value)
            }}
            style={({ pressed }) => ({
              minHeight: TARGET,
              paddingHorizontal: 8,
              alignItems: 'center',
              justifyContent: 'center',
              opacity: pressed && !selected ? 0.6 : 1,
            })}
          >
            <Label
              size="footnote"
              tone={selected ? 'ink' : 'ink-3'}
              numberOfLines={1}
              style={{ fontWeight: selected ? '600' : '400' }}
            >
              {option.label}
            </Label>
          </Press>
        )
      })}
    </View>
  )
}

/**
 * A choice between more named things than fit on one line. They wrap, so a long label or a
 * larger text size makes another row instead of a clipped one.
 */
function Chips<Value extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: Value
  options: ReadonlyArray<{ readonly value: Value; readonly label: string }>
  onChange: (value: Value) => void
}) {
  const { colors: c } = useTheme()
  const fill = (selected: boolean, pressed: boolean) => {
    if (selected) return c['thread-selected']
    return pressed ? c['wash-pressed'] : c.card
  }
  return (
    <View accessibilityRole="radiogroup" accessibilityLabel={label} style={styles.wrap}>
      {options.map((option) => {
        const selected = option.value === value
        return (
          <Press
            key={option.value}
            accessibilityRole="radio"
            accessibilityState={{ selected }}
            onPress={() => {
              if (selected) return
              tick()
              onChange(option.value)
            }}
            style={({ pressed }) => ({
              minHeight: TARGET,
              paddingHorizontal: 14,
              justifyContent: 'center',
              borderRadius: TARGET / 2,
              borderWidth: EDGE,
              borderColor: selected ? c.primary : c.border,
              backgroundColor: fill(selected, pressed),
            })}
          >
            <Label size="label" tone={selected ? 'ink' : 'ink-2'}>
              {option.label}
            </Label>
          </Press>
        )
      })}
    </View>
  )
}

/** The widths a skeleton's bars take, so a loading list looks like a list and not a barcode. */
const BAR_WIDTHS = ['72%', '54%', '64%', '46%', '58%'] as const

/**
 * The outline of a list while its first result is on its way: still bars, not the empty-state
 * sentence, because nothing has been answered yet. It does not shimmer; a loading list should
 * not cost a frame, and a live query answers in the time a shimmer takes to start.
 */
export function Skeleton({ rows = 3 }: { rows?: number }) {
  const { colors: c } = useTheme()
  return (
    <View accessibilityLabel="Loading" accessibilityRole="progressbar" style={{ gap: 18 }}>
      {Array.from({ length: rows }, (_, row) => (
        <View key={row} style={{ gap: 8 }}>
          <View
            style={{
              height: 13,
              width: BAR_WIDTHS[row % BAR_WIDTHS.length],
              borderRadius: 7,
              backgroundColor: c['wash-pressed'],
            }}
          />
          <View
            style={{ height: 10, width: '34%', borderRadius: 5, backgroundColor: c['wash-hover'] }}
          />
        </View>
      ))}
    </View>
  )
}

/** A small round mark of state. It is never the only sign: a word always stands beside it. */
export function Dot({ tone, size = 7 }: { tone: Tone | 'line-4' | 'accent'; size?: number }) {
  const { colors: c } = useTheme()
  return (
    <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: c[tone] }} />
  )
}

/**
 * Asks before something that cannot be taken back. It is the system's own alert, which is what
 * a phone uses for exactly this; the browser preview has no such thing and uses its confirm.
 */
export function confirmDestructive(ask: {
  readonly title: string
  readonly detail: string
  readonly action: string
  readonly onConfirm: () => void
}) {
  if (Platform.OS === 'web') {
    if (window.confirm(`${ask.title}\n\n${ask.detail}`)) ask.onConfirm()
    return
  }
  Alert.alert(ask.title, ask.detail, [
    { text: 'Keep', style: 'cancel' },
    { text: ask.action, style: 'destructive', onPress: ask.onConfirm },
  ])
}

export const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  page: { paddingHorizontal: GUTTER, paddingTop: 8, paddingBottom: 40, gap: 20 },
  /** Keeps a column at a reading width on a tablet instead of stretching it across the glass. */
  column: { width: '100%', maxWidth: m['thread-max-w'], alignSelf: 'center' },
})
