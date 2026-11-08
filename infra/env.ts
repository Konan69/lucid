import * as Config from 'effect/Config'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Redacted from 'effect/Redacted'
import * as Schema from 'effect/Schema'

export class InfrastructureEnvironmentError extends Schema.TaggedError<InfrastructureEnvironmentError>()(
  'InfrastructureEnvironmentError',
  {
    variable: Schema.String,
    message: Schema.String,
  },
  { title: 'Infrastructure environment error' },
) {}

/**
 * What a deploy must be given. Every part of the product a Person is told Vivid has is required
 * here: the Computer, Integrations, texting, away notifications and Google sign-in. A deploy that
 * lacks one of their settings stops in this file, before it touches the target, and names the
 * variable. The server holds the same line at its own start (`requiredSetting` in
 * `apps/server/src/config.ts`), so "not configured" is neither a deploy that went through nor a
 * server that is running. Only choices with a default, and telemetry, stay optional.
 */
export interface InfrastructureEnvironment {
  readonly authSecret: Redacted.Redacted
  readonly runtimeToken: Redacted.Redacted
  /** OpenCode Go, which the runtime answers with (`packages/agent/runtime/src/providers/opencode.ts`). */
  readonly openCodeKey: Redacted.Redacted
  /** OpenRouter supplies the server models and declared runtime models. */
  readonly openRouterKey: Redacted.Redacted
  readonly model: string
  /** Sign-in with Google: the client's id and secret and the address Google sends a Person back to. */
  readonly google: GoogleAccess
  /**
   * The key and organization Vivid's server uses on Executor, which gives Vivid its Integrations.
   * Both are minted on the deployed Executor itself (`docs/24-executor-scale.md`).
   */
  readonly executor: ExecutorAccess
  /** Texting Vivid over iMessage, through Photon (`apps/server/src/channels/photon.ts`). */
  readonly texting: TextingAccess
  /** Notifications while a Person is away, to browser and phone (`apps/server/src/push/config.ts`). */
  readonly push: PushAccess
  /**
   * Whether Jev makes Vivid's small judgements (`VIVID_DECISIONS` in
   * `apps/server/src/decisions/model.ts`). Absent means the server's own default, which is off.
   * It needs no key of its own: decisions go through the model gateway with `OPENROUTER_API_KEY`.
   */
  readonly decisions: Option.Option<string>
  /** Who sees the Discord Integration (`VIVID_DISCORD_PEOPLE` in
   * `apps/server/src/connections/discord.ts`). Absent hides it from everyone. */
  readonly discordPeople: Option.Option<string>
  readonly discordBotToken: Option.Option<Redacted.Redacted>
  /**
   * Where the server exports traces and logs (`apps/server/src/observability/export.ts`). Without
   * it the server runs exactly as before and exports nothing.
   */
  readonly observability: Option.Option<ObservabilityAccess>
  /**
   * Vivid's Computer. It is part of the product, so it is not optional: a deploy without it stops
   * here, before it touches the target, and names the variable it lacks.
   */
  readonly computer: ComputerAccess
}

/**
 * What the server needs to reach Boat, the Computer provider (read in
 * `apps/server/src/computers/boat/transport.ts`). The key and the name of the prepared template
 * are required. The rest are choices the server has its own default for, sent only when set.
 */
export interface ComputerAccess {
  readonly key: Redacted.Redacted
  /** The named Boat snapshot a Person's Computer is restored from (`infra/computer/prepare.py`). */
  readonly template: string
  /** The paying organization, when the key's account belongs to one. */
  readonly organization: Option.Option<string>
  /** `small`, `default` or `large`; the server validates it and defaults to `default`. */
  readonly size: Option.Option<string>
  /** Seconds before Boat archives an idle machine; the server validates it and defaults to 3600. */
  readonly lifetimeSeconds: Option.Option<string>
  /**
   * One existing Boat machine this installation uses instead of creating one for each Person. The
   * first Person to start a Computer keeps it and other accounts are refused. Set it while the
   * Boat account cannot create machines; leave it out for a Computer per Person.
   */
  readonly machine: Option.Option<string>
}

export interface GoogleAccess {
  readonly clientId: string
  readonly clientSecret: Redacted.Redacted
  readonly redirectUri: string
}

/** A Photon project: its id and the secret that signs the server in to it. */
export interface TextingAccess {
  readonly projectId: string
  readonly projectSecret: Redacted.Redacted
}

/**
 * A VAPID key pair and the contact a push service may write to (`https:` or `mailto:`). The pair
 * is generated once for an installation and kept: replacing it silently unsubscribes every browser
 * and phone that subscribed with the old public key.
 */
export interface PushAccess {
  readonly publicKey: string
  readonly privateKey: Redacted.Redacted
  readonly subject: string
}

/** The OTLP/HTTP base address and the `name=value` headers that authenticate an export. */
export interface ObservabilityAccess {
  readonly url: string
  readonly headers: Redacted.Redacted
}

export interface ExecutorAccess {
  readonly key: Redacted.Redacted
  readonly organization: string
}

const environmentError = (variable: string) =>
  new InfrastructureEnvironmentError({
    variable,
    message: `${variable} is missing or invalid`,
  })

/** A present, non-empty value: an empty line in an env file must not pass for a setting. */
const requiredString = (name: string) =>
  Config.NonEmptyString(name).pipe(Effect.mapError(() => environmentError(name)))

export const requiredSecret = (name: string) => requiredString(name).pipe(Effect.map(Redacted.make))

const optionalString = (name: string) =>
  Config.option(Config.String(name)).pipe(Effect.mapError(() => environmentError(name)))

const optionalSecret = (name: string) =>
  Config.option(Config.Redacted(name)).pipe(Effect.mapError(() => environmentError(name)))

/** Read application credentials once so resource declarations only receive typed values. */
export const loadInfrastructureEnvironment = Effect.gen(function* () {
  const authSecret = yield* requiredSecret('AUTH_SECRET')
  const runtimeToken = yield* requiredSecret('VIVID_RUNTIME_TOKEN')
  const openCodeKey = yield* requiredSecret('OPENCODE_API_KEY')
  const openRouterKey = yield* requiredSecret('OPENROUTER_API_KEY')
  const model = yield* Config.String('VIVID_MODEL').pipe(
    Config.withDefault('opencode-go/glm-5.3-flash'),
    Effect.mapError(() => environmentError('VIVID_MODEL')),
  )
  const google: GoogleAccess = {
    clientId: yield* requiredString('GOOGLE_CLIENT_ID'),
    clientSecret: yield* requiredSecret('GOOGLE_CLIENT_SECRET'),
    redirectUri: yield* requiredString('GOOGLE_REDIRECT_URI'),
  }
  const executor: ExecutorAccess = {
    key: yield* requiredSecret('VIVID_EXECUTOR_KEY'),
    organization: yield* requiredString('VIVID_EXECUTOR_ORGANIZATION'),
  }
  const texting: TextingAccess = {
    projectId: yield* requiredString('VIVID_PHOTON_PROJECT_ID'),
    projectSecret: yield* requiredSecret('VIVID_PHOTON_PROJECT_SECRET'),
  }
  const push: PushAccess = {
    publicKey: yield* requiredString('VIVID_PUSH_VAPID_PUBLIC'),
    privateKey: yield* requiredSecret('VIVID_PUSH_VAPID_PRIVATE'),
    subject: yield* requiredString('VIVID_PUSH_SUBJECT'),
  }

  const decisions = yield* optionalString('VIVID_DECISIONS')
  const discordPeople = yield* optionalString('VIVID_DISCORD_PEOPLE')
  const discordBotToken = yield* optionalSecret('VIVID_DISCORD_BOT_TOKEN')

  const otlpUrl = yield* optionalString('VIVID_OTLP_URL')
  const otlpHeaders = yield* optionalSecret('VIVID_OTLP_HEADERS')
  if (Option.isSome(otlpUrl) !== Option.isSome(otlpHeaders)) {
    return yield* new InfrastructureEnvironmentError({
      variable: 'VIVID_OTLP_URL, VIVID_OTLP_HEADERS',
      message: 'Telemetry export must provide both variables or neither',
    })
  }
  const observability = Option.zipWith(
    otlpUrl,
    otlpHeaders,
    (url, headers): ObservabilityAccess => ({ url, headers }),
  )

  const computer: ComputerAccess = {
    key: yield* requiredSecret('VIVID_BOAT_API_KEY'),
    template: yield* requiredString('VIVID_BOAT_TEMPLATE'),
    organization: yield* optionalString('VIVID_BOAT_ORG'),
    size: yield* optionalString('VIVID_BOAT_SIZE'),
    lifetimeSeconds: yield* optionalString('VIVID_BOAT_LIFETIME_SECONDS'),
    machine: yield* optionalString('VIVID_BOAT_MACHINE'),
  }

  return {
    authSecret,
    runtimeToken,
    openCodeKey,
    openRouterKey,
    model,
    google,
    executor,
    texting,
    push,
    decisions,
    discordPeople,
    discordBotToken,
    observability,
    computer,
  } satisfies InfrastructureEnvironment
}).pipe(Effect.withSpan('loadInfrastructureEnvironment'))
