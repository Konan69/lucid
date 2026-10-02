import { describe, expect, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Result from 'effect/Result'
import {
  BridgeResponse,
  BridgeEvent,
  InvalidBridgeMessage,
  decodeBridgeRequest,
  decodeBridgeResponse,
  encodeBridgeResponse,
  encodeBridgeEvent,
  decodeBridgeEventResult,
} from './bridge.ts'
import {
  BrowserState,
  Page,
  PagesResponse,
  Tab,
  PageAddressRefused,
  ShowingTab,
  PageLoadFailure,
} from './pages.ts'

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

  it.effect('refuses bad page request shapes, numeric Electron ids and excess authority', () =>
    Effect.gen(function* () {
      for (const [tag, fields] of [
        ['Open', {}],
        ['Open', { address: 123 }],
        ['Open', { address: '' }],
        ['Open', { address: 'example.com', webContentsId: 42 }],
        ['Show', { tab: 42 }],
        ['Show', { tab: '42' }],
        ['Show', { tab: null }],
        ['Go', { address: 'example.com' }],
        ['Place', { placement: { x: 0, y: 0, width: -1, height: 100 } }],
        ['Place', { placement: { x: 0, y: 0, width: 100 } }],
        ['Place', { placement: { x: NaN, y: 0, width: 100, height: 100 } }],
        ['Place', { placement: { x: 0, y: Infinity, width: 100, height: 100 } }],
        ['Place', { placement: { x: -1, y: 0, width: 100, height: 100 } }],
        ['Place', { placement: false }],
        ['Forget', { partition: 'persist:vivid' }],
        ['ExecuteJavaScript', { code: 'unsafe()' }],
      ] as const) {
        const request = Object.fromEntries([['_tag', tag], ...Object.entries(fields)])
        const payload = Object.fromEntries([
          ['_tag', 'Pages'],
          ['request', request],
        ])
        expect(yield* Effect.flip(decodeBridgeRequest(payload))).toBeInstanceOf(
          InvalidBridgeMessage,
        )
      }
    }),
  )

  it.effect('round-trips full state and typed failures through a real structured clone', () =>
    Effect.gen(function* () {
      const tab = Tab.make('f198da28-8b59-4b86-8d14-f81f441954e1')
      const state = BrowserState.make({
        revision: 8,
        showing: ShowingTab.cases.Some.make({ value: tab }),
        tabs: [
          Page.make({
            tab,
            address: 'https://missing.example/',
            title: '',
            loading: false,
            canGoBack: true,
            canGoForward: false,
            failed: PageLoadFailure.cases.Some.make({ value: 'ERR_NAME_NOT_RESOLVED' }),
          }),
        ],
      })
      const response = BridgeResponse.cases.Pages.make({
        value: PagesResponse.cases.State.make({ value: state }),
      })
      const encoded = yield* encodeBridgeResponse(response)
      const decoded = yield* decodeBridgeResponse(structuredClone(encoded))
      expect(decoded).toEqual(response)
      // contextBridge drops prototypes too: callback snapshots must retain their own option tags.
      if (BridgeResponse.guards.Pages(decoded) && PagesResponse.guards.State(decoded.value))
        expect(structuredClone(decoded.value.value)).toEqual(state)
      const event = BridgeEvent.cases.PagesChanged.make({ value: state })
      const result = decodeBridgeEventResult(structuredClone(encodeBridgeEvent(event)))
      expect(Result.isSuccess(result)).toBe(true)
      if (Result.isSuccess(result)) expect(result.success).toEqual(event)
      const refusal = BridgeResponse.cases.Pages.make({
        value: PagesResponse.cases.Rejected.make({
          reason: new PageAddressRefused({ reason: 'localhost' }),
        }),
      })
      const wire = yield* encodeBridgeResponse(refusal)
      expect(yield* decodeBridgeResponse(structuredClone(wire))).toEqual(refusal)
    }),
  )
})
