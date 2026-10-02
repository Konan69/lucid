import { Schema } from 'effect'

/** Boat v1 wire vocabulary, from https://docs.boat.dev/openapi/boat-v1.yaml.
 * Deliberately project out machine addresses, provider error messages and inherited credentials. */
export const ProviderId = Schema.String.check(
  Schema.isPattern(/^bx_[23456789abcdefghjkmnpqrstuvwxyz]{8}$/),
).pipe(Schema.brand('BoatMachineId'))
export type ProviderId = typeof ProviderId.Type
export const Size = Schema.Literals(['small', 'default', 'large'])
export const Lifetime = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 2592000 }))
export const CreateRequest = Schema.Struct({
  type: Size,
  ttlSeconds: Schema.NullOr(Lifetime),
  noEnv: Schema.Literal(true),
  snapshots: Schema.Literal(true),
  org: Schema.String.check(Schema.isNonEmpty()),
})
export type CreateRequest = typeof CreateRequest.Type
export const State = Schema.Literals([
  'init',
  'provisioning',
  'provisioned',
  'cloning',
  'ready',
  'idle',
  'running',
  'archiving',
  'archived',
  'error',
  'cancelled',
])
const AvailableState = Schema.Literals([
  'init',
  'provisioning',
  'provisioned',
  'cloning',
  'ready',
  'idle',
  'running',
  'archiving',
  'archived',
  'error',
])
export const MachineRecord = Schema.Union([
  Schema.Struct({
    id: ProviderId,
    state: AvailableState,
    desktopAvailable: Schema.Boolean,
    snapshotAvailable: Schema.Boolean,
  }),
  Schema.Struct({ id: ProviderId, state: Schema.Literal('cancelled') }),
])
export type MachineRecord = typeof MachineRecord.Type
export const Info = Schema.Struct({
  ok: Schema.Literal(true),
  type: Schema.Literal('sandbox.info'),
  sandbox: MachineRecord,
})
export const Created = Schema.Struct({
  ok: Schema.Literal(true),
  type: Schema.Literal('sandbox.created'),
  status: Schema.Literals(['provisioning', 'ready']),
  ttlSeconds: Schema.NullOr(Lifetime),
  sandbox: MachineRecord,
})
export const Transition = Schema.Struct({
  ok: Schema.Literal(true),
  type: Schema.Literals(['sandbox.stopping', 'sandbox.resuming']),
  id: ProviderId,
  status: Schema.String,
})
export const Desktop = Schema.Struct({
  ok: Schema.Literal(true),
  type: Schema.Literal('desktop.url'),
  desktopUrl: Schema.String.check(Schema.isNonEmpty()),
})
export const Command = Schema.Struct({
  ok: Schema.Literal(true),
  type: Schema.Literal('command.finished'),
  success: Schema.Boolean,
  exitCode: Schema.NullOr(Schema.Int),
  stdout: Schema.String,
  stderr: Schema.String,
  timedOut: Schema.Boolean,
  stdoutTruncated: Schema.optionalKey(Schema.Boolean),
  stderrTruncated: Schema.optionalKey(Schema.Boolean),
})
export type Command = typeof Command.Type
export const Written = Schema.Struct({
  ok: Schema.Literal(true),
  type: Schema.Literal('file.written'),
  success: Schema.Literal(true),
  path: Schema.String,
  encoding: Schema.Literal('utf8'),
  size: Schema.Int,
})
export const ErrorReply = Schema.Struct({
  ok: Schema.Literal(false),
  error: Schema.Struct({ code: Schema.String, status: Schema.Int }),
})

/** Base64 file ingress used for native full-size desktop pictures. */
export const ReadFile = Schema.Struct({
  ok: Schema.Literal(true),
  type: Schema.Literal('file.read'),
  success: Schema.Literal(true),
  path: Schema.String,
  encoding: Schema.Literal('base64'),
  size: Schema.Int,
  content: Schema.String.check(Schema.isNonEmpty()),
})
