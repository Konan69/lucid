import { appsVersion } from './framework.ts'
import { ServiceId, type MakeIntegrationRequest } from '@vivid/contracts'

/** Authored services are distinct from catalogue entries and address imports. */
export const MADE = 'made:'

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
