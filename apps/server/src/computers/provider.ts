import { Config, Effect, Layer, Option } from 'effect'
import { boatMachineLayer } from './boat.ts'
import { dockerMachineLayer } from './docker.ts'
import { unavailableMachineLayer } from './machine.ts'

/** Provider selection belongs to server composition; Docker is the explicit offline stand-in. */
export const machineLayer = Layer.unwrap(
  Effect.gen(function* () {
    const provider = yield* Config.option(
      Config.Literals(['docker', 'boat'], 'VIVID_COMPUTER_PROVIDER'),
    )
    if (Option.isNone(provider)) return unavailableMachineLayer
    if (provider.value === 'boat') return boatMachineLayer
    return dockerMachineLayer(yield* Config.NonEmptyString('VIVID_COMPUTER_IMAGE'))
  }),
)
