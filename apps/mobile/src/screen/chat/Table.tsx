import type { Shown } from '@vivid/contracts'
import { rowCells } from '@vivid/state'
import { useState } from 'react'
import { View } from 'react-native'
import Animated, {
  Extrapolation,
  interpolate,
  useAnimatedScrollHandler,
  useAnimatedStyle,
  useSharedValue,
} from 'react-native-reanimated'
import { useTheme } from '../../theme'
import { Sheet } from '../../ui/Sheet'
import { Button, HAIRLINE, Label } from '../../ui/ui'
import { Frame } from './Frame'

type TableKind = Extract<Shown, { readonly _tag: 'Table' }>
type Ground = 'surface-3' | 'surface-0'

/** A long table shows this many rows in the Thread; "Show all" opens the rest at full height. */
const PREVIEW_ROWS = 6
/** The held first column, and every column that scrolls past it, in points. */
const FIRST = 116
const COLUMN = 148

/**
 * A table the way a phone reads one. Two columns fit the reply and simply wrap. Wider tables
 * scroll sideways under a first column that stays put, so a value is never read without the
 * name of its row; the scroll belongs to the system, and the held column is moved by the same
 * scroll offset on the UI thread, so it never trails the finger. A long table shows its first
 * rows and opens whole in a full-height sheet instead of becoming a second scroller inside the
 * Thread's own.
 */
export function Table({ table }: { table: TableKind }) {
  const [open, setOpen] = useState(false)
  const long = table.rows.length > PREVIEW_ROWS
  const note =
    table.note === undefined ? null : (
      <Label size="caption" tone="ink-2">
        {table.note}
      </Label>
    )
  return (
    <Frame title={table.title}>
      <Grid
        table={table}
        rows={long ? table.rows.slice(0, PREVIEW_ROWS) : table.rows}
        ground="surface-3"
      />
      {note}
      {long && (
        <Button label={`Show all ${table.rows.length} rows`} onPress={() => setOpen(true)} />
      )}
      {open && (
        <Sheet title={table.title} presentation="fullScreen" onClose={() => setOpen(false)}>
          <Grid table={table} rows={table.rows} ground="surface-0" />
          {note}
        </Sheet>
      )}
    </Frame>
  )
}

/** Chooses between the fitted and the held-column layouts by how many columns there are. */
function Grid({
  table,
  rows,
  ground,
}: {
  table: TableKind
  rows: TableKind['rows']
  ground: Ground
}) {
  const count = table.columns.length
  const all = [table.columns, ...rows.map((row) => rowCells(row, count))]
  if (count <= 2) {
    return (
      <View>
        {all.map((cells, index) => (
          <Row key={rowKey(index)} cells={cells} names={table.columns} header={index === 0} />
        ))}
      </View>
    )
  }
  return <Held names={table.columns} all={all} ground={ground} />
}

/** Header cells are small and quiet, a row's name is bold, and its values read at label size. */
const sizeOf = (header: boolean, column: number) => {
  if (header) return 'caption'
  return column === 0 ? 'footnote' : 'label'
}

const cellKey = (column: number) => `cell-${column}`

/** Rows have positions, not identifiers; position 0 is the header. */
const rowKey = (position: number) => `row-${position}`

/** The sideways scroller whose first column rides the scroll offset so it stays at the left edge. */
function Held({
  names,
  all,
  ground,
}: {
  names: ReadonlyArray<string>
  all: ReadonlyArray<ReadonlyArray<string>>
  ground: Ground
}) {
  const { colors: c } = useTheme()
  const scrolled = useSharedValue(0)
  const onScroll = useAnimatedScrollHandler((event) => {
    scrolled.set(event.contentOffset.x)
  })
  const held = useAnimatedStyle(() => ({ transform: [{ translateX: scrolled.get() }] }))
  // A hairline appears on the held column once something has slid beneath it, not before.
  const edge = useAnimatedStyle(() => ({
    opacity: interpolate(scrolled.get(), [0, 8], [0, 1], Extrapolation.CLAMP),
  }))
  return (
    <Animated.ScrollView
      horizontal
      nestedScrollEnabled
      scrollEventThrottle={16}
      showsHorizontalScrollIndicator={false}
      onScroll={onScroll}
    >
      <View style={{ width: FIRST + COLUMN * (names.length - 1) }}>
        {all.map((cells, index) => (
          <Row
            key={rowKey(index)}
            cells={cells}
            names={names}
            header={index === 0}
            held={{ style: held, edge, ground: c[ground], line: c.border }}
          />
        ))}
      </View>
    </Animated.ScrollView>
  )
}

interface Pin {
  readonly style: ReturnType<typeof useAnimatedStyle>
  readonly edge: ReturnType<typeof useAnimatedStyle>
  readonly ground: string
  readonly line: string
}

/**
 * One row. A screen reader reads it as one sentence ("Plan: Pro. Price: 12") rather than a
 * sweep of loose cells, so the header row stays out of its way.
 */
function Row({
  cells,
  names,
  header,
  held,
}: {
  cells: ReadonlyArray<string>
  names: ReadonlyArray<string>
  header: boolean
  held?: Pin
}) {
  const { colors: c } = useTheme()
  const reading = header ? undefined : names.map((name, i) => `${name}: ${cells[i]}`).join('. ')
  return (
    <View
      accessible={!header}
      accessibilityLabel={reading}
      importantForAccessibility={header ? 'no-hide-descendants' : 'auto'}
      accessibilityElementsHidden={header}
      style={{
        flexDirection: 'row',
        borderBottomWidth: HAIRLINE,
        borderBottomColor: c[header ? 'line-3' : 'line-2'],
      }}
    >
      {cells.map((cell, index) => {
        const text = (
          <Label
            size={sizeOf(header, index)}
            tone={header ? 'ink-3' : 'ink'}
            style={{ fontVariant: ['tabular-nums'] }}
          >
            {cell}
          </Label>
        )
        const space = {
          paddingVertical: header ? 8 : 11,
          paddingRight: 12,
          minHeight: header ? 0 : 44,
          justifyContent: 'center',
        } as const
        if (index === 0 && held !== undefined)
          return (
            <Animated.View
              // The column is above what scrolls under it, and opaque so nothing shows through.
              key={cellKey(index)}
              style={[space, { width: FIRST, zIndex: 1, backgroundColor: held.ground }, held.style]}
            >
              {text}
              <Animated.View
                pointerEvents="none"
                style={[
                  {
                    position: 'absolute',
                    top: 0,
                    right: 0,
                    bottom: 0,
                    width: HAIRLINE,
                    backgroundColor: held.line,
                  },
                  held.edge,
                ]}
              />
            </Animated.View>
          )
        const sized = held === undefined ? { flex: index === 0 ? 2 : 3 } : { width: COLUMN }
        return (
          <View key={cellKey(index)} style={[space, sized]}>
            {text}
          </View>
        )
      })}
    </View>
  )
}
