import * as Effect from 'effect/Effect'
import { ipcMain, type WebContents } from 'electron'
import {
  BRIDGE_EVENT_CHANNEL,
  BRIDGE_INVOKE_CHANNEL,
  BridgeEvent,
  InvalidBridgeMessage,
  type BridgeResponse,
  type BridgeRequest,
  type ColorSchemeState,
  encodeBridgeEvent,
} from '../shared/bridge.ts'
import { handleBridgeRequest, type BridgeHandlers } from './requests.ts'

/** Electron owns Promise execution; main supplies its one Effect runtime boundary. */
export interface BridgeRuntime {
  readonly run: (
    program: Effect.Effect<typeof BridgeResponse.Encoded, InvalidBridgeMessage>,
  ) => Promise<typeof BridgeResponse.Encoded>
}

/**
 * Admit only the app window's trusted main frame. A subframe or another window cannot invoke
 * main-process authority even if it guesses the private channel name.
 */
export function registerBridge(input: {
  readonly handlers: BridgeHandlers
  readonly runtime: BridgeRuntime
  readonly isTrustedSender: (id: number, url: string, request: BridgeRequest) => boolean
}): void {
  ipcMain.handle(BRIDGE_INVOKE_CHANNEL, (event, payload) => {
    const frame = event.senderFrame
    const trusted = frame !== null && frame === event.sender.mainFrame
    const program = trusted
      ? handleBridgeRequest(payload, input.handlers, (request) =>
          input.isTrustedSender(event.sender.id, frame.url, request),
        )
      : Effect.fail(new InvalidBridgeMessage({ direction: 'request' }))
    return input.runtime.run(program)
  })
}

/** Encode a trusted native scheme notification before copying it to the isolated renderer. */
export function sendColorSchemeChanged(target: WebContents, value: ColorSchemeState): void {
  target.send(
    BRIDGE_EVENT_CHANNEL,
    encodeBridgeEvent(BridgeEvent.cases.ColorSchemeChanged.make({ value })),
  )
}
