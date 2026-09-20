import * as Layer from 'effect/Layer'
import * as HttpApiBuilder from 'effect/unstable/httpapi/HttpApiBuilder'
import { VividApi } from '@vivid/contracts/api'
import { authMiddlewareLayer } from '../auth/middleware.ts'
import { acceptMembership, createCompany, inviteMembership, listCompanies, me } from '../companies/handlers.ts'
import { createProject, listProjects } from '../projects/handlers.ts'
import { getSettings, patchSettings } from '../settings/handlers.ts'

const handlers = HttpApiBuilder.group(VividApi, 'vivid', (group) =>
  group
    .handle('me', () => me())
    .handle('listCompanies', () => listCompanies())
    .handle('createCompany', ({ payload }) => createCompany(payload))
    .handle('listProjects', () => listProjects())
    .handle('createProject', ({ payload }) => createProject(payload))
    .handle('inviteMembership', ({ payload }) => inviteMembership(payload))
    .handle('acceptMembership', ({ payload }) => acceptMembership(payload))
    .handle('getSettings', () => getSettings())
    .handle('patchSettings', ({ payload }) => patchSettings(payload)),
)

export const apiLayer = HttpApiBuilder.layer(VividApi).pipe(
  Layer.provide(handlers),
  Layer.provide(authMiddlewareLayer),
)
