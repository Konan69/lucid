import * as NodeAssert from 'node:assert/strict'
import { ServiceCatalog } from '@vivid/contracts'
import { json, rpc } from './wire.mjs'

export const settingsLimits = [
  'Correct, Forget, standing pages and a populated list need memory written through the real product; this recipe reads the public memory index; browser settings checks its rendered list.',
  'All eight purpose groups, including an unclassified service under More, need real catalog entries for each group. Built-in Google services establish Mail and calendar and Files and notes without remote authority.',
  'Company Settings grouping needs a disposable Company and its actual membership session.',
  'Phone and desktop native entry points need their own device runs.',
]

/** Read the catalog through the shipped public schema; no external sign-in or fixture is needed. */
export async function catalog(state, directory, query, name) {
  const result = await rpc(state, 'FindServices', { query }, directory, name)
  NodeAssert.ok(ServiceCatalog.guards.Ready(result), 'Real service catalog is unavailable')
  NodeAssert.ok(result.services.length > 0, 'Expected real catalog services')
  return result.services
}

/** Read the cell as it stands. Earlier real-model journeys may already have taught this Person. */
export async function settingsProof(state, _id, directory) {
  await rpc(state, 'GetMemoryIndex', undefined, directory, 'memory-index')
  const popular = await catalog(state, directory, '', 'popular-services')
  for (const name of ['Gmail', 'Google Drive'])
    NodeAssert.ok(
      popular.some((service) => service.name === name),
      'Missing authored service ' + name,
    )
  const searched = await catalog(state, directory, 'Gmail', 'gmail-search')
  NodeAssert.ok(searched.some((service) => service.name === 'Gmail'))
  const connections = await rpc(state, 'ListConnections', undefined, directory, 'connections')
  NodeAssert.deepEqual(connections.connections, [], 'Catalog browsing must not connect an account')
  await json(directory + '/scope.json', {
    modelCalls: 0,
    scope:
      'Current cell memory index, public popular catalog and Gmail search, no connected accounts. Rendering and purpose groups require browser settings.',
    blocked: settingsLimits,
  })
}
