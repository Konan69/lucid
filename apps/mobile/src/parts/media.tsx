import { defineComponent } from '@openuidev/react-lang'
import { createElement, useState } from 'react'
import { Image as RNImage, StyleSheet, View } from 'react-native'
import { z } from 'zod/v4'
import { glyphOf } from './glyph'
import { color, mix, radiusSchema, useInk, useSkin } from './style'
import { Image as LucideImage } from 'lucide-react-native'

/**
 * The parts that name a picture or a mark (`apps/web/vendor/openui/media.tsx`), drawn as React
 * Native views. The schemas are the web's own.
 */

const ICON_SIZE = { sm: 14, md: 18, lg: 24, xl: 32 } as const

/** A lucide icon, tinted for where it stands. An unknown name draws nothing, as the web's does. */
function IconGlyph({ name, size, tint }: { name: string; size: number; tint: string }) {
  const Icon = glyphOf(name)
  return Icon ? createElement(Icon, { pointerEvents: 'none', size, strokeWidth: 1.8, color: tint }) : null
}

export const Icon = defineComponent({
  name: 'Icon',
  props: z.object({
    name: z.string(),
    size: z.enum(['sm', 'md', 'lg', 'xl']).optional(),
    color: color.optional(),
  }),
  description: 'Lucide icon by name, e.g. "map-pin".',
  component: ({ props }) => {
    const skin = useSkin()
    return (
      <View>
        <IconGlyph name={props.name} size={ICON_SIZE[props.size ?? 'md']} tint={useInk(props.color, skin)} />
      </View>
    )
  },
})

/**
 * A photo from src. Vivid has no photo search, so one that fails to load leaves the empty frame,
 * as the web's does: the frame keeps the aspect the display wrote, and the empty frame is a
 * picture that did not come, never a shape the display did not ask for.
 */
type Radius = 'sm' | 'md' | 'lg' | 'xl' | 'full' | number

function Photo({ query, src, aspectRatio, radius, fit: drawn, width }: { query: string; src?: string | null; aspectRatio?: number | null; radius?: Radius; fit?: string | null; width?: number | null }) {
  const skin = useSkin()
  const alt = typeof query === 'string' ? query.trim() : ''
  const [failed, setFailed] = useState<string[]>([])
  const at = typeof src === 'string' && !failed.includes(src) ? src : undefined
  const ratio = typeof aspectRatio === 'number' && aspectRatio > 0.2 && aspectRatio < 5 ? aspectRatio : 1.5
  return (
    <View
      accessibilityRole={at ? 'image' : undefined}
      accessibilityLabel={at ? undefined : alt}
      style={{
        aspectRatio: ratio,
        borderRadius: skin.radius(radius ?? 'lg'),
        width: typeof width === 'number' ? width : undefined,
        backgroundColor: mix(skin.accent, skin.sheet, 0.07),
        alignItems: 'center',
        justifyContent: 'center',
        overflow: 'hidden',
        flex: typeof width === 'number' ? undefined : 1,
      }}
    >
      {at ? (
        <RNImage
          key={at}
          source={{ uri: at }}
          style={[StyleSheet.absoluteFill, { resizeMode: drawn === 'contain' ? 'contain' : 'cover' }]}
          accessibilityLabel={alt}
          onError={() => setFailed((list) => [...list, at])}
        />
      ) : (
        // The empty frame's own quiet mark: the tint's own wash, whose icon reads as "a picture
        // was meant here", and the display's alt is what a screen reader says for it.
        <LucideImage pointerEvents="none" size={22} strokeWidth={1.5} color={mix(skin.accent, skin.sheet, 0.3)} />
      )}
    </View>
  )
}

export const Image = defineComponent({
  name: 'Image',
  props: z.object({
    src: z.string(),
    alt: z.string(),
    aspectRatio: z.number().optional(),
    radius: radiusSchema.optional(),
    fit: z.enum(['cover', 'contain']).optional(),
    width: z.number().optional(),
  }),
  description: 'Photo from an http(s) URL the user or a tool gave. alt says what it shows.',
  component: ({ props }) => (
    <Photo query={props.alt} src={props.src} aspectRatio={props.aspectRatio} radius={props.radius} fit={props.fit} width={props.width} />
  ),
})
