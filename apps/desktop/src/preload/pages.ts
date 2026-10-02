import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Result from 'effect/Result'
import * as Schema from 'effect/Schema'
import { ipcRenderer } from 'electron'
import {
  BRIDGE_EVENT_CHANNEL,
  BridgeRequest,
  BridgeResponse,
  BridgeEvent,
  decodeBridgeEventResult,
} from '../shared/bridge.ts'
import {
  PagesRequest,
  PagesResponse,
  type BrowserState,
  type PageDownloadRefused,
  type VividPagesBridge,
} from '../shared/pages.ts'

/** Protocol mismatch is distinct from expected refusal of a page operation. */
class PageBridgeResponseInvalid extends Schema.TaggedError<PageBridgeResponseInvalid>()(
  'PageBridgeResponseInvalid',
  {},
  { title: 'Desktop page response did not match its request' },
) {}

const decodePagesRequest = Schema.decodeUnknownEffect(PagesRequest, { onExcessProperty: 'error' })

/**
 * Adapt validated IPC to the renderer's page API. The callback supplies the existing private invoke
 * adapter; no new channel or renderer-selected Electron identifier is exposed.
 */
export function createPagesBridge<E>(
  invoke: (request: BridgeRequest) => Effect.Effect<BridgeResponse, E>,
  run: <A, Failure>(program: Effect.Effect<A, Failure>) => Promise<A>,
): VividPagesBridge {
  const listeners = new Set<(state: BrowserState) => void>()
  const downloadListeners = new Set<(event: PageDownloadRefused) => void>()
  let latest = Option.none<BrowserState>()

  /** Requests are validated here for JS callers and independently again in main. */
  const call = Effect.fn('DesktopPreload.pages.call')(function* (
    payload: typeof Schema.Unknown.Type,
  ) {
    const request = yield* decodePagesRequest(payload)
    const response = yield* invoke(BridgeRequest.cases.Pages.make({ request }))
    if (!BridgeResponse.guards.Pages(response)) return yield* new PageBridgeResponseInvalid({})
    if (PagesResponse.guards.Rejected(response.value)) return yield* response.value.reason
    return response.value
  })

  /** A void operation must never accept a mismatched snapshot or handle response. */
  const done = Effect.fn('DesktopPreload.pages.done')(function* (request: PagesRequest) {
    const response = yield* call(request)
    if (!PagesResponse.guards.Done(response)) return yield* new PageBridgeResponseInvalid({})
    return undefined
  })

  /** Publish monotonic whole snapshots; an older invoke result cannot overwrite a newer push. */
  const accept = (state: BrowserState): void => {
    if (Option.exists(latest, (previous) => previous.revision >= state.revision)) return
    latest = Option.some(state)
    for (const listener of listeners) listener(state)
  }

  /** One decoded event adapter serves all listeners, with no Electron event objects crossing worlds. */
  ipcRenderer.on(BRIDGE_EVENT_CHANNEL, (_event, payload) => {
    const result = decodeBridgeEventResult(payload)
    if (Result.isFailure(result)) return
    const event = result.success
    if (BridgeEvent.guards.PagesChanged(event)) accept(event.value)
    if (BridgeEvent.guards.PageDownloadRefused(event))
      for (const listener of downloadListeners) listener(event.value)
  })

  /** Hydrate subscriptions even when they attach after a page's last native event. */
  const snapshot = Effect.fn('DesktopPreload.pages.snapshot')(function* () {
    const response = yield* call(PagesRequest.cases.Get.make({}))
    if (!PagesResponse.guards.State(response)) return yield* new PageBridgeResponseInvalid({})
    return accept(response.value)
  })

  return {
    open: (input) =>
      run(
        Effect.gen(function* () {
          const response = yield* call(PagesRequest.cases.Open.make(input))
          if (!PagesResponse.guards.Opened(response))
            return yield* new PageBridgeResponseInvalid({})
          return response.tab
        }),
      ),
    show: (tab) => run(done(PagesRequest.cases.Show.make({ tab }))),
    close: (tab) => run(done(PagesRequest.cases.Close.make({ tab }))),
    go: (input) => run(done(PagesRequest.cases.Go.make(input))),
    back: (tab) => run(done(PagesRequest.cases.Back.make({ tab }))),
    forward: (tab) => run(done(PagesRequest.cases.Forward.make({ tab }))),
    reload: (tab) => run(done(PagesRequest.cases.Reload.make({ tab }))),
    stop: (tab) => run(done(PagesRequest.cases.Stop.make({ tab }))),
    place: (placement) => run(done(PagesRequest.cases.Place.make({ placement }))),
    reset: () => run(done(PagesRequest.cases.Reset.make({}))),
    forget: () => run(done(PagesRequest.cases.Forget.make({}))),
    watch: (listener) => {
      listeners.add(listener)
      Option.map(latest, listener)
      void run(
        snapshot().pipe(
          Effect.matchEffect({
            onFailure: () => Effect.sync(() => console.error('desktop: page subscription failed')),
            onSuccess: () => Effect.void,
          }),
        ),
      )
      return () => {
        listeners.delete(listener)
      }
    },
    watchDownloads: (listener) => {
      downloadListeners.add(listener)
      return () => {
        downloadListeners.delete(listener)
      }
    },
  }
}
