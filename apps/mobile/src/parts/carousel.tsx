import { defineComponent } from '@openuidev/react-lang'
import { ScrollView, View } from 'react-native'
import { z } from 'zod/v4'
import { children, useSkin } from './style'

/**
 * The snapping row (`apps/web/vendor/openui/carousel.tsx`), drawn as a paging horizontal scroll.
 * On the phone the finger is the pager, so the web's own arrow chrome is not drawn: a swipe pans
 * and the snap stops the swipe where a whole item stands. The web's `itemWidth` is honoured by
 * drawing each child at that width, and the scroll's own gaps carry the `gap`, in the 4px steps
 * every part's distance is written in.
 */
export const Carousel = defineComponent({
  name: 'Carousel',
  props: z.object({ children, itemWidth: z.number().optional(), gap: z.number().optional() }),
  description:
    'Horizontal row that scrolls and snaps, each child an item itemWidth px wide (default 240): photos, cards, options, days.',
  component: ({ props, renderNode }) => {
    const skin = useSkin()
    void skin
    const items = (Array.isArray(props.children) ? props.children.flat() : []).filter((c) => c != null)
    const width = Math.min(640, Math.max(80, props.itemWidth ?? 240))
    return (
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        pagingEnabled={false}
        snapToInterval={width + Math.max(0, props.gap ?? 0) * 4}
        decelerationRate="fast"
        contentContainerStyle={{ gap: Math.max(0, props.gap ?? 0) * 4, paddingVertical: 2 }}
      >
        {items.map((item, i) => (
          // An item is drawn at the width the display wrote for it, and never squeezed: the scroll
          // owns the room.
          <View key={i} style={{ width, flexShrink: 0 }}>
            {renderNode(item)}
          </View>
        ))}
      </ScrollView>
    )
  },
})
