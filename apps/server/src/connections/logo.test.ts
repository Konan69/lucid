import { expect, it } from '@effect/vitest'
import { ServiceAuthorization, ServiceId } from '@vivid/contracts'
import { Effect } from 'effect'
import { catalogService, connectionLogo, serviceLogo } from './logo.ts'

it.effect('uses registrable catalog domains with no client size parameter', () =>
  Effect.sync(() => {
    expect(serviceLogo('workspace.google.com')).toBe(
      'https://www.google.com/s2/favicons?domain=google.com',
    )
    expect(serviceLogo('gmail.com')).toBe('https://www.google.com/s2/favicons?domain=gmail.com')
    expect(serviceLogo('api.example.co.uk')).toBe(
      'https://www.google.com/s2/favicons?domain=example.co.uk',
    )
    expect(serviceLogo('https://api.example.co.uk/spec.json')).toBe(
      'https://www.google.com/s2/favicons?domain=example.co.uk',
    )
  }),
)

it.effect('leaves absent and nonregistrable domains without a logo', () =>
  Effect.sync(() => {
    for (const domain of [null, '', 'localhost', '127.0.0.1', '[::1]', 'co.uk'])
      expect(serviceLogo(domain)).toBeNull()
  }),
)

it.effect('projects real catalog logo metadata into Service without exposing internal fields', () =>
  Effect.sync(() => {
    const authorization = ServiceAuthorization.cases.SignIn.make({})
    const entry = {
      id: ServiceId.make('google/workspace'),
      name: 'Google Workspace',
      description: 'Google services',
      domain: 'workspace.google.com',
      authorization,
    }
    expect(catalogService(entry)).toEqual({
      id: entry.id,
      name: entry.name,
      description: entry.description,
      mark: 'https://www.google.com/s2/favicons?domain=google.com',
      authorization,
    })
    expect(catalogService({ ...entry, domain: null }).mark).toBeNull()
    const { domain: _domain, ...withoutDomain } = entry
    expect(catalogService(withoutDomain).mark).toBeNull()
  }),
)

it.effect("names an added server's icon from its Service id, and none for a catalog Service", () =>
  Effect.sync(() => {
    expect(connectionLogo('url:https://mcp.context7.com/mcp')).toBe(
      'https://www.google.com/s2/favicons?domain=context7.com',
    )
    expect(connectionLogo('curated/linear-app-mcp')).toBeNull()
  }),
)
