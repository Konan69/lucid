import { expect, it } from '@effect/vitest'
import {
  Person,
  PersonId,
  Service,
  ServiceAuthorization,
  ServiceCatalog,
  ServiceId,
} from '@vivid/contracts'
import { ConfigProvider, Effect, Layer } from 'effect'
import { loadCuration } from './curation.ts'
import {
  discordAppName,
  discordFiles,
  discordServiceId,
  loadDiscordPeople,
  requireDiscordAccess,
  withoutDiscord,
} from './discord.ts'
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

const asPerson = (email: string) =>
  Person.make({ id: PersonId.make(crypto.randomUUID()), name: 'Early', email })
const catalog = ServiceCatalog.cases.Ready.make({
  services: [discordServiceId, ServiceId.make('google/gmail')].map((id) =>
    Service.make({
      id,
      name: id,
      description: '',
      mark: null,
      authorization: ServiceAuthorization.cases.Key.make({ fields: [] }),
    }),
  ),
  total: 2,
})

it.effect('shows and opens Discord only for the listed early-access emails', () =>
  Effect.gen(function* () {
    const people = yield* loadDiscordPeople.pipe(
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        ConfigProvider.fromUnknown({
          VIVID_DISCORD_PEOPLE: 'owner@example.com, agent@example.com',
        }),
      ),
    )
    const owner = asPerson('Owner@Example.com')
    const other = asPerson('other@example.com')
    const gmail = ServiceId.make('google/gmail')

    expect(withoutDiscord(people, owner, catalog)).toEqual(catalog)
    yield* requireDiscordAccess(people, owner, discordServiceId)

    const hidden = withoutDiscord(people, other, catalog)
    expect(ServiceCatalog.guards.Ready(hidden) && hidden.services.map(({ id }) => id)).toEqual([
      gmail,
    ])
    expect(ServiceCatalog.guards.Ready(hidden) && hidden.total).toBe(1)
    expect((yield* Effect.flip(requireDiscordAccess(people, other, discordServiceId)))._tag).toBe(
      'Forbidden',
    )
    yield* requireDiscordAccess(people, other, gmail)

    const nobody = yield* loadDiscordPeople.pipe(
      Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown({})),
    )
    expect((yield* Effect.flip(requireDiscordAccess(nobody, owner, discordServiceId)))._tag).toBe(
      'Forbidden',
    )
  }),
)
