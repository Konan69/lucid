import * as NodeCrypto from 'node:crypto'
import { describe, expect, it } from '@effect/vitest'
import { ConfigProvider, Effect, Layer, Redacted } from 'effect'
import { ConfigurationError } from '../config.ts'
import { PushConfig, pushConfigLayer } from './config.ts'

/** Two throwaway pairs made here; no operator credential is read. */
const pair = () => {
  const curve = NodeCrypto.createECDH('prime256v1')
  curve.generateKeys()
  return {
    publicKey: curve.getPublicKey().toString('base64url'),
    privateKey: curve.getPrivateKey().toString('base64url'),
  }
}
const own = pair()
const other = pair()
const settings = {
  VIVID_PUSH_VAPID_PUBLIC: own.publicKey,
  VIVID_PUSH_VAPID_PRIVATE: own.privateKey,
  VIVID_PUSH_SUBJECT: 'mailto:push@example.test',
}
const configured = (values: Partial<typeof settings>) =>
  pushConfigLayer.pipe(Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(values))))

/**
 * Away notifications are part of every running Vivid: with a setting missing, a subject a push
 * service would refuse, or a private key from another pair, the Layer does not build, so the
 * server does not start, and the failure names the variable without carrying a supplied value.
 */
describe('push settings', () => {
  for (const [name, values, variable] of [
    [
      'the public key is missing',
      { ...settings, VIVID_PUSH_VAPID_PUBLIC: undefined },
      'VIVID_PUSH_VAPID_PUBLIC',
    ],
    [
      'the public key is not a P-256 point',
      { ...settings, VIVID_PUSH_VAPID_PUBLIC: 'invalid' },
      'VIVID_PUSH_VAPID_PUBLIC',
    ],
    [
      'the private key is missing',
      { ...settings, VIVID_PUSH_VAPID_PRIVATE: undefined },
      'VIVID_PUSH_VAPID_PRIVATE',
    ],
    [
      'the private key belongs to another pair',
      { ...settings, VIVID_PUSH_VAPID_PRIVATE: other.privateKey },
      'VIVID_PUSH_VAPID_PRIVATE',
    ],
    [
      'the private key is not a key',
      { ...settings, VIVID_PUSH_VAPID_PRIVATE: 'invalid' },
      'VIVID_PUSH_VAPID_PRIVATE',
    ],
    [
      'the subject is missing',
      { ...settings, VIVID_PUSH_SUBJECT: undefined },
      'VIVID_PUSH_SUBJECT',
    ],
    [
      'the subject is neither https: nor mailto:',
      { ...settings, VIVID_PUSH_SUBJECT: 'http://vivid.example.test' },
      'VIVID_PUSH_SUBJECT',
    ],
  ] as const) {
    it.effect(`does not build when ${name}`, () =>
      Effect.gen(function* () {
        const failure = yield* Layer.build(configured(values)).pipe(Effect.scoped, Effect.flip)
        expect(failure).toBeInstanceOf(ConfigurationError)
        expect(failure).toMatchObject({ variable })
        expect(JSON.stringify(failure)).not.toContain(other.privateKey)
        expect(JSON.stringify(failure)).not.toContain(own.privateKey)
      }),
    )
  }

  it.effect('advertises the public key of a matching pair', () =>
    Effect.gen(function* () {
      // Each case owns fresh mutable services and their resource scope.
      const caseContext = yield* Layer.build(configured(settings))
      return yield* Effect.gen(function* () {
        const config = yield* PushConfig
        expect(config.publicKey).toBe(own.publicKey)
        expect(Redacted.value(config.privateKey)).toBe(own.privateKey)
      }).pipe(Effect.provide(caseContext))
    }).pipe(Effect.scoped),
  )
})
