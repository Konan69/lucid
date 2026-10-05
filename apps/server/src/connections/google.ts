import * as NodeCrypto from 'node:crypto'
import { ServiceId } from '@vivid/contracts'
import { Effect, Option, Schema } from 'effect'
import { requiredSetting, settingSecret, settingText } from '../config.ts'

/**
 * Google Integrations are part of every Vivid: Gmail, Calendar, Drive, Docs, Sheets and Tasks. The
 * server carries each one as the source of an Executor app and installs it itself the first time a
 * Person begins one (`Executor.begin`), so there is nothing to install by hand and no identifier to
 * configure. They were once a file of app identifiers an operator produced on one Executor and
 * named in a setting; a deploy could not carry it, so the hosted server never offered Google.
 *
 * Everything here was run on the hosted Executor's own build (upstream source at commit `304bf60`,
 * `apps` framework `0.0.1-beta.22`): each source deploys, all 211 operations of the six
 * definitions compile, sign-in starts at Google with these scopes, and a call reaches Google.
 */

/** The `apps` framework the sources below are written for. Executor requires an app to name the
 * exact version it uses and keeps serving it after the host moves on. */
export const googleAppsVersion = '0.0.1-beta.22'

/** The sign-in method's name in a Google app's source. The helper fills the OpenAPI security
 * scheme of the same name, and every Google definition names its scheme `googleOAuth2`. */
const googleMethod = 'googleOAuth2'

const GoogleService = Schema.Struct({
  service: ServiceId,
  name: Schema.NonEmptyString,
  /** The product's own site, which is what its icon is found by. The API host has none. */
  domain: Schema.NonEmptyString,
  /** Google's API as an OpenAPI definition. Executor's catalogue lists these six under this
   * address (`curated/google-*`, kind `openapi`) and the app reads it there, not from a copy. */
  definition: Schema.NonEmptyString,
  /** The one origin a Person's Google token may be sent to. */
  origin: Schema.NonEmptyString,
  /** What the catalogue entry declares for the service; Google shows them on its consent screen. */
  scopes: Schema.NonEmptyArray(Schema.NonEmptyString),
})
export type GoogleService = typeof GoogleService.Type

const identity = ['openid', 'email', 'profile'] as const
const definition = (name: string) => `https://integrations.sh/specs/google/google-${name}.json`

export const googleServices: readonly GoogleService[] = [
  GoogleService.make({
    service: ServiceId.make('google/gmail'),
    name: 'Gmail',
    domain: 'gmail.com',
    definition: definition('gmail'),
    origin: 'https://gmail.googleapis.com',
    scopes: [
      ...identity,
      'https://mail.google.com/',
      'https://www.googleapis.com/auth/gmail.settings.basic',
    ],
  }),
  GoogleService.make({
    service: ServiceId.make('google/calendar'),
    name: 'Google Calendar',
    domain: 'calendar.google.com',
    definition: definition('calendar'),
    origin: 'https://www.googleapis.com',
    scopes: [...identity, 'https://www.googleapis.com/auth/calendar'],
  }),
  GoogleService.make({
    service: ServiceId.make('google/drive'),
    name: 'Google Drive',
    domain: 'drive.google.com',
    definition: definition('drive'),
    origin: 'https://www.googleapis.com',
    scopes: [...identity, 'https://www.googleapis.com/auth/drive'],
  }),
  GoogleService.make({
    service: ServiceId.make('google/docs'),
    name: 'Google Docs',
    domain: 'docs.google.com',
    definition: definition('docs'),
    origin: 'https://docs.googleapis.com',
    scopes: [...identity, 'https://www.googleapis.com/auth/documents'],
  }),
  GoogleService.make({
    service: ServiceId.make('google/sheets'),
    name: 'Google Sheets',
    domain: 'sheets.google.com',
    definition: definition('sheets'),
    origin: 'https://sheets.googleapis.com',
    scopes: [
      ...identity,
      'https://www.googleapis.com/auth/spreadsheets',
      'https://www.googleapis.com/auth/drive.file',
    ],
  }),
  GoogleService.make({
    service: ServiceId.make('google/tasks'),
    name: 'Google Tasks',
    domain: 'tasks.google.com',
    definition: definition('tasks'),
    origin: 'https://tasks.googleapis.com',
    scopes: [...identity, 'https://www.googleapis.com/auth/tasks'],
  }),
]

/** The Google service an Integration identity names, when it is one of Vivid's own. */
export function googleService(service: ServiceId) {
  return Option.fromUndefinedOr(googleServices.find((candidate) => candidate.service === service))
}

/**
 * The source of one Google app, as Executor's guide writes an OpenAPI service
 * (`packages/app-templates/executor/skills/app-authoring/integrations.md` and `accounts.md` in the
 * Executor repository): `liveOpenapiRouter` reads the definition inside the app, and the provider
 * signs in through Google's published metadata.
 *
 * - One account, not `provider.many()`: a Connection is one profile holding one account, so a tool
 *   takes Google's own input and no account identifier (as `keyed.ts` does).
 * - `hosts` keeps the token out of app code: it is a handle that Executor's network swaps for the
 *   real value only on a request to Google's API host.
 * - `resource: null` because Google's authorization server takes no resource parameter, and
 *   `access_type: offline` with `prompt: consent` because Google issues a refresh token only then.
 * - No `withApprovals`: Vivid's own Approval gates a consequential action before Executor is
 *   called, and an Executor approval has no request Vivid could resume.
 *
 * Every value enters the source as a JSON literal, so none of them can become syntax.
 */
export function googleFiles(google: GoogleService) {
  const schemes = {
    [googleMethod]: {
      type: 'oauth2',
      flows: {
        authorizationCode: {
          authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
          tokenUrl: 'https://oauth2.googleapis.com/token',
          scopes: Object.fromEntries(google.scopes.map((scope) => [scope, ''])),
        },
      },
    },
  }
  const sign = {
    discover: 'https://accounts.google.com',
    scopes: google.scopes,
    resource: null,
    authorizationParams: { access_type: 'offline', prompt: 'consent' },
  }
  const provider = `import { defineProvider, oauth2 } from "apps";
export const provider = defineProvider({ name: ${JSON.stringify(google.name)}, hosts: [${JSON.stringify(new URL(google.origin).host)}], auth: { ${googleMethod}: oauth2(${JSON.stringify(sign)}) } });
`
  const index = `import { defineApp } from "apps";
import { liveOpenapiRouter } from "apps/openapi";
import { provider } from "./provider.ts";
export default defineApp({ accounts: { google: provider } }, async ({ accounts, cache, fetch, signal }) => ({ tools: liveOpenapiRouter({ cache, fetch, signal, source: { url: ${JSON.stringify(google.definition)} }, allowedOrigin: ${JSON.stringify(google.origin)}, securitySchemes: ${JSON.stringify(schemes)}, methods: {}, oauth: [${JSON.stringify(googleMethod)}], account: accounts.google }) }));
`
  return [
    { path: 'index.ts', content: index },
    { path: 'provider.ts', content: provider },
    {
      path: 'package.json',
      content: JSON.stringify({
        name: `vivid-${google.service.replace('/', '-')}`,
        private: true,
        type: 'module',
        dependencies: { apps: googleAppsVersion },
      }),
    },
  ]
}

/**
 * The name the app is installed and found under. It carries a hash of the source, so every server
 * running the same source shares one app, and a server whose source changed installs a new app
 * beside the old one: a Connection made earlier keeps the app it names, and nothing is edited in
 * place. Executor bounds a name at 120 characters; this is under 40.
 */
export function googleAppName(google: GoogleService) {
  const revision = NodeCrypto.createHash('sha256')
    .update(JSON.stringify(googleFiles(google)))
    .digest('hex')
    .slice(0, 16)
  return `Vivid ${google.name} ${revision}`
}

/** The client Executor signs a Person in to Google with (`OAuthClientInput` in Executor's
 * `packages/sdk/src/contracts/oauth.ts`). Executor stores it encrypted on first use. */
const GoogleClient = Schema.Struct({ clientId: settingText, clientSecret: settingSecret })
export type GoogleClient = typeof GoogleClient.Type
export const encodeGoogleClient = Schema.encodeEffect(GoogleClient)

/**
 * An installation has one Google client, and it is the one a Person signs in to Vivid with: the
 * same two settings `ServerConfig` reads, so there is one place it is set and no second client to
 * keep in step. Each is read on its own, so a missing one stops launch under its own name.
 */
export const loadGoogleClient = Effect.fn('Executor.googleClient')(function* () {
  return GoogleClient.make({
    clientId: yield* requiredSetting('GOOGLE_CLIENT_ID', settingText, 'the Google client id'),
    clientSecret: yield* requiredSetting(
      'GOOGLE_CLIENT_SECRET',
      settingSecret,
      'the Google client secret',
    ),
  })
})

export const googleReturnPath = '/api/connections/return'
export const GoogleState = Schema.String.check(Schema.isMinLength(32)).pipe(
  Schema.brand('GoogleState'),
)
export const decodeGoogleState = Schema.decodeUnknownEffect(GoogleState)
