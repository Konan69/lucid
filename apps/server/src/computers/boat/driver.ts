import * as NodeCrypto from 'node:crypto'
import { Effect, Schema } from 'effect'
import {
  MachineOperationFailed,
  MachineResponseInvalid,
  type MachineFailure,
  type MachineKey,
} from '../machine.ts'
import type { ProviderId } from './protocol.ts'
import type { Transport } from './transport.ts'
import { decodeTool } from './refusal.ts'

const Capture = Schema.Struct({
  display: Schema.String,
  platform: Schema.String,
  scale_factor: Schema.Number,
  screenshot_mime_type: Schema.Literal('image/png'),
  screenshot_width: Schema.Int,
  screenshot_height: Schema.Int,
  screen_width: Schema.Int,
  screen_height: Schema.Int,
})
const decodeCapture = decodeTool('get_desktop_state', Capture)

/** Native Cua CLI over the shipped daemon socket. Named sessions retain snapshot-bound refs.
 * Source: trycua/cua libs/cua-driver/rust/crates/cua-driver/src/cli.rs, call + stdin + image output. */
export const driver = (api: Transport, id: ProviderId, key: MachineKey, socket: string) => {
  // Ended session labels cannot be reused. Each serialized action owns fresh refs and a public label.
  const session = `Vivid-${NodeCrypto.randomUUID()}`
  /** Upload into a mode-0700 directory before dispatch; private input never appears in argv.
   * Cleanup covers input and PNG even on refusal. Same-uid/root guest processes remain privileged. */
  const input = <A, E>(
    tool: string,
    args: Schema.JsonObject,
    use: (directory: string, path: string) => Effect.Effect<A, E>,
  ) =>
    Effect.gen(function* () {
      const directory = `/tmp/vivid-step-${NodeCrypto.randomUUID()}`
      const path = `${directory}/input.json`
      const prepared = yield* api.command(id, key, `umask 077; mkdir -- '${directory}'`, 30)
      if (prepared.exitCode !== 0)
        return yield* Effect.fail(new MachineOperationFailed({ operation: 'driver-input' }))
      return yield* Effect.gen(function* () {
        yield* api.write(
          id,
          path,
          JSON.stringify(
            tool === 'list_windows' || tool === 'list_apps' || tool === 'launch_app'
              ? args
              : Object.assign({}, args, { session }),
          ),
        )
        return yield* use(directory, path)
      }).pipe(
        Effect.ensuring(
          api
            .command(
              id,
              key,
              `rm -f -- '${path}' '${directory}/picture.png'; rmdir -- '${directory}'`,
              30,
            )
            .pipe(Effect.catch(() => Effect.logWarning('Computer private step cleanup failed.'))),
        ),
      )
    })
  /** Nonzero or clipped native output is a refusal, never a made-up successful receipt. */
  const invoke = Effect.fn('Machine.boat.driver.invoke')(function* (command: string) {
    const result = yield* api.command(id, key, command, 60)
    if (result.exitCode !== 0 || result.timedOut)
      return yield* Effect.fail(new MachineOperationFailed({ operation: 'computer-tool' }))
    if (result.stdoutTruncated === true || result.stderrTruncated === true)
      return yield* Effect.fail(new MachineResponseInvalid({ operation: 'computer-tool' }))
    return result.stdout
  })
  /** Decode every guest tool's JSON at ingress; public responses never contain native handles. */
  const call = <A>(tool: string, args: Schema.JsonObject, schema: Schema.ConstraintDecoder<A>) => {
    const decode = decodeTool(tool, schema)
    return input(
      tool,
      args,
      Effect.fn('Machine.boat.driver.call')(function* (_directory, path) {
        const stdout = yield* invoke(
          `/opt/ascii/cua-driver/cua-driver call '${tool}' --socket '${socket}' < '${path}'`,
        )
        return yield* decode(stdout)
      }),
    )
  }
  /** Keep full-size PNG out of command stdout: the CLI writes it and Boat's file API reads it.
   * Metadata and file bodies are independently decoded before desktop coordinates are accepted. */
  const capture = Effect.fn('Machine.boat.driver.capture')(() =>
    input(
      'get_desktop_state',
      {},
      Effect.fn('Machine.boat.driver.picture')(function* (directory, path): Effect.fn.Return<
        {
          screenshot_png_b64: string
          screenshot_mime_type: 'image/png'
          screenshot_width: number
          screenshot_height: number
          screen_width: number
          screen_height: number
        },
        MachineFailure
      > {
        const stdout = yield* invoke(
          `/opt/ascii/cua-driver/cua-driver call 'get_desktop_state' --socket '${socket}' --screenshot-out-file '${directory}/picture.png' < '${path}'`,
        )
        const metadata = yield* decodeCapture(stdout)
        const picture = yield* api.read(id, `${directory}/picture.png`)
        return {
          screenshot_png_b64: picture.content,
          screenshot_mime_type: metadata.screenshot_mime_type,
          screenshot_width: metadata.screenshot_width,
          screenshot_height: metadata.screenshot_height,
          screen_width: metadata.screen_width,
          screen_height: metadata.screen_height,
        }
      }),
    ),
  )
  return { call, capture }
}
export type Driver = ReturnType<typeof driver>
