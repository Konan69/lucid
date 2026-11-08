import { defineComponent, useIsStreaming } from '@openuidev/react-lang'
import { places } from '@vivid/state'
import { Option } from 'effect'
import { Image as RNImage, StyleSheet, Text, View } from 'react-native'
import Svg, { Polyline } from 'react-native-svg'
import { z } from 'zod/v4'
import { useTheme } from '../theme'
import { mix, useSkin } from './style'

/**
 * The web's `Map` and `MapMarker` (`apps/web/vendor/openui/map.tsx`) drawn as native views. The
 * schemas and descriptions are the web's own, and the picture is the same one: `places.frame` in
 * `@vivid/state` lays out the tiles, the pins and the line in percent of a 16:10 frame, so a pin
 * stands on the same street on both surfaces. The tiles are plain images, so no map module is
 * needed in the binary.
 */

export const MapMarker = defineComponent({
  name: 'MapMarker',
  props: z.object({
    label: z.string(),
    lat: z.number(),
    lng: z.number(),
    icon: z.string().optional(),
  }),
  description: 'A place on a Map; icon is one emoji, else the pin shows its number.',
  component: () => null,
})

/** The markers as OpenUI hands them over, each read once (`places.readMarker`). */
const markersOf = (markers: unknown) =>
  (Array.isArray(markers) ? markers.flat() : []).map((marker) => places.readMarker(marker))

/** A pin's box: wide enough for its name, centred on its place by its own half width. */
const PIN_WIDTH = 140
/** The round mark is 26 points, so its middle stands 13 above its top. */
const MARK = 26

export const MapView = defineComponent({
  name: 'Map',
  props: z.object({
    markers: z.array(MapMarker.ref),
    route: z.boolean().optional(),
  }),
  description:
    'A picture of a map fitted to its markers, for where something is or a route; route draws a line through the markers in order.',
  component: function Drawn({ props }) {
    const arriving = useIsStreaming()
    const { dark } = useTheme()
    const skin = useSkin()
    const framed = places.frame(
      places.placesOf(markersOf(props.markers), arriving),
      props.route === true,
      dark,
    )
    const frameStyle = [
      styles.frame,
      { backgroundColor: mix(skin.info, skin.sheet, 0.08), borderColor: skin.border },
    ]
    return Option.match(framed, {
      onNone: () => <View style={frameStyle} />,
      onSome: (map) => (
        <View
          style={frameStyle}
          accessible
          accessibilityRole="image"
          accessibilityLabel={`Map of ${map.pins.map((pin) => pin.label).join(', ')}`}
        >
          {map.tiles.map((tile) => (
            <View
              key={tile.key}
              pointerEvents="none"
              style={{
                position: 'absolute',
                left: `${tile.left}%`,
                top: `${tile.top}%`,
                width: `${map.tileWidth}%`,
                height: `${map.tileHeight}%`,
              }}
            >
              <RNImage source={{ uri: tile.base }} style={StyleSheet.absoluteFill} />
              <RNImage source={{ uri: tile.names }} style={StyleSheet.absoluteFill} />
            </View>
          ))}
          {map.line.length > 1 && (
            <Svg
              pointerEvents="none"
              style={StyleSheet.absoluteFill}
              viewBox={`0 0 ${places.FRAME.width} ${places.FRAME.height}`}
              preserveAspectRatio="none"
            >
              <Polyline
                points={map.line.map((point) => `${point.x},${point.y}`).join(' ')}
                fill="none"
                stroke={skin.info}
                strokeWidth={3}
                strokeLinecap="round"
                strokeLinejoin="round"
                vectorEffect="non-scaling-stroke"
              />
            </Svg>
          )}
          {map.pins.map((pin) => (
            <View
              key={pin.key}
              pointerEvents="none"
              style={[styles.pin, { left: `${pin.left}%`, top: `${pin.top}%` }]}
            >
              <View style={[styles.mark, { backgroundColor: skin.info, borderColor: skin.sheet }]}>
                <Text style={styles.markText}>{pin.mark}</Text>
              </View>
              <Text
                numberOfLines={1}
                style={[
                  styles.label,
                  { color: skin.ink, backgroundColor: mix(skin.sheet, skin.info, 0.88) },
                ]}
              >
                {pin.label}
              </Text>
            </View>
          ))}
          <Text
            style={[
              styles.credit,
              { color: skin.muted, backgroundColor: mix(skin.sheet, skin.info, 0.7) },
            ]}
          >
            {places.ATTRIBUTION}
          </Text>
        </View>
      ),
    })
  },
})

const styles = StyleSheet.create({
  frame: {
    width: '100%',
    aspectRatio: places.FRAME.width / places.FRAME.height,
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  pin: {
    position: 'absolute',
    width: PIN_WIDTH,
    marginLeft: -PIN_WIDTH / 2,
    marginTop: -MARK / 2,
    alignItems: 'center',
    gap: 3,
  },
  mark: {
    width: MARK,
    height: MARK,
    borderRadius: MARK / 2,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  markText: {
    color: '#ffffff',
    fontSize: 12,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
  },
  label: {
    maxWidth: PIN_WIDTH - 8,
    paddingHorizontal: 7,
    borderRadius: 9,
    overflow: 'hidden',
    fontSize: 11,
    lineHeight: 18,
    fontWeight: '500',
  },
  credit: {
    position: 'absolute',
    right: 6,
    bottom: 4,
    paddingHorizontal: 5,
    borderRadius: 4,
    overflow: 'hidden',
    fontSize: 9,
    lineHeight: 14,
  },
})
