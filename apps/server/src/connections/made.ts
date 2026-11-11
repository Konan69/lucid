import { appsVersion } from './framework.ts'
import { ServiceId, type AccountOrigin, type MakeIntegrationRequest } from '@vivid/contracts'

/** Authored services are distinct from catalogue entries and address imports. */
export const MADE = 'made:'

/** Whose a service is to the Person: one Vivid made for its own work, or one they connected. */
export const originOf = (service: string): AccountOrigin =>
  service.startsWith(MADE) ? 'Vivid' : 'Service'

/** Like IMPORTED's address identity, the name identifies a service; Person scope belongs to its row. */
export function madeService(name: string) {
  // "Reminders" and "reminders " are one Integration, not two apps.
  return ServiceId.make(`${MADE}${name.trim().toLowerCase()}`)
}

/** A private package needs no registry identity; a fixed slug also supports non-Latin app names. */
export function madeFiles(request: MakeIntegrationRequest) {
  return [
    ...request.files,
    {
      path: 'package.json',
      content: JSON.stringify({
        name: 'vivid-made-integration',
        private: true,
        type: 'module',
        dependencies: { apps: appsVersion },
      }),
    },
  ]
}
