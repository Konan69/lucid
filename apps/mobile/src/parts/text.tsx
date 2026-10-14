import { defineComponent } from '@openuidev/react-lang'
import { Fragment } from 'react'
import { StyleSheet, Text as RNText, View, type StyleProp, type TextStyle } from 'react-native'
import { z } from 'zod/v4'
import { inline, runStyles } from './markdown'
import { children, color, mix, useSkin, webUrl } from './style'
import { openWebLink } from '../data/links'

/**
 * The parts that read as words (`apps/web/vendor/openui/text.tsx`), drawn as React Native text.
 * The schemas and descriptions are the web's own; only the drawing differs, and the sizes read
 * the phone's type steps where the web reads its CSS scale: a display's words are the reply's
 * words, so they lead with the reading size and shrink from it. A link opens in the browser the
 * way the app's own words do (`apps/mobile/src/data/links.ts` `openWebLink`), one door for
 * both so a Person learns it once.
 */
const str = (value: unknown) => (typeof value === 'string' ? value : value == null ? '' : typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString('en-US', { maximumFractionDigits: 2 }) : '')

/** A `color` token or plain colour, falling back to the display's own ink. */
const inked = {
  using: (skin: ReturnType<typeof useSkin>, value: string | undefined): string => skin.fg(value) ?? skin.ink,
}

// Title sizes: the web's named steps, on the phone's scale. 3xl is a whole display's opening
// number, which on the phone is the reading scale's largest step.
const TITLE = {
  sm: { fontSize: 13, lineHeight: 17, fontWeight: '600' },
  md: { fontSize: 16, lineHeight: 21, fontWeight: '600' },
  lg: { fontSize: 18, lineHeight: 23, fontWeight: '600', letterSpacing: -0.2 },
  xl: { fontSize: 21, lineHeight: 27, fontWeight: '700', letterSpacing: -0.3 },
  '2xl': { fontSize: 26, lineHeight: 32, fontWeight: '700', letterSpacing: -0.4 },
  '3xl': { fontSize: 30, lineHeight: 36, fontWeight: '700', letterSpacing: -0.5 },
} satisfies Record<string, TextStyle>

export const Title = defineComponent({
  name: 'Title',
  props: z.object({
    text: z.string(),
    size: z.enum(['sm', 'md', 'lg', 'xl', '2xl', '3xl']).optional(),
    color: color.optional(),
  }),
  description: 'Heading; lg for a card title, 2xl for a big number.',
  component: ({ props }) => {
    const skin = useSkin()
    return <RNText style={[TITLE[props.size ?? 'md'], { color: inked.using(skin, props.color) }]}>{str(props.text)}</RNText>
  },
})

/** Text, or a run of strings and inline components such as Icon, Badge, Link or Math. */
const richText = z.union([z.string(), children])
const isNode = (value: unknown) => !!value && typeof value === 'object' && (value as { type?: unknown }).type === 'element'

// The reading text's steps, drawn from the phone's own (`data/typography.ts`).
const BODY = {
  xs: { fontSize: 13, lineHeight: 17 },
  sm: { fontSize: 14, lineHeight: 19 },
  md: { fontSize: 16, lineHeight: 23 },
  lg: { fontSize: 18, lineHeight: 25 },
} satisfies Record<string, TextStyle>

export const Text = defineComponent({
  name: 'Text',
  props: z.object({
    text: richText,
    size: z.enum(['xs', 'sm', 'md', 'lg']).optional(),
    color: color.optional(),
    weight: z.enum(['normal', 'medium', 'semibold']).optional(),
    italic: z.boolean().optional(),
    lineThrough: z.boolean().optional(),
    tabularNums: z.boolean().optional(),
    maxLines: z.number().optional(),
  }),
  description:
    'Paragraph; supports **bold**, *italic*, `code` and [links](https://…). text may be a list mixing strings and inline components: [Icon("clock", "sm"), " 25 min · ", Badge("Easy")].',
  component: ({ props, renderNode }) => {
    const skin = useSkin()
    const runs = runStyles(skin, openLink)
    const weight = { normal: '400', medium: '500', semibold: '600' } satisfies Record<string, TextStyle['fontWeight']>
    const lines = props.maxLines && props.maxLines > 0 ? Math.round(props.maxLines) : undefined
    const own: StyleProp<TextStyle> = [
      BODY[props.size ?? 'md'],
      {
        color: inked.using(skin, props.color),
        fontWeight: props.weight ? weight[props.weight] : undefined,
        fontStyle: props.italic ? 'italic' : undefined,
        textDecorationLine: props.lineThrough ? 'line-through' : undefined,
        fontVariant: props.tabularNums ? ['tabular-nums'] : undefined,
      },
    ]
    // A string draws through the same inline runner as one string in a mixed list, so a paragraph
    // and a run of parts read as one kind of text. An inline part is drawn where it stands: the
    // phone has no `innerText` to pull its words back out of.
    return (
      <RNText numberOfLines={lines} style={own}>
        {Array.isArray(props.text)
          ? (props.text as unknown[]).flat().map((part, i) =>
              isNode(part) ? (
                <View key={i} style={styles.inline}>
                  {renderNode(part)}
                </View>
              ) : (
                <Fragment key={i}>{inline(str(part), runs, `t${i}`)}</Fragment>
              ),
            )
          : inline(str(props.text), runs)}
      </RNText>
    )
  },
})

export const Caption = defineComponent({
  name: 'Caption',
  props: z.object({ text: z.string(), color: color.optional() }),
  description: 'Small secondary text.',
  component: ({ props }) => {
    const skin = useSkin()
    return <RNText style={[styles.caption, { color: inked.using(skin, props.color) ?? skin.faint }]}>{inline(str(props.text), runStyles(skin, openLink))}</RNText>
  },
})

export const Label = defineComponent({
  name: 'Label',
  props: z.object({ text: z.string() }),
  description: 'Field or group label.',
  component: ({ props }) => {
    const skin = useSkin()
    return <RNText style={[styles.label, { color: skin.muted }]}>{str(props.text)}</RNText>
  },
})

export const Badge = defineComponent({
  name: 'Badge',
  props: z.object({
    text: z.string(),
    color: z.enum(['neutral', 'info', 'success', 'warning', 'danger', 'purple', 'pink']).optional(),
  }),
  description: '',
  component: ({ props }) => {
    const skin = useSkin()
    // Every status kind but `neutral` fills with its own soft tint and reads in that status's
    // colour, as the web's badge does; a nameless badge is quiet, a wash of the display's tint.
    const tinted = props.color != null && props.color !== 'neutral'
    return (
      <View style={[styles.badge, { backgroundColor: tinted ? skin.bg(props.color) : mix(skin.accent, skin.sheet, 0.1) }]}>
        <RNText style={[styles.badgeText, { color: tinted ? skin.fg(props.color) : skin.muted }]}>{str(props.text)}</RNText>
      </View>
    )
  },
})

export const Link = defineComponent({
  name: 'Link',
  props: z.object({ text: z.string(), url: z.string() }),
  description: 'Opens an http(s) URL in a new tab.',
  component: ({ props }) => {
    const skin = useSkin()
    const href = webUrl(props.url)
    if (!href) return <RNText style={styles.body}>{str(props.text)}</RNText>
    return (
      <RNText style={[styles.link, { color: skin.accent }]} onPress={() => openLink(href)}>
        {str(props.text) || new URL(href).hostname}
      </RNText>
    )
  },
})

type ItemElement = { type: 'element'; typeName: string; props: Record<string, unknown> }
const isItem = (value: unknown): value is ItemElement =>
  !!value && typeof value === 'object' && (value as ItemElement).type === 'element' && (value as ItemElement).typeName === 'ListItem'

export const ListItem = defineComponent({
  name: 'ListItem',
  props: z.object({
    title: z.string(),
    description: z.string().optional(),
    marker: z.string().optional(),
    children: children.optional(),
  }),
  description: 'marker replaces the bullet or number, e.g. a time or an emoji.',
  // Rendered by List; on its own it shows its content.
  component: ({ props, renderNode }) => {
    const skin = useSkin()
    return (
      <View>
        <RNText style={[styles.listTitle, { color: skin.ink }]}>{inline(str(props.title), runStyles(skin, openLink))}</RNText>
        {props.description ? <RNText style={[styles.listDescription, { color: skin.muted }]}>{inline(str(props.description), runStyles(skin, openLink))}</RNText> : null}
        {props.children ? <View style={styles.listChildren}>{renderNode(props.children)}</View> : null}
      </View>
    )
  },
})

export const List = defineComponent({
  name: 'List',
  props: z.object({
    items: z.array(z.union([z.string(), ListItem.ref])),
    marker: z.enum(['bullet', 'number', 'none']).optional(),
    timeline: z.boolean().optional(),
  }),
  description: 'timeline joins the markers with a line.',
  component: ({ props, renderNode }) => {
    const skin = useSkin()
    const items = (Array.isArray(props.items) ? props.items.flat() : []) as unknown[]
    const marker = props.marker ?? 'bullet'
    return (
      <View style={styles.list}>
        {items.map((item, i) => {
          if (item == null) return null
          const custom = isItem(item) && typeof item.props.marker === 'string' && item.props.marker ? item.props.marker : null
          const number = marker === 'number' ? `${i + 1}.` : marker === 'bullet' ? '•' : ''
          return (
            <View key={i} style={styles.listRow}>
              <RNText                 // A long marker (a time, a word) sits in its own share; a bullet or number is a
                // tick in the same column, so the words line up under each other.
                style={[styles.listMarker, { color: custom ? skin.muted : skin.faint }]}
              >
                {custom ?? number}
              </RNText>
              {isItem(item) ? renderNode(item) : <RNText style={styles.listBody}>{inline(str(item), runStyles(skin, openLink))}</RNText>}
            </View>
          )
        })}
      </View>
    )
  },
})

// The runs' code face, and where a link goes. `openWebLink` reports a door it could not pass; a
// display's link is one of the app's, so a dead one says so the same way the words' links do.
const openLink = (url: string) => {
  void openWebLink(url)
}

const styles = StyleSheet.create({
  caption: { fontSize: 12, lineHeight: 15 },
  label: { fontSize: 12, lineHeight: 15, fontWeight: '500' },
  body: { fontSize: 16, lineHeight: 23 },
  link: { fontSize: 16, lineHeight: 23, textDecorationLine: 'underline' },
  badge: {
    alignSelf: 'flex-start',
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  badgeText: { fontSize: 11, lineHeight: 14, fontWeight: '500' },
  list: { gap: 6 },
  listRow: { flexDirection: 'row', gap: 4 },
  listMarker: { fontSize: 16, lineHeight: 23, minWidth: 14 },
  listBody: { flexShrink: 1, fontSize: 16, lineHeight: 23, flex: 1 },
  listTitle: { fontSize: 16, lineHeight: 23 },
  listDescription: { fontSize: 14, lineHeight: 19 },
  listChildren: { marginTop: 4 },
  inline: { alignSelf: 'center' },
})
