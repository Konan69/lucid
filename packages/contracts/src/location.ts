import { Schema } from 'effect'

/**
 * Where a Person is, as their own device last said, so Vivid can do work that depends on it:
 * what is near, how long a trip takes, which city a booking is for (issue 20, audit row M647).
 *
 * The mechanism follows Meta Muse's location awareness
 * (`muse/workspace/system/system_prompt.md:156-165`): a client syncs its last seen coordinates
 * with the moment they were taken, the model is told that reading with its age, and anything the
 * Person says in the conversation outranks it. Vivid differs in two ways. The device names the
 * place itself (the phone's own reverse geocoder) because Vivid has no geocoding tool, and the
 * Person turns sharing on in Settings first: nothing is read before that.
 */

/** The longest place name kept: a district, a city and a country fit with room to spare. */
export const LOCATION_PLACE_MAX = 120

/**
 * The place a reading was in, in words, as the device resolved it ("Lekki, Lagos, Nigeria").
 * It is read to the model, so it is one line with no backslash and cannot pose as an instruction.
 */
export const LocationPlace = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isBetweenLength(1, LOCATION_PLACE_MAX),
  Schema.isPattern(/^[^\\\r\n]*$/u),
)
export type LocationPlace = typeof LocationPlace.Type

/**
 * One reading of where the Person's device was.
 *
 * - `accuracy` is the radius in metres the device vouches for; a coarse reading is a few hundred
 *   metres to a few kilometres, which is enough for nearby work.
 * - `takenAt` is when the device took it, in epoch milliseconds: the model is told how old it is.
 * - `place` is null when the device could not name the place (no geocoder answer, or a browser,
 *   which has none); the coordinates are then all there is.
 */
export class LocationReading extends Schema.Class<LocationReading>('LocationReading')(
  {
    latitude: Schema.Finite.check(Schema.isBetween({ minimum: -90, maximum: 90 })),
    longitude: Schema.Finite.check(Schema.isBetween({ minimum: -180, maximum: 180 })),
    accuracy: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
    takenAt: Schema.Finite,
    place: Schema.NullOr(LocationPlace),
  },
  { title: 'Location reading' },
) {}

/**
 * Whether the Person shares where they are, and what Vivid knows of it.
 *
 * - `Off`: not shared. This is how every Person starts, and turning sharing off returns here and
 *   forgets the last reading.
 * - `Waiting`: shared, and no device has sent a reading yet.
 * - `Known`: shared, with the latest reading any of the Person's devices sent. Each one replaces
 *   the last.
 */
export const LocationSharing = Schema.TaggedUnion({
  Off: {},
  Waiting: {},
  Known: { reading: LocationReading },
})
export type LocationSharing = typeof LocationSharing.Type

export class ShareLocationRequest extends Schema.Class<ShareLocationRequest>(
  'ShareLocationRequest',
)({ reading: LocationReading }, { title: 'Share location request' }) {}

/**
 * The Person does not share their location, so a reading was not kept. A device that turned it
 * off elsewhere a moment ago may still send one; it is dropped, never stored.
 */
export class LocationNotShared extends Schema.TaggedError<LocationNotShared>()(
  'LocationNotShared',
  {},
  { title: 'Location is not shared' },
) {}
