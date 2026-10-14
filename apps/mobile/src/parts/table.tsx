import { defineComponent } from '@openuidev/react-lang'
import { StyleSheet, Text, View } from 'react-native'
import { z } from 'zod/v4'
import { inline, runStyles } from './markdown'
import { mix, useSkin } from './style'

/**
 * The tabular part (`apps/web/vendor/openui/table.tsx`), drawn as rows of views. Each row lists
 * its cells in column order; a column whose cells are all numbers (or amounts like "$1.2k" and
 * "45%") aligns right, as the web's does. The header carries the app's hairline edge under it and
 * rows are separated by their own, not boxed.
 */
const NUMERIC = /^[-+−]?[$€£¥₹]?\s?\d[\d,]*(\.\d+)?\s?(%|[kKmMbB]|bn)?$/
const isElement = (value: unknown) =>
  !!value && typeof value === 'object' && (value as { type?: unknown }).type === 'element'
const NOTHING = /^(n\/a|\u2014|\u2013|-)$/i

// The runs of a body cell, in the skin in force. A cell's inline Markdown is drawn with them;
// their one direction that could answer, a link, does not open here, because a cell is data, not
// prose, and the phone's tables are for reading.
const cellRuns = (skin: ReturnType<typeof useSkin>) => ({
  ...runStyles(skin, () => undefined),
  base: { color: skin.ink },
})

export const Table = defineComponent({
  name: 'Table',
  props: z.object({
    columns: z.array(z.string()),
    rows: z.array(z.array(z.any())),
  }),
  description:
    'Each row lists its cells in column order; a cell may be a component. Number columns align right.',
  component: ({ props, renderNode }) => {
    const skin = useSkin()
    const columns = Array.isArray(props.columns) ? props.columns.map((c) => String(c ?? '')) : []
    const rows = (Array.isArray(props.rows) ? props.rows : []).filter(Array.isArray) as unknown[][]
    const numeric = columns.map((_, c) => {
      const cells = rows
        .map((r) => r[c])
        .filter((v) => v != null && v !== '' && !(typeof v === 'string' && NOTHING.test(v.trim())))
      return (
        cells.length > 0 &&
        cells.every(
          (v) => typeof v === 'number' || (typeof v === 'string' && NUMERIC.test(v.trim())),
        )
      )
    })
    const cell = (value: unknown) =>
      isElement(value) ? (
        <View style={styles.cellPart}>{renderNode(value)}</View>
      ) : typeof value === 'number' ? (
        value.toLocaleString('en-US', { maximumFractionDigits: 2 })
      ) : (
        inline(
          typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '',
          cellRuns(skin),
        )
      )
    return (
      <View style={styles.table}>
        <View style={[styles.row, styles.head, { borderBottomColor: skin.border }]}>
          {columns.map((c, i) => (
            <Text
              key={i}
              style={[styles.headCell, { color: skin.muted }, numeric[i] && styles.right]}
            >
              {c}
            </Text>
          ))}
        </View>
        {rows.map((row, r) => (
          <View
            key={r}
            style={[
              styles.row,
              styles.bodyRow,
              { borderBottomColor: mix(skin.border, skin.sheet, 0.5) },
            ]}
          >
            {columns.map((_, c) => (
              <Text key={c} style={[styles.cell, { color: skin.ink }, numeric[c] && styles.right]}>
                {cell(row[c])}
              </Text>
            ))}
          </View>
        ))}
      </View>
    )
  },
})

const styles = StyleSheet.create({
  table: { alignSelf: 'stretch' as const },
  row: { flexDirection: 'row' as const, gap: 8 },
  head: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingBottom: 4,
    minHeight: 30,
    alignItems: 'center' as const,
  },
  bodyRow: {
    minHeight: 34,
    alignItems: 'center' as const,
    paddingVertical: 4,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headCell: { fontSize: 12, lineHeight: 15, fontWeight: '600', flex: 1, flexWrap: 'wrap' as const },
  cell: { fontSize: 14, lineHeight: 19, flex: 1, flexWrap: 'wrap' as const },
  right: { textAlign: 'right' as const },
  cellPart: { flex: 1 },
})
