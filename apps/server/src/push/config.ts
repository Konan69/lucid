import * as NodeCrypto from 'node:crypto'
import { Config, Context, Data, Effect, Layer, Option, Redacted } from 'effect'
import { PushUnavailable } from '@vivid/contracts'

/** A partial installation stays unavailable without lending a default credential to the adapter. */
export type PushConfiguration = Data.TaggedEnum<{
  Unavailable: {}
  Configured: {
    readonly publicKey: string
    readonly privateKey: Redacted.Redacted
    readonly subject: string
  }
}>
export const PushConfiguration = Data.taggedEnum<PushConfiguration>()
export class PushConfig extends Context.Service<PushConfig, PushConfiguration>()(
  'vivid/PushConfig',
) {}

/** Validate the pair once; a typo must not advertise a public key that can never send. */
const validate = Effect.fn('PushConfig.validate')(function* (input: {
  readonly publicKey: string
  readonly privateKey: Redacted.Redacted
  readonly subject: string
}) {
  return yield* Effect.try({
    try: () => {
      const subject = new URL(input.subject)
      const curve = NodeCrypto.createECDH('prime256v1')
      curve.setPrivateKey(Buffer.from(Redacted.value(input.privateKey), 'base64url'))
      return (
        /^(?:https:|mailto:)$/u.test(subject.protocol) &&
        curve.getPublicKey().toString('base64url') === input.publicKey
      )
    },
    catch: () => new PushUnavailable({ message: 'Push notifications are not configured.' }),
  })
})

/** Read optional config through Effect; missing or unusable push config never stops the server. */
export const loadPushConfiguration = Effect.fn('PushConfig.load')(function* () {
  const publicKey = yield* Config.option(Config.String('VIVID_PUSH_VAPID_PUBLIC'))
  const privateKey = yield* Config.option(Config.Redacted('VIVID_PUSH_VAPID_PRIVATE'))
  const subject = yield* Config.option(Config.String('VIVID_PUSH_SUBJECT'))
  if (Option.isNone(publicKey) || Option.isNone(privateKey) || Option.isNone(subject))
    return PushConfiguration.Unavailable()
  const input = { publicKey: publicKey.value, privateKey: privateKey.value, subject: subject.value }
  const valid = yield* validate(input).pipe(
    Effect.catchTag('PushUnavailable', () => Effect.succeed(false)),
  )
  return valid ? PushConfiguration.Configured(input) : PushConfiguration.Unavailable()
})

/** Callers receive a specific model/client-readable refusal instead of a startup failure. */
export const requirePushConfiguration = Effect.fn('PushConfig.require')(function* () {
  return yield* PushConfiguration.$match(yield* PushConfig, {
    Unavailable: () =>
      Effect.fail(new PushUnavailable({ message: 'Push notifications are not configured.' })),
    Configured: (config) => Effect.succeed(config),
  })
})

export const pushConfigLayer = Layer.effect(PushConfig, loadPushConfiguration())
