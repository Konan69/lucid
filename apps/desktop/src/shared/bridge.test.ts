import { describe, expect, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import {
  AppInfo,
  BridgeRequest,
  BridgeResponse,
  InvalidBridgeMessage,
  decodeBridgeRequest,
  decodeBridgeResponse,
  encodeBridgeRequest,
  encodeBridgeResponse,
} from './bridge.ts'

describe('desktop bridge protocol', () => {
  it.effect('round-trips each tagged request through its wire encoding', () =>
    Effect.gen(function* () {
      const requests = [
        BridgeRequest.cases.GetAppInfo.make({}),
        BridgeRequest.cases.GetColorSchemeState.make({}),
      ]
      for (const request of requests) {
        const encoded = yield* encodeBridgeRequest(request)
        expect(yield* decodeBridgeRequest(encoded)).toEqual(request)
      }
    }),
  )

  it.effect('round-trips a schema-owned response without widening its payload', () =>
    Effect.gen(function* () {
      const response = BridgeResponse.cases.AppInfo.make({
        value: AppInfo.make({
          appVersion: '1.0.0',
          electronVersion: '44.4.3',
          platform: 'linux',
        }),
      })
      const encoded = yield* encodeBridgeResponse(response)
      const decoded = yield* decodeBridgeResponse(encoded)

      expect(BridgeResponse.guards.AppInfo(decoded)).toBe(true)
      expect(decoded).toEqual(response)
    }),
  )

  it.effect('rejects an undeclared request before dispatch', () =>
    Effect.gen(function* () {
      const undeclaredRequest = Object.fromEntries([
        ['_tag', 'ReadFile'],
        ['path', '/tmp/a'],
      ])
      const error = yield* Effect.flip(decodeBridgeRequest(undeclaredRequest))
      expect(error).toBeInstanceOf(InvalidBridgeMessage)
    }),
  )
})
