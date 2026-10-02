import { Children, isValidElement, type ReactNode } from 'react'
import { View } from 'react-native'
import { ChevronRight, ExternalLink } from 'lucide-react-native'
import { useTheme } from '../theme'
import { HAIRLINE, Label, Press, radius, TARGET } from './ui'

/**
 * A titled group of rows on one quiet shape. The rows inside are told apart by hairlines, which
 * here are structure (one row ends, the next begins), not decoration.
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
        <Label accessibilityRole="header" size="label" tone="ink-3">
          {title}
        </Label>
        {detail !== undefined && (
          <Label size="caption" tone="ink-4">
            {detail}
          </Label>
        )}
      </View>
      <View
        style={{
          borderRadius: radius.card,
          backgroundColor: c['surface-2'],
          borderWidth: HAIRLINE,
          borderColor: c['line-2'],
          overflow: 'hidden',
        }}
      >
        {rows.map((row, place) => (
          <View key={row.key}>
            {place > 0 && (
              <View style={{ height: HAIRLINE, marginLeft: 16, backgroundColor: c['line-2'] }} />
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
          <Label numberOfLines={wrap ? undefined : 2} size="label" tone="ink-3">
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
      style={({ pressed }) => [
        ROW,
        { backgroundColor: pressed ? c['wash-pressed'] : 'transparent' },
      ]}
    >
      <RowBody
        leading={leading}
        title={title}
        detail={detail}
        danger={danger}
        wrap={wrap}
        trailing={
          trailing === undefined ? (
            <goes.mark pointerEvents="none" size={18} strokeWidth={1.7} color={c['ink-4']} />
          ) : (
            trailing
          )
        }
      />
    </Press>
  )
}
