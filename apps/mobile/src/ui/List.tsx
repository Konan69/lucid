import { Children, isValidElement, type ReactNode } from 'react'
import { View } from 'react-native'
import { ChevronRight, ExternalLink } from 'lucide-react-native'
import { useTheme } from '../theme'
import { EDGE, Label, Press, radius, TARGET } from './ui'

/**
 * A titled group of rows on one bordered shape: the theme's `grouped-card` inside a solid
 * `border`, with a solid `separator` between rows. The lines are structure (one row ends, the
 * next begins), not decoration.
 *
 * The treatment is T3 Code mobile's settings groups (`bg-grouped-card`, `border-border`,
 * `bg-separator`; `src/features/connection/ConnectionEnvironmentRow.tsx`).
 */
export function Section({
  title,
  detail,
  children,
}: {
  title: string
  detail?: string
  children: ReactNode
}) {
  const { colors: c } = useTheme()
  // `toArray` drops what a condition left empty and gives every row a key of its own.
  const rows = Children.toArray(children).filter(isValidElement)
  return (
    <View style={{ gap: 8 }}>
      <View style={{ paddingHorizontal: 4, gap: 2 }}>
        <Label accessibilityRole="header" size="label" tone="ink-2" style={{ fontWeight: '600' }}>
          {title}
        </Label>
        {detail !== undefined && (
          <Label size="caption" tone="foreground-tertiary">
            {detail}
          </Label>
        )}
      </View>
      <View
        style={{
          borderRadius: radius.card,
          borderCurve: 'continuous',
          backgroundColor: c['grouped-card'],
          borderWidth: EDGE,
          borderColor: c.border,
          overflow: 'hidden',
        }}
      >
        {rows.map((row, place) => (
          <View key={row.key}>
            {place > 0 && (
              <View style={{ height: EDGE, marginLeft: 16, backgroundColor: c.separator }} />
            )}
            {row}
          </View>
        ))}
      </View>
    </View>
  )
}

/** What a row is made of, whether or not it can be pressed. */
function RowBody({
  leading,
  title,
  detail,
  trailing,
  danger,
  wrap,
}: {
  leading?: ReactNode
  title: string
  detail?: string
  trailing?: ReactNode
  danger: boolean
  wrap: boolean
}) {
  return (
    <>
      {leading}
      <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
        <Label
          // A name is cut to one line so a list keeps its rhythm; a sentence is read whole.
          numberOfLines={wrap ? undefined : 1}
          size="body"
          tone={danger ? 'status-danger' : 'ink'}
        >
          {title}
        </Label>
        {detail !== undefined && (
          <Label numberOfLines={wrap ? undefined : 2} size="label" tone="ink-2">
            {detail}
          </Label>
        )}
      </View>
      {trailing}
    </>
  )
}

const ROW = {
  minHeight: TARGET + 8,
  paddingHorizontal: 16,
  paddingVertical: 10,
  flexDirection: 'row',
  alignItems: 'center',
  gap: 12,
} as const

/**
 * Where pressing a row takes the Person, which decides the mark at its trailing edge and what a
 * screen reader calls it. A row that stays in the app is a button with a chevron; one that leaves
 * for the browser is a link, says so before it is pressed, and carries the arrow out of a box
 * that every platform uses for "this opens somewhere else".
 */
const DESTINATION = {
  inside: { role: 'button', hint: undefined, mark: ChevronRight },
  outside: { role: 'link', hint: 'Opens in your browser', mark: ExternalLink },
} as const

/**
 * One line of a Section. With `onPress` it is a control: it darkens under a finger and, unless
 * it says otherwise, shows the chevron that means "this goes somewhere". Without it, it is text
 * and looks like text.
 *
 * - `wrap`: the title is a sentence to be read, not a name, so neither it nor the detail is cut.
 * - `outside`: pressing it leaves the app for the browser; see `DESTINATION`.
 */
export function Row({
  leading,
  title,
  detail,
  trailing,
  danger = false,
  wrap = false,
  outside = false,
  onPress,
}: {
  leading?: ReactNode
  title: string
  detail?: string
  trailing?: ReactNode
  danger?: boolean
  wrap?: boolean
  outside?: boolean
  onPress?: () => void
}) {
  const { colors: c } = useTheme()
  if (onPress === undefined) {
    return (
      <View style={ROW}>
        <RowBody
          leading={leading}
          title={title}
          detail={detail}
          trailing={trailing}
          danger={danger}
          wrap={wrap}
        />
      </View>
    )
  }
  const goes = DESTINATION[outside ? 'outside' : 'inside']
  return (
    <Press
      accessibilityRole={goes.role}
      accessibilityHint={goes.hint}
      onPress={onPress}
      style={({ pressed }) => [ROW, { backgroundColor: pressed ? c['row-hover'] : 'transparent' }]}
    >
      <RowBody
        leading={leading}
        title={title}
        detail={detail}
        danger={danger}
        wrap={wrap}
        trailing={
          trailing === undefined ? (
            <goes.mark pointerEvents="none" size={18} strokeWidth={1.7} color={c.chevron} />
          ) : (
            trailing
          )
        }
      />
    </Press>
  )
}
