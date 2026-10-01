import * as Schema from 'effect/Schema'

/** An origin carries no credentials, route, query, or fragment into renderer navigation. */
function isServerOrigin(value: string): boolean {
  if (!URL.canParse(value) || value.trim() !== value) return false
  const url = new URL(value)
  return (
    (url.protocol === 'http:' || url.protocol === 'https:') &&
    url.username === '' &&
    url.password === '' &&
    (value === url.origin || value === `${url.origin}/`)
  )
}

/** Only an explicit HTTP origin may select the desktop's same-origin server. */
export const ServerAddress = Schema.String.check(
  Schema.makeFilter(isServerOrigin, { message: 'Expected an HTTP server origin' }),
).pipe(Schema.brand('DesktopServerAddress'))
export type ServerAddress = typeof ServerAddress.Type

/** The default belongs to main-process settings, never to the web build. */
export const defaultServerAddress = ServerAddress.make('http://127.0.0.1:8787')

/** First launch remains distinguishable from a Person explicitly selecting the default. */
export const ServerSettings = Schema.TaggedUnion({
  Unconfigured: { serverAddress: ServerAddress },
  Configured: { serverAddress: ServerAddress },
})
export type ServerSettings = typeof ServerSettings.Type

/** A renderer can distinguish persistence failure from an invalid IPC request. */
export class SettingsSaveFailed extends Schema.TaggedError<SettingsSaveFailed>()(
  'SettingsSaveFailed',
  {},
  { title: 'Desktop settings could not be saved' },
) {}
