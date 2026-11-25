import * as NodeBuffer from 'node:buffer'
import { DiscordId, type Person } from '@vivid/contracts'
import { Effect, Option, Redacted, Schema } from 'effect'
import { optionalSetting, settingSecret, settingText } from '../config.ts'

/** A bot token is three base64url parts, and the first is the bot's own account id. */
const discordToken = Schema.RedactedFromValue(
  settingText.check(
    Schema.makeFilter((token) => {
      if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(token)) return false
      const id = NodeBuffer.Buffer.from(token.split('.')[0] ?? '', 'base64url').toString('utf8')
      return /^[1-9][0-9]{16,19}$/u.test(id)
    }),
  ),
)

/** The bot: its token, and the account id the token names, which mentions of it carry. */
export interface DiscordBotSettings {
  readonly token: Redacted.Redacted<string>
  readonly id: DiscordId
}

/** What Discord's OAuth install needs: the application's id and its client secret. */
export interface DiscordInstallSettings {
  readonly application: DiscordId
  readonly secret: Redacted.Redacted<string>
}

/**
 * Discord on this Vivid. Every setting is optional and the server starts without them.
 *
 * - `VIVID_DISCORD_BOT_TOKEN` is the bot. Without it there is no Discord at all.
 * - `VIVID_DISCORD_APPLICATION_ID` and `VIVID_DISCORD_CLIENT_SECRET` drive "Add to Discord".
 *   Without both, nobody can add a server, while servers already added keep working.
 * - `VIVID_DISCORD_PEOPLE` is early access: the emails, comma separated, of the Persons who see
 *   Discord at all. Unset shows it to nobody.
 *
 * Read once while the server is composed, so a malformed value stops launch with its name.
 */
export interface DiscordSettings {
  readonly bot: Option.Option<DiscordBotSettings>
  readonly install: Option.Option<DiscordInstallSettings>
  readonly people: ReadonlySet<string>
}

const decodeId = Schema.decodeUnknownOption(DiscordId)

/** The account id a token's first part encodes; `discordToken` already checked it is one. */
const botAccount = (token: Redacted.Redacted<string>) =>
  NodeBuffer.Buffer.from(Redacted.value(token).split('.')[0] ?? '', 'base64url').toString('utf8')

export const loadDiscordSettings = Effect.gen(function* () {
  const token = yield* optionalSetting(
    'VIVID_DISCORD_BOT_TOKEN',
    discordToken,
    'a Discord bot token containing a snowflake user id',
  )
  const application = yield* optionalSetting(
    'VIVID_DISCORD_APPLICATION_ID',
    DiscordId,
    'a Discord application id',
  )
  const secret = yield* optionalSetting('VIVID_DISCORD_CLIENT_SECRET', settingSecret)
  const people = yield* optionalSetting('VIVID_DISCORD_PEOPLE', settingText, 'comma-separated emails')
  return {
    bot: Option.flatMap(token, (value) =>
      Option.map(decodeId(botAccount(value)), (id): DiscordBotSettings => ({ token: value, id })),
    ),
    install: Option.zipWith(
      application,
      secret,
      (id, value): DiscordInstallSettings => ({ application: id, secret: value }),
    ),
    people: Option.match(people, {
      onNone: (): ReadonlySet<string> => new Set(),
      onSome: (list): ReadonlySet<string> =>
        new Set(list.split(',').map((email) => email.trim().toLowerCase())),
    }),
  } satisfies DiscordSettings
}).pipe(Effect.withSpan('Discord.settings'))

/** Discord is in early access: a Person sees it only when their email is listed. */
export const inEarlyAccess = (settings: DiscordSettings, person: Person) =>
  settings.people.has(person.email.toLowerCase())
