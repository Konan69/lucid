import { describe, expect, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import { InvalidBridgeMessage, decodeBridgeRequest, decodeBridgeResponse } from './bridge.ts'

describe('desktop bridge ingress', () => {
  it.effect('rejects undeclared capabilities and unsafe arguments before dispatch', () =>
    Effect.gen(function* () {
      const payloads = [
        ['ReadFile', 'path', '/secret'],
        ['ChooseServer', 'origin', 'http://remote.example'],
        ['ChooseServer', 'origin', 'https://vivid.example/api'],
        ['ChooseServer', 'origin', 123],
        ['OpenExternal', 'url', 'file:///secret'],
        ['OpenExternal', 'url', 'mailto:person@example.test'],
        ['OpenExternal', 'url', 'javascript:alert(1)'],
        ['OpenExternal', 'url', 'https://person:secret@example.test'],
        ['OpenExternal', 'url', null],
      ] as const
      for (const [tag, field, value] of payloads) {
        const payload = Object.fromEntries([
          ['_tag', tag],
          [field, value],
        ])
        expect(yield* Effect.flip(decodeBridgeRequest(payload))).toBeInstanceOf(
          InvalidBridgeMessage,
        )
      }
    }),
  )

  it.effect('refuses corrupted server state at the preload response boundary', () =>
    Effect.gen(function* () {
      for (const entries of [
        [['_tag', 'Server']],
        [
          ['_tag', 'Server'],
          ['origin', 'http://remote.example'],
        ],
      ]) {
        const payload = Object.fromEntries([
          ['_tag', 'Server'],
          ['value', Object.fromEntries(entries)],
        ])
        expect(yield* Effect.flip(decodeBridgeResponse(payload))).toBeInstanceOf(
          InvalidBridgeMessage,
        )
      }
    }),
  )
})
