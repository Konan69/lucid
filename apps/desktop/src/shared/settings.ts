import * as Schema from 'effect/Schema'

/** Permit cleartext only for literal local addresses; DNS names cannot promise private routing. */
function isPrivateHost(host: string): boolean {
  if (host === 'localhost' || host === '[::1]') return true
  if (/^\[(?:f[cd][0-9a-f]{2}:|fe[89ab][0-9a-f]:)/i.test(host)) return true
  const parts = host.split('.').map(Number)
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255))
    return false
  return isPrivateIpv4(parts)
}

/** RFC1918 and loopback are the only IPv4 ranges permitted to bypass HTTPS. */
function isPrivateIpv4(parts: ReadonlyArray<number>): boolean {
  const [first, second] = parts
  if (first === 127 || first === 10) return true
  if (first === 192) return second === 168
  return first === 172 && second !== undefined && second >= 16 && second <= 31
}

/** An origin carries no credentials, route, query, or fragment and remote servers require TLS. */
function isServerOrigin(value: string): boolean {
  if (!URL.canParse(value) || value.trim() !== value) return false
  const url = new URL(value)
  return (
    (url.protocol === 'https:' || (url.protocol === 'http:' && isPrivateHost(url.hostname))) &&
    url.username === '' &&
    url.password === '' &&
    (value === url.origin || value === `${url.origin}/`)
  )
}

/** Persisted and IPC-selected servers share one transport policy. */
export const ServerAddress = Schema.String.check(
  Schema.makeFilter(isServerOrigin, { message: 'Expected HTTPS or a local HTTP server origin' }),
).pipe(Schema.brand('DesktopServerAddress'))
export type ServerAddress = typeof ServerAddress.Type

/** First launch has no implied server or network authority. */
export const ServerSettings = Schema.TaggedUnion({
  NoServer: {},
  Server: { origin: ServerAddress },
})
export type ServerSettings = typeof ServerSettings.Type

/** Probe outcomes do not claim that an unverified server was saved. */
export const ServerChoice = Schema.TaggedUnion({
  Chosen: {},
  Unreachable: { reason: Schema.String },
  NotVivid: {},
})
export type ServerChoice = typeof ServerChoice.Type

/** Persistence failure rejects the bridge call without changing the selected server. */
export class SettingsSaveFailed extends Schema.TaggedError<SettingsSaveFailed>()(
  'SettingsSaveFailed',
  {},
  { title: 'Desktop settings could not be saved' },
) {}
