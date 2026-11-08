import { defineComponent } from '@openuidev/react-lang'
import { Option } from 'effect'
import { useState, type ReactNode } from 'react'
import { Image as RNImage, StyleSheet, Text, View } from 'react-native'
import { z } from 'zod/v4'
import { openWebLink } from '../data/links'
import { Press } from '../ui/motion/Pressable'
import { useSkin, webUrl } from './style'

/**
 * The web's `Page` (`apps/web/vendor/openui/page.tsx`) drawn as native views: a web page as a card
 * with its picture, site, title and summary, which opens the page in the browser the way every
 * link in the app does (`openWebLink`). A picture that does not load leaves the card without one;
 * an address that is not a web page draws the card, not pressable.
 */

/** The site a page is on, as its address says it, when the display did not name it. */
const siteOf = (address: string) =>
  Option.getOrElse(
    Option.map(Option.liftThrowable((text: string) => new URL(text))(address), (url) =>
      url.hostname.replace(/^www\./u, ''),
    ),
    () => '',
  )

export const Page = defineComponent({
  name: 'Page',
  props: z.object({
    url: z.string(),
    title: z.string(),
    site: z.string().optional(),
    image: z.string().optional(),
    summary: z.string().optional(),
  }),
  description:
    'A web page as a card that opens it: its title, the site, its picture and a short summary. Only an address and picture a tool or the Person gave you.',
  component: function Unfurled({ props }) {
    const skin = useSkin()
    const [broken, setBroken] = useState(false)
    const address = Option.fromNullOr(webUrl(props.url))
    const picture = Option.fromNullOr(webUrl(props.image))
    const named = props.site === undefined ? '' : props.site.trim()
    const site = named !== '' ? named : Option.match(address, { onNone: () => '', onSome: siteOf })
    const summary = props.summary === undefined ? '' : props.summary.trim()
    const inner = (
      <>
        {Option.isSome(picture) && !broken && (
          <RNImage
            source={{ uri: picture.value }}
            onError={() => setBroken(true)}
            style={[styles.image, { backgroundColor: skin.codeBackground }]}
          />
        )}
        <View style={styles.body}>
          {site !== '' && (
            <Text numberOfLines={1} style={[styles.site, { color: skin.muted }]}>
              {site}
            </Text>
          )}
          <Text numberOfLines={2} style={[styles.title, { color: skin.ink }]}>
            {props.title}
          </Text>
          {summary !== '' && (
            <Text numberOfLines={3} style={[styles.summary, { color: skin.muted }]}>
              {summary}
            </Text>
          )}
        </View>
      </>
    )
    const frame = [styles.card, { borderColor: skin.borderStrong }]
    return Option.match(address, {
      onNone: (): ReactNode => <View style={frame}>{inner}</View>,
      onSome: (href) => (
        <Press
          accessibilityRole="link"
          accessibilityLabel={`${props.title}, ${site}`}
          onPress={() => void openWebLink(href)}
          style={({ pressed }) => [frame, { opacity: pressed ? 0.7 : 1 }]}
        >
          {inner}
        </Press>
      ),
    })
  },
})

const styles = StyleSheet.create({
  card: { borderRadius: 16, borderWidth: 1, overflow: 'hidden' },
  image: { width: '100%', aspectRatio: 1.91 },
  body: { gap: 2, paddingHorizontal: 14, paddingTop: 12, paddingBottom: 14 },
  site: { fontSize: 12, lineHeight: 17 },
  title: { fontSize: 16, lineHeight: 21, fontWeight: '600' },
  summary: { marginTop: 2, fontSize: 14, lineHeight: 20 },
})
