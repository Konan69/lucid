import { useAtomValue } from '@effect/atom-react'
import type { Device } from '@vivid/contracts'
import { deciding } from '@vivid/state'
import { Effect, Layer, Result } from 'effect'
import { changing } from './app'
import { nudgeThisComputer } from './computers'
import { engine } from './runtime'

/** Pending requests stay visible until the server confirms the explicit decision. */
const decisions = deciding.make(
  Layer.succeed(deciding.Sending, {
    send: Effect.fn('Devices.decide')(function* ({
      device,
      allow,
    }: Parameters<deciding.SendingService['send']>[0]) {
      const result = yield* changing((client) =>
        allow ? client.AllowDevice({ id: device.id }) : client.RevokeDevice({ id: device.id }),
      )
      if (Result.isFailure(result)) return yield* new deciding.Refused({ id: device.id })
      yield* nudgeThisComputer
    }),
  }),
)

// A decision outlives whichever page asked it, including a closed Settings dialog.
engine.registry.mount(decisions.reading)

/** Feed, Settings and the persistent request section read the same attempt. */
export const useDeviceDecision = () => useAtomValue(decisions.reading)

/** The machine accepts a press only while no other decision is waiting on the server. */
export const answerDevice = (device: Device, allow: boolean) =>
  engine.registry.set(decisions.send, decisions.decide({ device, allow }))
