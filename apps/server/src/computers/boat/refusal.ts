import { Effect, Schema } from 'effect'
import { MachineOperationFailed, MachineResponseInvalid } from '../machine.ts'
import { InputRoute } from './receipt.ts'

const RefusalCode = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9_]*$/)).pipe(
  Schema.brand('ComputerToolRefusalCode'),
)
const ArgumentsRefused = Schema.Struct({ code: RefusalCode })
const BrowserRefused = Schema.Struct({
  status: Schema.Literal('refused'),
  refusal: Schema.Struct({ code: RefusalCode }),
})
const isArgumentsRefused = Schema.is(ArgumentsRefused)
const isBrowserRefused = Schema.is(BrowserRefused)
const ActionRefused = Schema.Struct({ effect: Schema.Literal('refused'), route: InputRoute })
const isActionRefused = Schema.is(ActionRefused)
const parse = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json))

/** The public Machine failure tag stays compatible; the adapter preserves the driver's exact
 * refusal code. Provider detail/message text can contain private input and is never retained. */
export class ComputerToolRefused extends MachineOperationFailed.extend<ComputerToolRefused>(
  'ComputerToolRefused',
)({ code: RefusalCode }) {}

/** CLI action projection omits the original browser refusal code; preserve its real route
 * without inventing a code or accepting a refused receipt through a permissive decoder. */
export class ComputerActionRefused extends MachineOperationFailed.extend<ComputerActionRefused>(
  'ComputerActionRefused',
)({ route: InputRoute }) {}

/** Cua 0.23.2 reports argument and browser refusals as exit-zero JSON in two distinct shapes.
 * Recognize both before the success decoder, including when that decoder accepts any JSON. */
export const decodeTool = <A>(tool: string, schema: Schema.ConstraintDecoder<A>) =>
  Effect.fn('Machine.boat.driver.decode')(function* (stdout: string) {
    const response = yield* parse(stdout).pipe(
      Effect.mapError(() => new MachineResponseInvalid({ operation: 'computer-tool' })),
    )
    if (isArgumentsRefused(response))
      return yield* new ComputerToolRefused({ operation: tool, code: response.code })
    if (isBrowserRefused(response))
      return yield* new ComputerToolRefused({ operation: tool, code: response.refusal.code })
    if (isActionRefused(response))
      return yield* new ComputerActionRefused({ operation: tool, route: response.route })
    return yield* Schema.decodeUnknownEffect(schema)(response).pipe(
      Effect.mapError(() => new MachineResponseInvalid({ operation: 'computer-tool' })),
    )
  })
