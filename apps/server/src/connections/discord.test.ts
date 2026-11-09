import { expect, it } from '@effect/vitest'
import { Service, ServiceAuthorization } from '@vivid/contracts'
import { Effect, Layer } from 'effect'
import { loadCuration } from './curation.ts'
import { discordAppName, discordFiles, discordServiceId } from './discord.ts'
import { Executor } from './executor.ts'
import { hostedExecutorFixture } from './testing.ts'

it.effect('offers Discord with a Person key and emits deterministic credential-free source', () =>
  Effect.gen(function* () {
    const hosted = yield* hostedExecutorFixture()
    const context = yield* Layer.build(hosted.configured)
    const entries = yield* Effect.flatMap(Executor, (executor) => executor.catalog).pipe(
      Effect.provide(context),
    )
    const entry = entries.find((service) => service.id === discordServiceId)
    if (entry === undefined) expect.fail('Discord must be locally available')
    const search = yield* loadCuration()
    const catalog = search([Service.make({ ...entry, mark: null })], 'Discord')
    expect(catalog).toMatchObject({
      services: [
        {
          id: 'vivid/discord',
          description:
            'Create a bot at discord.com/developers/applications, copy its token, and invite it to your server.',
          authorization: ServiceAuthorization.cases.Key.make({
            fields: [{ name: 'token', label: 'Bot token' }],
          }),
          curation: { kind: 'chat', auth: 'PersonKey', worksNow: true },
        },
      ],
    })
    expect(discordFiles()).toEqual(discordFiles())
    expect(discordAppName()).toMatch(/^Vivid Discord [0-9a-f]{16}$/u)
    expect(discordAppName()).toBe(discordAppName())
    expect(JSON.stringify(discordFiles())).not.toContain('disposable-discord-token')
  }).pipe(Effect.scoped),
)
