import { Schema } from 'effect'
import { PersonId } from './identity.js'

export const Theme = Schema.Literals(['system', 'light', 'dark'] as const)
export type Theme = typeof Theme.Type

export class Settings extends Schema.Class<Settings>('Settings')(
  {
    personId: PersonId,
    theme: Theme,
    /** The IANA zone Vivid resolves "tomorrow at 9" against, and Routines run in. */
    timezone: Schema.String,
    /** Whether Vivid tells this Person when it finishes or needs them in a Thread they left. */
    notify: Schema.Boolean,
  },
  { title: 'Settings' },
) {}

export class PatchSettingsRequest extends Schema.Class<PatchSettingsRequest>(
  'PatchSettingsRequest',
)(
  {
    theme: Schema.optional(Theme),
    timezone: Schema.optional(Schema.String),
    notify: Schema.optional(Schema.Boolean),
  },
  { title: 'Patch Settings request' },
) {}
