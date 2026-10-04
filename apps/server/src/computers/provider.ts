import { Config, Effect, Layer, Option } from 'effect'
import { boatMachineLayer } from './boat.ts'
import { unavailableMachineLayer } from './machine.ts'

/** Provider selection belongs to server composition; Boat is the only configured Computer provider. */
export const machineLayer = Layer.unwrap(
  Effect.gen(function* () {
    const provider = yield* Config.option(Config.Literals(['boat'], 'VIVID_COMPUTER_PROVIDER'))
    if (Option.isNone(provider)) return unavailableMachineLayer
    return boatMachineLayer
  }),
)
