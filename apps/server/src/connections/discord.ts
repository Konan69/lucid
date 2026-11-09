import * as NodeCrypto from 'node:crypto'
import { Forbidden, ServiceCatalog, ServiceId, type Person } from '@vivid/contracts'
import { Effect, Option, type Schema } from 'effect'
import { optionalSetting, settingText } from '../config.ts'
import { appsVersion } from './framework.ts'

export const discordServiceId = ServiceId.make('vivid/discord')

/** Discord is in early access: only the Persons whose emails VIVID_DISCORD_PEOPLE lists (comma
 * separated) see or connect it. Unset hides it from everyone. Read once while the server is
 * composed, so a malformed value stops launch. */
export const loadDiscordPeople = optionalSetting(
  'VIVID_DISCORD_PEOPLE',
  settingText,
  'comma-separated emails',
).pipe(
  Effect.map(
    Option.match({
      onNone: (): ReadonlySet<string> => new Set(),
      onSome: (list): ReadonlySet<string> =>
        new Set(list.split(',').map((email) => email.trim().toLowerCase())),
    }),
  ),
)

const allowed = (people: ReadonlySet<string>, person: Person) =>
  people.has(person.email.toLowerCase())

/** The catalog a Person outside early access sees: the same answer without Discord. */
export function withoutDiscord(
  people: ReadonlySet<string>,
  person: Person,
  catalog: ServiceCatalog,
): ServiceCatalog {
  if (!ServiceCatalog.guards.Ready(catalog) || allowed(people, person)) return catalog
  const services = catalog.services.filter((service) => service.id !== discordServiceId)
  return ServiceCatalog.cases.Ready.make({
    services,
    total: catalog.total - (catalog.services.length - services.length),
  })
}

/** Begin and Offer refuse Discord outside early access, so a hidden entry cannot be reached by id. */
export function requireDiscordAccess(
  people: ReadonlySet<string>,
  person: Person,
  service: ServiceId,
): Effect.Effect<void, Forbidden> {
  return service === discordServiceId && !allowed(people, person)
    ? Effect.fail(new Forbidden({ message: 'Choose an integration from the current catalogue.' }))
    : Effect.void
}

const snowflake = { type: 'string', pattern: '^(0|[1-9][0-9]*)$', format: 'snowflake' }
const securitySchemes = { discord: { type: 'apiKey', in: 'header', name: 'Authorization' } }
const kinds = {
  list_my_guilds: 'query',
  list_guild_channels: 'query',
  list_messages: 'query',
  create_message: 'mutation',
  create_thread_from_message: 'mutation',
  edit_message: 'mutation',
}

/** Trimmed from discord/discord-api-spec specs/openapi.json. Discord names PATCH
 * update_message; Vivid exposes edit_message. Responses retain Discord's full JSON. */
const document = {
  openapi: '3.1.0',
  info: { title: 'Discord', version: '10' },
  servers: [{ url: 'https://discord.com/api/v10' }],
  security: [{ discord: [] }],
  components: { securitySchemes },
  paths: {
    '/users/@me/guilds': {
      get: {
        operationId: 'list_my_guilds',
        description: 'List the servers the connected Discord account belongs to.',
        responses: { '200': { description: 'Guilds' } },
      },
    },
    '/guilds/{guild_id}/channels': {
      parameters: [{ name: 'guild_id', in: 'path', required: true, schema: snowflake }],
      get: {
        operationId: 'list_guild_channels',
        description: 'List channels in a Discord server without changing them.',
        responses: { '200': { description: 'Channels' } },
      },
    },
    '/channels/{channel_id}/messages': {
      parameters: [{ name: 'channel_id', in: 'path', required: true, schema: snowflake }],
      get: {
        operationId: 'list_messages',
        description: 'Read recent messages in a Discord channel without changing them.',
        parameters: [
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100 } },
          { name: 'before', in: 'query', schema: snowflake },
          { name: 'after', in: 'query', schema: snowflake },
        ],
        responses: { '200': { description: 'Messages' } },
      },
      post: {
        operationId: 'create_message',
        description: 'Send a new message or reply to a Discord channel.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  content: { type: ['string', 'null'], maxLength: 4000 },
                  message_reference: {
                    type: ['object', 'null'],
                    properties: {
                      message_id: snowflake,
                      channel_id: { anyOf: [snowflake, { type: 'null' }] },
                      guild_id: { anyOf: [snowflake, { type: 'null' }] },
                      fail_if_not_exists: { type: ['boolean', 'null'] },
                      type: { type: ['integer', 'null'], enum: [0, null] },
                    },
                    required: ['message_id'],
                  },
                  allowed_mentions: {
                    type: ['object', 'null'],
                    properties: {
                      parse: {
                        type: ['array', 'null'],
                        items: { enum: ['users', 'roles', 'everyone', null] },
                        maxItems: 1521,
                        uniqueItems: true,
                      },
                      users: {
                        type: ['array', 'null'],
                        items: { anyOf: [snowflake, { type: 'null' }] },
                        maxItems: 100,
                        uniqueItems: true,
                      },
                      roles: {
                        type: ['array', 'null'],
                        items: { anyOf: [snowflake, { type: 'null' }] },
                        maxItems: 100,
                        uniqueItems: true,
                      },
                      replied_user: { type: ['boolean', 'null'] },
                    },
                  },
                },
              },
            },
          },
        },
        responses: { '200': { description: 'Created message' } },
      },
    },
    '/channels/{channel_id}/messages/{message_id}/threads': {
      parameters: [
        { name: 'channel_id', in: 'path', required: true, schema: snowflake },
        { name: 'message_id', in: 'path', required: true, schema: snowflake },
      ],
      post: {
        operationId: 'create_thread_from_message',
        description: 'Create a Discord thread attached to an existing message.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: { name: { type: 'string', minLength: 1, maxLength: 100 } },
                required: ['name'],
              },
            },
          },
        },
        responses: { '201': { description: 'Created thread' } },
      },
    },
    '/channels/{channel_id}/messages/{message_id}': {
      parameters: [
        { name: 'channel_id', in: 'path', required: true, schema: snowflake },
        { name: 'message_id', in: 'path', required: true, schema: snowflake },
      ],
      patch: {
        operationId: 'edit_message',
        description: 'Edit the content of a message sent by the connected Discord account.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: { content: { type: ['string', 'null'], maxLength: 4000 } },
              },
            },
          },
        },
        responses: { '200': { description: 'Edited message' } },
      },
    },
  },
}

function literal(value: Schema.Json) {
  return JSON.stringify(value)
    .replace(/\u2028/gu, '\\u2028')
    .replace(/\u2029/gu, '\\u2029')
}

/** CredentialBinding.prefix in executor@2.0.0-beta.23 adds Bot without embedding a credential. */
export function discordFiles(): ReadonlyArray<{ path: string; content: string }> {
  const source = `import { defineApp, defineProvider, secrets, object, string, router } from "apps";
import { liveOpenapiRouter } from "apps/openapi";
const discord = defineProvider({ name: "Discord", hosts: ["discord.com"], auth: { discord: secrets({ label: "Bot token", fields: object({ token: string() }) }) } });
export default defineApp({ user: { accounts: { discord: discord.many() } } }, async ({ user, cache, fetch, signal }) => {
if (user === undefined) return { tools: router({}) };
const [account] = user.accounts.discord;
if (account === undefined) return { tools: router({}) };
return { tools: liveOpenapiRouter({ cache, fetch, signal, source: { document: ${literal(document)} }, allowedOrigin: "https://discord.com", securitySchemes: ${literal(securitySchemes)}, methods: { discord: [{ scheme: "discord", field: "token", part: "value", prefix: "Bot " }] }, oauth: [], account, kinds: ${literal(kinds)} }) }; });
`
  return [
    { path: 'index.ts', content: source },
    {
      path: 'package.json',
      content: JSON.stringify({
        name: 'vivid-discord',
        private: true,
        type: 'module',
        dependencies: { apps: appsVersion },
      }),
    },
  ]
}

export function discordAppName(): string {
  const revision = NodeCrypto.createHash('sha256')
    .update(JSON.stringify(discordFiles()))
    .digest('hex')
    .slice(0, 16)
  return `Vivid Discord ${revision}`
}
