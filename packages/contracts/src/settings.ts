import { Schema } from 'effect'
import { PersonId } from './identity.js'
import { LocationSharing } from './location.js'

export const Theme = Schema.Literals(['system', 'light', 'dark'] as const)
export type Theme = typeof Theme.Type

export class Settings extends Schema.Class<Settings>('Settings')(
  {
    personId: PersonId,
    theme: Theme,
    /** The IANA zone used to interpret local dates and times. */
    timezone: Schema.String,
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
