import { useAtomValue } from '@effect/atom-react'
import type { Device } from '@vivid/contracts'
import { deciding, type makeLive } from '@vivid/state'
import { Effect, Layer, Result } from 'effect'
import { confirm, warn } from './haptics'
import { useLiveData, type LiveData } from './live'

/** Each signed-in session owns one decision machine across all its mounted screens. */
export const makeDeviceDecisions = (engine: ReturnType<typeof makeLive>) => {
  const decisions = deciding.make(
    Layer.succeed(deciding.Sending, {
      send: Effect.fn('Devices.decide')(function* ({
        device,
        allow,
      }: Parameters<deciding.SendingService['send']>[0]) {
        const result = yield* engine.change((client) =>
          allow ? client.AllowDevice({ id: device.id }) : client.RevokeDevice({ id: device.id }),
        )
        if (Result.isFailure(result)) return yield* new deciding.Refused({ id: device.id })
      }),
    }),
  )
  engine.registry.mount(decisions.reading)
  return decisions
}

/** Reads the same in-flight decision and refusal from Feed, Settings, Home and Threads. */
export const useDeviceDecision = () => {
  const data = useLiveData()
  return useAtomValue(data.devices.reading)
}

/** Access is never optimistically granted or denied before the server confirms it. */
export const answerDevice = (data: LiveData, device: Device, allow: boolean) => {
  if (allow) confirm()
  else warn()
  data.registry.set(data.devices.send, data.devices.decide({ device, allow }))
}
