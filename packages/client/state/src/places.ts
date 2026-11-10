import { Option, Schema } from 'effect'

/**
 * A map on a display, framed once for every surface. The web and the phone draw the `Map` part
 * from the same picture: map tiles laid out in a fixed frame, pins over them, and the line through
 * the places when the display asks for one. Everything is in percentages of the frame, so the
 * frame scales to whatever holds it and the two surfaces cannot place a pin differently.
 *
 * The part is OpenUI's (thesysdev/open-intelligent-ui `src/lib/components/map/map.tsx`, `MapView`
 * and `MapMarker`): the same markers, the same rule for a pin (one emoji, else its number) and the
 * same order for the line. What differs is how it is drawn. The reference runs MapLibre over
 * OpenFreeMap vector tiles, a browser-only canvas; the phone has no map module, and adding one is
 * a new binary. So both surfaces draw the reference's raster basemap (`basemap.ts`
 * `rasterStyle`, Esri's tiles) as plain images: Esri's grey canvas, light and dark, which is the
 * reference's own restrained cartography in tile form, with its place names on a second layer.
 * The map is a picture on a card, so it does not pan or zoom; the reference's filter, expand and
 * street routing go with the canvas.
 */

/** The frame every map is laid out in, in Web Mercator pixels at the chosen zoom (16:10). */
export const FRAME = { width: 640, height: 400 } as const

/** Map tiles are 256 pixels a side (Esri's `tile/{z}/{y}/{x}` service). */
const TILE = 256

/** Room around the places: pins stand on their point and their names hang under them. */
const PAD = { x: 72, top: 44, bottom: 60 } as const

/** Esri's grey canvas stops at 16; one place alone is shown at street level, short of that. */
const MAX_ZOOM = 15
const ONE_PLACE_ZOOM = 14

/** A place the display put on the map, decoded from its `MapMarker`. */
export interface Place {
  readonly label: string
  readonly lat: number
  readonly lng: number
  /** What the pin shows: the marker's emoji, else its number in the display's order. */
  readonly mark: string
}

/** A marker as OpenUI hands it to the part: an element whose props are still the model's. */
const Marker = Schema.Struct({
  type: Schema.Literal('element'),
  partial: Schema.optional(Schema.Boolean),
  props: Schema.Struct({
    label: Schema.Trim.pipe(Schema.check(Schema.isNonEmpty())),
    lat: Schema.Finite.pipe(Schema.check(Schema.isBetween({ minimum: -85, maximum: 85 }))),
    lng: Schema.Finite.pipe(Schema.check(Schema.isBetween({ minimum: -180, maximum: 180 }))),
    icon: Schema.optional(Schema.String),
  }),
})
export type Marker = typeof Marker.Type

/**
 * One of the `Map`'s markers read at the part, where OpenUI's element first reaches Vivid. One
 * that does not read (a label still empty, a latitude still being written) is `None`.
 */
export const readMarker = Schema.decodeUnknownOption(Marker)

/**
 * Whether a code point is an emoji. The reference asks `\p{Extended_Pictographic}` of a grapheme
 * from `Intl.Segmenter`; the phone's engine has neither, so the emoji blocks are named here.
 */
const isEmoji = (point: number) =>
  (point >= 0x1f000 && point <= 0x1faff) ||
  (point >= 0x2600 && point <= 0x27bf) ||
  (point >= 0x2300 && point <= 0x23ff) ||
  (point >= 0x2b00 && point <= 0x2bff)

/** The marker's icon when it is one emoji, so a word from the model can never overflow a pin. */
const emojiOf = (icon: string): Option.Option<string> =>
  Option.filter(Option.fromUndefinedOr(Array.from(icon.trim())[0]), (first) => {
    const point = first.codePointAt(0)
    return point !== undefined && isEmoji(point)
  })

/**
 * The places of a `Map` in the display's order, from its markers as `readMarker` read them. While
 * the reply is still arriving only finished markers count, so a half-written "-12" never moves a
 * pin (the reference's `placesOf`). The pin's number keeps the marker's place in the display.
 */
export const placesOf = (
  markers: ReadonlyArray<Option.Option<Marker>>,
  arriving: boolean,
): ReadonlyArray<Place> =>
  markers.flatMap((marker, order) => {
    if (Option.isNone(marker) || (arriving && marker.value.partial === true)) return []
    const { label, lat, lng, icon } = marker.value.props
    const mark = Option.getOrElse(Option.flatMap(Option.fromUndefinedOr(icon), emojiOf), () =>
      String(order + 1),
    )
    return [{ label, lat, lng, mark }]
  })

/** A point in Web Mercator pixels at zoom 0, so any zoom is a multiplication. */
const world = (place: { readonly lat: number; readonly lng: number }) => {
  const sin = Math.sin((place.lat * Math.PI) / 180)
  return {
    x: ((place.lng + 180) / 360) * TILE,
    y: (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * TILE,
  }
}

/** The deepest zoom at which every place fits inside the frame's padding. */
const zoomFor = (points: ReadonlyArray<{ readonly x: number; readonly y: number }>) => {
  if (points.length < 2) return ONE_PLACE_ZOOM
  const xs = points.map((point) => point.x)
  const ys = points.map((point) => point.y)
  const wide = Math.max(...xs) - Math.min(...xs)
  const tall = Math.max(...ys) - Math.min(...ys)
  const room = { wide: FRAME.width - 2 * PAD.x, tall: FRAME.height - PAD.top - PAD.bottom }
  for (let zoom = MAX_ZOOM; zoom > 0; zoom -= 1) {
    const scale = 2 ** zoom
    if (wide * scale <= room.wide && tall * scale <= room.tall) return zoom
  }
  return 0
}

/** One tile image: its two layers' addresses and where it sits, in percent of the frame. */
interface Tile {
  readonly key: string
  readonly base: string
  readonly names: string
  readonly left: number
  readonly top: number
}

/** A pin: its place and where it stands, in percent of the frame. */
export interface Pin extends Place {
  readonly key: string
  readonly left: number
  readonly top: number
}

/** A map ready to draw. `line` is in frame pixels, for an SVG whose box is `FRAME`. */
export interface Framed {
  readonly tiles: ReadonlyArray<Tile>
  /** A tile's size, in percent of the frame's width and height. */
  readonly tileWidth: number
  readonly tileHeight: number
  readonly pins: ReadonlyArray<Pin>
  readonly line: ReadonlyArray<{ readonly x: number; readonly y: number }>
}

/** One tile of Esri's grey canvas, the reference's raster basemap; light and dark follow the theme. */
interface TileAt {
  readonly layer: 'Base' | 'Reference'
  readonly dark: boolean
  readonly z: number
  readonly x: number
  readonly y: number
}

const tileAddress = ({ layer, dark, z, x, y }: TileAt) =>
  `https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_${dark ? 'Dark' : 'Light'}_Gray_${layer}/MapServer/tile/${z}/${y}/${x}`

/** Where the places sit at a zoom: their pixels on the frame whose middle is their middle. */
const placedAt = (places: ReadonlyArray<Place>, zoom: number) => {
  const scale = 2 ** zoom
  const points = places.map((place) => {
    const at = world(place)
    return { x: at.x * scale, y: at.y * scale }
  })
  const xs = points.map((point) => point.x)
  const ys = points.map((point) => point.y)
  // The middle of the places, nudged up so the names under the lowest pins stay on the frame.
  const middle = {
    x: (Math.min(...xs) + Math.max(...xs)) / 2,
    y: (Math.min(...ys) + Math.max(...ys)) / 2 + (PAD.bottom - PAD.top) / 2,
  }
  const origin = { x: middle.x - FRAME.width / 2, y: middle.y - FRAME.height / 2 }
  return {
    origin,
    points: points.map((point) => ({ x: point.x - origin.x, y: point.y - origin.y })),
  }
}

/** The tiles that cover the frame at a zoom, wrapping round the world from east to west. */
const tilesAt = (
  origin: { readonly x: number; readonly y: number },
  zoom: number,
  dark: boolean,
) => {
  const count = 2 ** zoom
  const first = { x: Math.floor(origin.x / TILE), y: Math.floor(origin.y / TILE) }
  const last = {
    x: Math.floor((origin.x + FRAME.width) / TILE),
    y: Math.floor((origin.y + FRAME.height) / TILE),
  }
  const tiles: Array<Tile> = []
  for (let row = Math.max(0, first.y); row <= Math.min(count - 1, last.y); row += 1) {
    for (let column = first.x; column <= last.x; column += 1) {
      const x = ((column % count) + count) % count
      tiles.push({
        // The look is in the key: a theme change is new images, never the old look left showing
        // until the new one loads.
        key: `${dark ? 'dark' : 'light'}/${zoom}/${column}/${row}`,
        base: tileAddress({ layer: 'Base', dark, z: zoom, x, y: row }),
        names: tileAddress({ layer: 'Reference', dark, z: zoom, x, y: row }),
        left: ((column * TILE - origin.x) / FRAME.width) * 100,
        top: ((row * TILE - origin.y) / FRAME.height) * 100,
      })
    }
  }
  return tiles
}

/**
 * The map for these places in the frame: the zoom that fits them all, the tiles under them, the
 * pins and, when `route` is set, the line through them in the display's order (the reference's
 * overview line, drawn when street routing is not to be had). `None` while there is no place yet.
 */
export const frame = (
  places: ReadonlyArray<Place>,
  route: boolean,
  dark: boolean,
): Option.Option<Framed> => {
  if (places.length === 0) return Option.none()
  const zoom = zoomFor(places.map(world))
  const { origin, points } = placedAt(places, zoom)
  const pins = places.flatMap((place, index) =>
    Option.toArray(
      Option.map(Option.fromUndefinedOr(points[index]), (point) => ({
        ...place,
        key: `${index}:${place.label}`,
        left: (point.x / FRAME.width) * 100,
        top: (point.y / FRAME.height) * 100,
      })),
    ),
  )
  return Option.some({
    tiles: tilesAt(origin, zoom, dark),
    tileWidth: (TILE / FRAME.width) * 100,
    tileHeight: (TILE / FRAME.height) * 100,
    pins,
    line: route && points.length > 1 ? points : [],
  })
}

/** Where the tiles come from, said on the map as the provider's terms ask. */
export const ATTRIBUTION = 'Esri · OpenStreetMap'
