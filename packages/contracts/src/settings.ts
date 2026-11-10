import { Effect, Schema } from 'effect'
import { PersonId } from './identity.js'
import { LocationSharing } from './location.js'

export const Theme = Schema.Literals(['system', 'light', 'dark'] as const)
export type Theme = typeof Theme.Type

/** Local minutes, independent of time zone. A window may cross midnight; equal bounds are refused. */
export const WakingHours = Schema.Struct({
  start: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1439 })),
  end: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1440 })),
}).check(Schema.makeFilter((window) => window.start !== window.end || 'Name two different times.'))
export type WakingHours = typeof WakingHours.Type
/** Muse's default, used until the Person states their own hours (docs/28, sections 3 and 9). */
export const DEFAULT_WAKING_HOURS = WakingHours.make({ start: 540, end: 1290 })

export class Settings extends Schema.Class<Settings>('Settings')(
  {
    personId: PersonId,
    theme: Theme,
    /** The IANA zone used to interpret local dates and times. */
    timezone: Schema.String,
    /** Null means the Person has not replaced the default contact window. */
    wakingHours: Schema.NullOr(WakingHours).pipe(
      Schema.withConstructorDefault(Effect.succeed(null)),
    ),
    /**
     * Whether the Computer's browser sends its traffic out through this Person's own computer
     * (`egress.ts`). Off until the Person turns it on. Temporary: issue 61 removes the choice,
     * and with it this field.
     */
    egress: Schema.Boolean,
    /** Whether the Person shares where they are, and their latest reading (`location.ts`). */
    location: LocationSharing,
  },
  { title: 'Settings' },
) {}

export class PatchSettingsRequest extends Schema.Class<PatchSettingsRequest>(
  'PatchSettingsRequest',
)(
  {
    theme: Schema.optional(Theme),
    timezone: Schema.optional(Schema.String),
    egress: Schema.optional(Schema.Boolean),
    /** Turns sharing on or off. Off forgets the last reading; on keeps one already known. */
    location: Schema.optional(Schema.Boolean),
  },
  { title: 'Patch Settings request' },
) {}
