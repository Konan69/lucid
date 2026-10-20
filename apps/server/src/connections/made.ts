import { ServiceId, type MakeIntegrationRequest } from '@vivid/contracts'

/** Executor 26d03a48, refs/executor/packages/apps/package.json, ships this framework in beta.23. */
export const madeAppsVersion = '0.0.1-beta.92'

/** Like IMPORTED's address identity, the name identifies a service; Person scope belongs to its row. */
export function madeService(name: string) {
  return ServiceId.make(`made:${name}`)
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
        dependencies: { apps: madeAppsVersion },
      }),
    },
  ]
}
