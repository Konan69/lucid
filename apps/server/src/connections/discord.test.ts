import { expect, it } from '@effect/vitest'
import { ServiceAuthorization } from '@vivid/contracts'
import { Effect, Layer } from 'effect'
import { searchCatalog } from './curation.ts'
import { discordFiles, discordServiceId } from './discord.ts'
import { Executor } from './executor.ts'
import { hostedExecutorFixture } from './testing.ts'

it.effect('offers Discord with a Person key and emits credential-free source', () =>
  Effect.gen(function* () {
    const hosted = yield* hostedExecutorFixture()
    const context = yield* Layer.build(hosted.configured)
    const entries = yield* Effect.flatMap(Executor, (executor) => executor.catalog).pipe(
      Effect.provide(context),
    )
    expect(searchCatalog(entries, 'Discord')[0]).toMatchObject({
      id: discordServiceId,
      description:
        'Create a bot at discord.com/developers/applications, copy its token, and invite it to your server.',
      authorization: ServiceAuthorization.cases.Key.make({
        fields: [{ name: 'token', label: 'Bot token' }],
      }),
    })
    expect(JSON.stringify(discordFiles())).not.toContain('disposable-discord-token')
  }).pipe(Effect.scoped),
)
