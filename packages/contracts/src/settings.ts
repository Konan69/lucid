import { Schema } from 'effect'
import { PersonId } from './identity.js'

export class Settings extends Schema.Class<Settings>('Settings')(
  {
    personId: PersonId,
    theme: Schema.Literals(['system', 'light', 'dark'] as const),
  },
  { title: 'Settings' },
) {}

export class PatchSettingsRequest extends Schema.Class<PatchSettingsRequest>(
  'PatchSettingsRequest',
)(
  {
    theme: Schema.optional(Schema.Literals(['system', 'light', 'dark'] as const)),
  },
  { title: 'Patch Settings request' },
) {}
