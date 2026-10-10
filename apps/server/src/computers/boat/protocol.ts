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
/** Boat's machine sizes, smallest first, with the data each can hold (its documentation,
 * "Machine types": 12, 50, 125 and 251 GB). The order is used: a start that finds no machine of
 * its size free, or whose data does not fit it, moves to the sizes after it (`transport.ts`,
 * `sizes`), never to a smaller one. `xlarge` is the last resort and Boat gives it only on its
 * larger plans (`machine_class_plan_required` otherwise). */
export const Size = Schema.Literals(['small', 'default', 'large', 'xlarge'])
export const Lifetime = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 2592000 }))
/** Operator-published frozen Computer release; names are versioned and never point at a Person's machine. */
export const TemplateName = Schema.String.check(
  Schema.isPattern(/^vivid-computer-[a-z0-9-]{1,48}$/u),
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
/**
 * Boat's refusal. `code` is its closed word for what happened. `message` is a sentence for a
 * person and is read in one place only, to tell which `resume_failed` this is (`transport.ts`,
 * `OUTGROWN`); it is never kept, logged or shown, because Boat may put anything in it.
 */
export const ErrorReply = Schema.Struct({
  ok: Schema.Literal(false),
  error: Schema.Struct({
    code: Schema.String,
    status: Schema.Int,
    message: Schema.optionalKey(Schema.String),
  }),
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

/**
 * What Boat answers when a public key is authorized on a running machine (`POST
 * /sandboxes/{id}/sshkey`, body `{ key }`). Seen on 5 October 2026 on the trial plan: 200, and 200
 * again for a key already there. `hostKey` is one OpenSSH public key line, the key of the machine
 * as it runs now; it changes with every resume, as the address does, so none of this is stored.
 * `sshEndpoint` ("host:port") is set only when the machine has no public address of its own.
 */
export const Authorized = Schema.Struct({
  ok: Schema.Literal(true),
  machineIp: Schema.String.check(Schema.isNonEmpty()),
  sshEndpoint: Schema.optionalKey(Schema.NullOr(Schema.String)),
  sshUser: Schema.String.check(Schema.isNonEmpty()),
  hostKey: Schema.String.check(Schema.isPattern(/^\S+ \S+/u)),
})
export type Authorized = typeof Authorized.Type
