import { defineComponent, FormNameContext } from '@openuidev/react-lang'
import { useState, type ReactNode } from 'react'
import type { ViewStyle } from 'react-native'
import { StyleSheet, View } from 'react-native'
import { z } from 'zod/v4'
import {
  children,
  color,
  contrastOn,
  length,
  OnColorContext,
  radiusSchema,
  sizeOf,
  space,
  useSkin,
} from './style'

/**
 * The parts that arrange (`apps/web/vendor/openui/layout.tsx`), drawn as React Native views. The
 * schemas and descriptions are the web's own. Flex reads the same on both: a column without a gap
 * spaces its blocks like an article (the display's own spacing), a Row centres its items, and a
 * Box lays out one way around. A `color` prop resolves through the skin in force, so a display
 * follows the Person's theme the way the web's CSS variables carry it.
 */

const align = z.enum(['start', 'center', 'end', 'stretch'])
const justify = z.enum(['start', 'center', 'end', 'between'])
const ALIGN = {
  start: 'flex-start',
  end: 'flex-end',
  center: 'center',
  stretch: 'stretch',
} as const
const JUSTIFY = {
  start: 'flex-start',
  end: 'flex-end',
  center: 'center',
  between: 'space-between',
} as const

/** Flex alignment and spacing, shared by every arranging part. Alignment and positioning name
 * different RN keys, and a value has no meaning under the other key. */
function flexStyle(p: {
  gap?: number
  align?: string
  justify?: string
  wrap?: boolean
}): ViewStyle {
  return {
    gap: space(p.gap),
    alignItems: p.align ? ALIGN[p.align as keyof typeof ALIGN] : undefined,
    justifyContent: p.justify ? JUSTIFY[p.justify as keyof typeof JUSTIFY] : undefined,
    flexWrap: p.wrap ? 'wrap' : undefined,
  }
}

export const Box = defineComponent({
  name: 'Box',
  props: z.object({
    children: children.optional(),
    direction: z.enum(['row', 'col']).optional(),
    gap: z.number().optional(),
    padding: z.number().optional(),
    background: color.optional(),
    radius: radiusSchema.optional(),
    border: z.boolean().optional(),
    width: length.optional(),
    height: length.optional(),
    flex: z.number().optional(),
    align: align.optional(),
    justify: justify.optional(),
    wrap: z.boolean().optional(),
  }),
  description: 'Flex container, a column by default. radius also clips the content.',
  component: ({ props, renderNode }) => {
    const skin = useSkin()
    const row = props.direction === 'row'
    const background = skin.bg(props.background)
    // Text on a model-chosen raw colour does not follow the theme, so it is set dark or light to
    // stay legible (the web's `onColor`), and the word-parts under it resolve to it.
    const on = contrastOn(background ?? '')
    return (
      <View
        style={[
          flexStyle(props),
          !row && props.gap == null && styles.article,
          {
            padding: space(props.padding),
            backgroundColor: background,
            borderRadius: skin.radius(props.radius),
            overflow: props.radius !== undefined ? ('hidden' as const) : undefined,
            borderWidth: props.border ? 1 : undefined,
            borderColor: skin.border,
            width: sizeOf(props.width),
            height: sizeOf(props.height),
            // null, like an omitted argument, means no flex. A width in px is meant: a Row with
            // long text beside it must not squeeze it.
            flex:
              props.flex != null ? Math.max(0, props.flex) : props.width != null ? 0 : undefined,
            flexGrow: props.flex != null ? Math.max(0, props.flex) : undefined,
            flexShrink: props.flex != null ? 1 : undefined,
            flexBasis: props.flex != null ? 0 : undefined,
          },
        ]}
      >
        <OnColorContext.Provider value={on}>{renderNode(props.children)}</OnColorContext.Provider>
      </View>
    )
  },
})

export const Row = defineComponent({
  name: 'Row',
  props: z.object({
    children,
    gap: z.number().optional(),
    align: align.optional(),
    justify: justify.optional(),
    wrap: z.boolean().optional(),
  }),
  description: 'Horizontal layout; items are vertically centered.',
  component: ({ props, renderNode }) => (
    <View style={[flexStyle(props), styles.row]}>{renderNode(props.children)}</View>
  ),
})

export const Col = defineComponent({
  name: 'Col',
  props: z.object({ children, gap: z.number().optional(), align: align.optional() }),
  description: 'Vertical layout. Without gap it spaces blocks like an article.',
  component: ({ props, renderNode }) => (
    <View style={[flexStyle(props), props.gap == null && styles.article]}>
      {renderNode(props.children)}
    </View>
  ),
})

export const Grid = defineComponent({
  name: 'Grid',
  props: z.object({
    children,
    columns: z.number().optional(),
    minChildWidth: z.number().optional(),
    gap: z.number().optional(),
  }),
  description:
    'Equal columns (default 2). With minChildWidth (px), columns drop on narrow screens.',
  component: ({ props, renderNode }) => <GridRows {...props} renderNode={renderNode} />,
})

/**
 * Equal columns, laid out by hand: the phone has no CSS `grid`, and a `minChildWidth` means the
 * column count drops on a narrow display, which only its own width can answer. The children are
 * cut into rows of that count and each cell is given an equal share, `gap` between them.
 */
function GridRows(props: {
  children?: unknown
  columns?: number
  minChildWidth?: number
  gap?: number
  renderNode: (node: unknown) => ReactNode
}) {
  const gap = space(props.gap) ?? 12
  const parts = (Array.isArray(props.children) ? props.children.flat() : []).filter(
    (c) => c != null,
  )
  const ordered = Math.min(6, Math.max(1, Math.round(props.columns ?? 2)))
  const [width, setWidth] = useState<number | null>(null)
  // At most `columns` columns, each at least `minChildWidth` wide; fewer when they would not fit.
  const columns =
    width == null || props.minChildWidth == null || props.minChildWidth <= 0
      ? ordered
      : Math.max(1, Math.min(ordered, Math.floor((width + gap) / (props.minChildWidth + gap))))
  const rows: unknown[][] = []
  for (let start = 0; start < parts.length; start += columns)
    rows.push(parts.slice(start, start + columns))
  return (
    <View
      onLayout={(event) => {
        const read = Math.floor(event.nativeEvent.layout.width)
        setWidth((drawn) => (drawn === read ? drawn : read))
      }}
      style={{ gap }}
    >
      {rows.map((row, r) => (
        <View key={r} style={{ flexDirection: 'row', gap }}>
          {row.map((part, i) => (
            <View key={i} style={{ flex: 1, minWidth: 0 }}>
              {props.renderNode(part)}
            </View>
          ))}
        </View>
      ))}
    </View>
  )
}

export const Card = defineComponent({
  name: 'Card',
  props: z.object({
    children,
    variant: z.enum(['outline', 'soft']).optional(),
    padding: z.number().optional(),
    gap: z.number().optional(),
  }),
  description: 'Panel with a border; soft is a filled panel for summaries.',
  component: ({ props, renderNode }) => {
    const skin = useSkin()
    // The web's skin draws a display's card as a raised sheet on the tint, with the app's hairline
    // edge; `outline` keeps the tint through and draws only the edge.
    return (
      <View
        style={[
          styles.sheet,
          {
            padding: space(props.padding) ?? 12,
            gap: space(props.gap),
            backgroundColor: props.variant === 'soft' ? skin.sheet : undefined,
            borderWidth: 1,
            borderColor: skin.border,
          },
          props.gap == null && styles.article,
        ]}
      >
        {renderNode(props.children)}
      </View>
    )
  },
})

export const Divider = defineComponent({
  name: 'Divider',
  props: z.object({}),
  description: '',
  component: () => {
    const skin = useSkin()
    return <View style={[styles.hairline, { backgroundColor: skin.border }]} />
  },
})

export const Spacer = defineComponent({
  name: 'Spacer',
  props: z.object({}),
  description: 'Fills the free space in a Row.',
  component: () => <View style={styles.grow} />,
})

export const Form = defineComponent({
  name: 'Form',
  props: z.object({ children }),
  description: 'Groups fields; their values go with any @ToAssistant inside.',
  component: ({ props, renderNode, statementId }) => (
    // The form's name is what its fields' values are stored under, so a press inside it reads the
    // fields of this group — the renderer's own context, as the web's form does.
    <FormNameContext.Provider value={statementId}>
      <View style={styles.article}>{renderNode(props.children)}</View>
    </FormNameContext.Provider>
  ),
})

const styles = StyleSheet.create({
  /** The display's own rhythm when a column names no gap of its own. */
  article: { gap: 12 },
  row: { alignItems: 'center' },
  sheet: { borderRadius: 16, overflow: 'hidden' as const },
  hairline: { height: StyleSheet.hairlineWidth, alignSelf: 'stretch' as const },
  grow: { flexGrow: 1 },
})
