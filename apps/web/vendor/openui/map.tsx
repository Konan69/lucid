import { defineComponent, useIsStreaming } from '@openuidev/react-lang'
import { places } from '@vivid/state'
import { Option } from 'effect'
import { useRef } from 'react'
import { z } from 'zod/v4'
import { useColorScheme } from './scheme'

/**
 * A place on a `Map`, one of the media parts Vivid adds to OpenUI's library (`media.css`). It draws nothing itself: the map reads its props (OpenUI's `MapMarker`,
 * thesysdev/open-intelligent-ui `src/lib/components/map/map.tsx`, without its filter category,
 * since a map on a card has no filter).
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

/** The names a screen reader hears for the map: its places in order. */
const spoken = (pins: ReadonlyArray<places.Pin>) =>
  `Map of ${pins.map((pin) => pin.label).join(', ')}`

/**
 * A map fitted to its places, drawn as a picture (`places.frame` in `@vivid/state`, shared with
 * the phone): the basemap's tiles and their place names under the pins, and the line through the
 * places when the display asks for a route. It follows the light or dark look it sits in, read the
 * way OpenUI's own parts read it (`useColorScheme`). Until a
 * finished marker arrives it is the empty frame, so a map does not jump in from nothing.
 */
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
    const held = useRef<HTMLDivElement>(null)
    const dark = useColorScheme(held) === 'dark'
    const framed = places.frame(
      places.placesOf(markersOf(props.markers), arriving),
      props.route === true,
      dark,
    )
    return Option.match(framed, {
      onNone: () => <div ref={held} className="iui-map-slot vivid-map" aria-hidden />,
      onSome: (map) => (
        <div ref={held} className="iui-map-slot vivid-map" role="img" aria-label={spoken(map.pins)}>
          {map.tiles.map((tile) => (
            <span
              key={tile.key}
              className="vivid-map-tile"
              style={{
                left: `${tile.left}%`,
                top: `${tile.top}%`,
                width: `${map.tileWidth}%`,
                height: `${map.tileHeight}%`,
              }}
            >
              <img src={tile.base} alt="" referrerPolicy="no-referrer" draggable={false} />
              <img src={tile.names} alt="" referrerPolicy="no-referrer" draggable={false} />
            </span>
          ))}
          {map.line.length > 1 && (
            <svg
              className="vivid-map-line"
              viewBox={`0 0 ${places.FRAME.width} ${places.FRAME.height}`}
              preserveAspectRatio="none"
              aria-hidden
            >
              <polyline points={map.line.map((point) => `${point.x},${point.y}`).join(' ')} />
            </svg>
          )}
          {map.pins.map((pin) => (
            <span
              key={pin.key}
              className="vivid-map-pin"
              style={{ left: `${pin.left}%`, top: `${pin.top}%` }}
              aria-hidden
            >
              <span className="vivid-map-mark">{pin.mark}</span>
              <span className="vivid-map-label">{pin.label}</span>
            </span>
          ))}
          <span className="vivid-map-credit">{places.ATTRIBUTION}</span>
        </div>
      ),
    })
  },
})
