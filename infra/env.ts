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

export interface InfrastructureEnvironment {
  readonly authSecret: Redacted.Redacted
  readonly runtimeToken: Redacted.Redacted
  readonly modelGatewayKey: Redacted.Redacted
  readonly model: string
  readonly googleClientId: Option.Option<string>
  readonly googleClientSecret: Option.Option<Redacted.Redacted>
  readonly googleRedirectUri: Option.Option<string>
  /**
   * The key and organization Vivid's server uses on Executor. Both are minted on the deployed
   * Executor itself, so the first deploy has neither and the server runs with Integrations off.
   */
  readonly executor: Option.Option<ExecutorAccess>
  /**
   * Whether Jev makes Vivid's small judgements (`VIVID_DECISIONS` in
   * `apps/server/src/decisions/model.ts`). Absent means the server's own default, which is off.
   * It needs no key of its own: decisions go through the model gateway with `EXPLABS_API_KEY`.
   */
  readonly decisions: Option.Option<string>
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

const requiredSecret = (name: string) =>
  Config.Redacted(name).pipe(Effect.mapError(() => environmentError(name)))

const optionalString = (name: string) =>
  Config.option(Config.String(name)).pipe(Effect.mapError(() => environmentError(name)))

const optionalSecret = (name: string) =>
  Config.option(Config.Redacted(name)).pipe(Effect.mapError(() => environmentError(name)))

/** Read application credentials once so resource declarations only receive typed values. */
export const loadInfrastructureEnvironment = Effect.fn('loadInfrastructureEnvironment')(
  function* () {
    const authSecret = yield* requiredSecret('AUTH_SECRET')
    const runtimeToken = yield* requiredSecret('VIVID_RUNTIME_TOKEN')
    const modelGatewayKey = yield* requiredSecret('EXPLABS_API_KEY')
    const model = yield* Config.String('VIVID_MODEL').pipe(
      Config.withDefault('explabs/glm-5.3-flash'),
      Effect.mapError(() => environmentError('VIVID_MODEL')),
    )
    const googleClientId = yield* optionalString('GOOGLE_CLIENT_ID')
    const googleClientSecret = yield* optionalSecret('GOOGLE_CLIENT_SECRET')
    const googleRedirectUri = yield* optionalString('GOOGLE_REDIRECT_URI')

    const configuredGoogleValues = [
      Option.isSome(googleClientId),
      Option.isSome(googleClientSecret),
      Option.isSome(googleRedirectUri),
    ].filter(Boolean).length
    if (configuredGoogleValues !== 0 && configuredGoogleValues !== 3) {
      return yield* Effect.fail(
        new InfrastructureEnvironmentError({
          variable: 'GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI',
          message: 'Google OAuth configuration must provide all three variables or none',
        }),
      )
    }

    const executorKey = yield* optionalSecret('VIVID_EXECUTOR_KEY')
    const executorOrganization = yield* optionalString('VIVID_EXECUTOR_ORGANIZATION')
    if (Option.isSome(executorKey) !== Option.isSome(executorOrganization)) {
      return yield* Effect.fail(
        new InfrastructureEnvironmentError({
          variable: 'VIVID_EXECUTOR_KEY, VIVID_EXECUTOR_ORGANIZATION',
          message: 'Executor access must provide both variables or neither',
        }),
      )
    }
    const executor = Option.zipWith(
      executorKey,
      executorOrganization,
      (key, organization): ExecutorAccess => ({ key, organization }),
    )

    const decisions = yield* optionalString('VIVID_DECISIONS')

    return {
      authSecret,
      runtimeToken,
      modelGatewayKey,
      model,
      googleClientId,
      googleClientSecret,
      googleRedirectUri,
      executor,
      decisions,
    } satisfies InfrastructureEnvironment
  },
)()
