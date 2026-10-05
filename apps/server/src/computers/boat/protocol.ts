import { Schema } from 'effect'

/** Boat v1 wire vocabulary, from https://docs.boat.dev/openapi/boat-v1.yaml.
 * Deliberately project out machine addresses, provider error messages and inherited credentials. */
/** The characters Boat makes a machine id from, after `bx_`, and how many of them there are. */
export const providerAlphabet = '23456789abcdefghjkmnpqrstuvwxyz'
export const providerLength = 8
export const ProviderId = Schema.String.check(
  Schema.isPattern(new RegExp(`^bx_[${providerAlphabet}]{${providerLength}}$`, 'u')),
).pipe(Schema.brand('BoatMachineId'))
export type ProviderId = typeof ProviderId.Type
/** Boat's machine sizes, smallest first. The order is used: a start that finds no machine of its
 * size free moves to the sizes after it (`transport.ts`, `sizes`), never to a smaller one, which
 * Boat refuses when the disk does not fit (`type_too_small`). */
export const Size = Schema.Literals(['small', 'default', 'large'])
export const Lifetime = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 2592000 }))
/** Operator-published frozen Computer release; names are versioned and never point at a Person's machine. */
export const TemplateName = Schema.String.check(
  Schema.isPattern(/^vivid-computer-[a-z0-9-]{1,48}$/),
)
export const CreateRequest = Schema.Struct({
  type: Size,
  ttlSeconds: Schema.NullOr(Lifetime),
  noEnv: Schema.Literal(true),
  snapshots: Schema.Literal(true),
  /** Optional only for historic persisted stock-image intents and the one-time preparation machine.
   * Production configuration always supplies a verified frozen release. Boat's v1 `from` field
   * restores that named snapshot without modifying its source machine. */
  from: Schema.optionalKey(TemplateName),
  /** The organization whose wallet pays. Absent, Boat bills the account the API key belongs to:
   * an account that is in no organization has nothing to name here. */
  org: Schema.optionalKey(Schema.String.check(Schema.isNonEmpty())),
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
/**
 * One line of a streamed command (`stream: true`, `application/x-ndjson`): `started`, then output
 * as the command writes it, then exactly one `exit` or `error`. `oomKilled` is sent by Boat (seen
 * 5 October 2026) and is not in its published schema, so its absence is not an error.
 */
export const CommandFrame = Schema.Union([
  Schema.Struct({ type: Schema.Literal('started') }),
  Schema.Struct({ type: Schema.Literals(['stdout', 'stderr']), data: Schema.String }),
  Schema.Struct({
    type: Schema.Literal('exit'),
    exitCode: Schema.NullOr(Schema.Int),
    timedOut: Schema.Boolean,
    oomKilled: Schema.optionalKey(Schema.Boolean),
  }),
  Schema.Struct({ type: Schema.Literal('error') }),
])
export type CommandFrame = typeof CommandFrame.Type
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
