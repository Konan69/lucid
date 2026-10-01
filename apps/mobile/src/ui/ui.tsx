import type { ReactNode } from 'react'
import {
  Alert,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  View,
  type StyleProp,
  type TextInputProps,
  type TextProps,
  type ViewStyle,
} from 'react-native'
import type { LucideIcon } from 'lucide-react-native'
import { nativeMetrics as m } from '@vivid/tokens/native'
import type { FaceMood } from '@vivid/marks'
import { MOBILE_TYPOGRAPHY } from '../data/typography'
import { tick } from '../data/haptics'
import { useTheme } from '../theme'
import { Face } from './Face'
import { Press } from './motion/Pressable'

export { Face } from './Face'
export { Press } from './motion/Pressable'

/**
 * The app's small set of drawn parts. Every screen is built from these and from nothing else, so
 * a control looks and answers the same wherever it appears: a 44-point target, a fill that
 * darkens under a finger, a hairline where structure needs one and never a cast shadow.
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

/** One device pixel: the weight of every structural line in the app. */
export const HAIRLINE = StyleSheet.hairlineWidth

/** The margin every screen keeps between its content and the edge of the glass. */
export const GUTTER = 20

/** The least a finger needs. A control that draws smaller than this still answers this large. */
export const TARGET = 44

type Tone =
  | 'ink'
  | 'ink-2'
  | 'ink-3'
  | 'ink-4'
  | 'ink-on-accent'
  | 'accent-ink'
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
  primary: { fill: 'accent', ink: 'ink-on-accent', line: false },
  plain: { fill: 'surface-2', ink: 'ink', line: true },
  ghost: { fill: 'transparent', ink: 'ink-2', line: false },
  danger: { fill: 'status-danger-soft', ink: 'status-danger', line: false },
} as const satisfies Record<ButtonKind, { fill: string; ink: Tone; line: boolean }>

/** How present a control is: faint when it cannot be used, slightly dimmed while it is held. */
const presence = (disabled: boolean, pressed: boolean): number => {
  if (disabled) return 0.4
  return pressed ? 0.82 : 1
}

/** A labelled action. The label never wraps: a button that breaks onto two lines reads as broken. */
export function Button({
  label,
  icon: Icon,
  kind = 'plain',
  disabled = false,
  onPress,
  containerStyle,
}: {
  label: string
  icon?: LucideIcon
  kind?: ButtonKind
  disabled?: boolean
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
      style={({ pressed }) => ({
        minHeight: TARGET,
        paddingHorizontal: 16,
        gap: 8,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: radius.control,
        backgroundColor: pressed && kind === 'ghost' ? c['wash-pressed'] : fill,
        borderWidth: paint.line ? HAIRLINE : 0,
        borderColor: c['line-3'],
        opacity: presence(disabled, pressed),
      })}
    >
      {Icon !== undefined && (
        <Icon pointerEvents="none" size={17} strokeWidth={1.8} color={c[paint.ink]} />
      )}
      <Label size="footnote" tone={paint.ink} numberOfLines={1}>
        {label}
      </Label>
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

/** A quiet filled shape that groups what belongs together. Depth is its fill, not a shadow. */
export function Card({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const { colors: c } = useTheme()
  return (
    <View
      style={[
        {
          padding: 16,
          gap: 10,
          borderRadius: radius.card,
          backgroundColor: c['surface-2'],
          borderWidth: HAIRLINE,
          borderColor: c['line-2'],
        },
        style,
      ]}
    >
      {children}
    </View>
  )
}

/** Somewhere to type. Its text is the reading size, which is also what keeps it legible. */
export function Field({ style, ...props }: TextInputProps) {
  const { colors: c } = useTheme()
  return (
    <TextInput
      {...props}
      placeholderTextColor={c['ink-4']}
      selectionColor={c.accent}
      style={[
        {
          minHeight: 48,
          paddingHorizontal: 14,
          paddingVertical: 12,
          borderRadius: radius.control,
          backgroundColor: c['surface-2'],
          borderWidth: HAIRLINE,
          borderColor: c['line-2'],
          color: c.ink,
        },
        MOBILE_TYPOGRAPHY.reading,
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

/** A screen or list with nothing in it yet: Vivid, one line of what goes here, and the way in. */
export function Empty({
  title,
  detail,
  mood = 'neutral',
  children,
}: {
  title: string
  detail: string
  mood?: FaceMood
  children?: ReactNode
}) {
  return (
    <View style={{ alignItems: 'center', paddingVertical: 44, paddingHorizontal: 24, gap: 10 }}>
      <Face size={44} mood={mood} />
      <Label size="headline" style={{ marginTop: 6, textAlign: 'center' }}>
        {title}
      </Label>
      <Label size="label" tone="ink-3" style={{ textAlign: 'center', maxWidth: 300 }}>
        {detail}
      </Label>
      {children !== undefined && <View style={{ marginTop: 10 }}>{children}</View>}
    </View>
  )
}

/**
 * A choice between a few named things, all visible at once. The chosen one is raised; the rest
 * darken under a finger. Each segment is a radio to assistive technology.
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
  const fill = (selected: boolean, pressed: boolean) => {
    if (selected) return c['surface-3']
    return pressed ? c['wash-pressed'] : 'transparent'
  }
  return (
    <View
      accessibilityRole="radiogroup"
      accessibilityLabel={label}
      style={{
        flexDirection: 'row',
        alignSelf: 'flex-start',
        padding: 3,
        // Concentric with the segments inside it: their radius plus the track's padding.
        borderRadius: radius.row + 3,
        backgroundColor: c['surface-2'],
        borderWidth: HAIRLINE,
        borderColor: c['line-2'],
      }}
    >
      {options.map((option) => {
        const selected = option.value === value
        return (
          <Press
            key={option.value}
            accessibilityRole="radio"
            accessibilityState={{ selected }}
            // The segment is 38 points tall inside its track; the slop makes the target 44.
            hitSlop={{ top: 3, bottom: 3 }}
            onPress={() => {
              if (selected) return
              tick()
              onChange(option.value)
            }}
            style={({ pressed }) => ({
              minHeight: 38,
              paddingHorizontal: 14,
              justifyContent: 'center',
              borderRadius: radius.row,
              borderWidth: HAIRLINE,
              borderColor: selected ? c['line-3'] : 'transparent',
              backgroundColor: fill(selected, pressed),
            })}
          >
            <Label size="label" tone={selected ? 'ink' : 'ink-3'} numberOfLines={1}>
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
export function Chips<Value extends string>({
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
    if (selected) return c['accent-soft']
    return pressed ? c['wash-pressed'] : c['surface-2']
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
              borderRadius: radius.control,
              borderWidth: selected ? 1 : HAIRLINE,
              borderColor: selected ? c.accent : c['line-2'],
              backgroundColor: fill(selected, pressed),
            })}
          >
            <Label size="label" tone={selected ? 'accent-ink' : 'ink-2'}>
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
