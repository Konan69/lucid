import * as NodeFS from 'node:fs'
import * as Array from 'effect/Array'
import * as Effect from 'effect/Effect'
import * as Number from 'effect/Number'
import * as Option from 'effect/Option'
import * as Order from 'effect/Order'
import * as Schema from 'effect/Schema'

const MIN_WINDOW_WIDTH = 720
const MIN_WINDOW_HEIGHT = 480
const DEFAULT_WINDOW_WIDTH = 1280
const DEFAULT_WINDOW_HEIGHT = 800

const PositiveInteger = Schema.Int.check(
  Schema.isGreaterThan(0, { message: 'Expected a positive integer' }),
)

/** The usable rectangle reported by one connected display. */
export const DisplayWorkArea = Schema.Struct({
  x: Schema.Int,
  y: Schema.Int,
  width: PositiveInteger,
  height: PositiveInteger,
})
export interface DisplayWorkArea extends Schema.Schema.Type<typeof DisplayWorkArea> {}

/**
 * Persisted geometry is either OS-positioned or explicitly positioned. The tagged split prevents
 * an x coordinate without y (or the reverse), which the previous optional-field object allowed.
 */
export const WindowPlacement = Schema.TaggedUnion({
  Centered: {
    width: PositiveInteger,
    height: PositiveInteger,
    maximized: Schema.Boolean,
  },
  Positioned: {
    width: PositiveInteger,
    height: PositiveInteger,
    x: Schema.Int,
    y: Schema.Int,
    maximized: Schema.Boolean,
  },
})
export type WindowPlacement = typeof WindowPlacement.Type

const WindowPlacementJson = Schema.fromJsonString(WindowPlacement)
const decodeWindowPlacement = Schema.decodeUnknownEffect(WindowPlacementJson)
const encodeWindowPlacement = Schema.encodeEffect(WindowPlacementJson)

export const defaultWindowPlacement = WindowPlacement.cases.Centered.make({
  width: DEFAULT_WINDOW_WIDTH,
  height: DEFAULT_WINDOW_HEIGHT,
  maximized: false,
})

/** The placement file could not be read at its owning application path. */
class PlacementReadFailed extends Schema.TaggedError<PlacementReadFailed>()(
  'PlacementReadFailed',
  { path: Schema.String },
  { title: 'Window placement read failed' },
) {}

/** The placement file exists but cannot safely describe a window. */
class PlacementInvalid extends Schema.TaggedError<PlacementInvalid>()(
  'PlacementInvalid',
  { path: Schema.String },
  { title: 'Window placement is invalid' },
) {}

/** The current placement could not be persisted for the next launch. */
class PlacementWriteFailed extends Schema.TaggedError<PlacementWriteFailed>()(
  'PlacementWriteFailed',
  { path: Schema.String },
  { title: 'Window placement write failed' },
) {}

/** Read and decode persisted JSON once; callers choose whether failure should reset to defaults. */
export const readWindowPlacement = Effect.fn('WindowPlacement.read')(function* (path: string) {
  const text = yield* Effect.try({
    try: () => NodeFS.readFileSync(path, 'utf8'),
    catch: () => new PlacementReadFailed({ path }),
  })
  return yield* decodeWindowPlacement(text).pipe(
    Effect.mapError(() => new PlacementInvalid({ path })),
  )
})

/** Encode the schema-owned placement before writing it to disk. */
export const writeWindowPlacement = Effect.fn('WindowPlacement.write')(function* (
  path: string,
  placement: WindowPlacement,
) {
  const text = yield* encodeWindowPlacement(placement).pipe(
    Effect.mapError(() => new PlacementInvalid({ path })),
  )
  yield* Effect.try({
    try: () => NodeFS.writeFileSync(path, text),
    catch: () => new PlacementWriteFailed({ path }),
  })
})

const distanceFrom = (placement: WindowPlacement, area: DisplayWorkArea): number =>
  WindowPlacement.match(placement, {
    Centered: () => 0,
    Positioned: ({ x, y }) => {
      const nearestX = Number.clamp(x, {
        minimum: area.x,
        maximum: area.x + area.width,
      })
      const nearestY = Number.clamp(y, {
        minimum: area.y,
        maximum: area.y + area.height,
      })
      return (x - nearestX) ** 2 + (y - nearestY) ** 2
    },
  })

/** Choose the display nearest the saved origin; the first display owns centered windows. */
const nearestDisplay = (
  placement: WindowPlacement,
  workAreas: ReadonlyArray<DisplayWorkArea>,
): Option.Option<DisplayWorkArea> =>
  Option.fromNullishOr(
    Array.sort(
      workAreas,
      Order.mapInput(Order.Number, (area: DisplayWorkArea) => distanceFrom(placement, area)),
    )[0],
  )

/**
 * Clamp saved geometry into one visible work area. Width and height stay above Vivid's usable
 * minimum when the display permits it, while an oversized or disconnected-display placement is
 * moved wholly on-screen. No connected display is represented as Option.none rather than a fake
 * coordinate system.
 */
export const clampWindowPlacement = (
  placement: WindowPlacement,
  workAreas: ReadonlyArray<DisplayWorkArea>,
): Option.Option<WindowPlacement> =>
  Option.map(nearestDisplay(placement, workAreas), (area) => {
    const width = Number.clamp(placement.width, {
      minimum: Math.min(MIN_WINDOW_WIDTH, area.width),
      maximum: area.width,
    })
    const height = Number.clamp(placement.height, {
      minimum: Math.min(MIN_WINDOW_HEIGHT, area.height),
      maximum: area.height,
    })
    return WindowPlacement.match<WindowPlacement>(placement, {
      Centered: ({ maximized }) =>
        WindowPlacement.cases.Centered.make({ width, height, maximized }),
      Positioned: ({ x, y, maximized }) =>
        WindowPlacement.cases.Positioned.make({
          width,
          height,
          x: Number.clamp(x, {
            minimum: area.x,
            maximum: area.x + area.width - width,
          }),
          y: Number.clamp(y, {
            minimum: area.y,
            maximum: area.y + area.height - height,
          }),
          maximized,
        }),
    })
  })
