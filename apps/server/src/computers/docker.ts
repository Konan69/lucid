import * as NodeServices from '@effect/platform-node/NodeServices'
import { CommandResult, ComputerState } from '@vivid/contracts'
import { Config, Effect, Exit, Layer, Option, Schema, Semaphore, Stream } from 'effect'
import * as ChildProcess from 'effect/unstable/process/ChildProcess'
import { ChildProcessSpawner } from 'effect/unstable/process/ChildProcessSpawner'
import * as NodeBuffer from 'node:buffer'
import { browserArguments, decodeBrowserOutput } from './browser.js'
import {
  Machine,
  MachineInputInvalid,
  MachineNotRunning,
  MachineOperationFailed,
  MachineResponseInvalid,
  type MachineKey,
  unavailableMachineLayer,
} from './machine.js'

const outputBudget = 65_536
const clippedMarker = '\n[output truncated]\n'
const Inspection = Schema.Struct({
  Created: Schema.String,
  State: Schema.Struct({
    Status: Schema.Literals([
      'created',
      'running',
      'paused',
      'restarting',
      'removing',
      'exited',
      'dead',
    ]),
    StartedAt: Schema.String,
    FinishedAt: Schema.String,
    Error: Schema.String,
    ExitCode: Schema.Number,
  }),
  NetworkSettings: Schema.Struct({
    Ports: Schema.Record(
      Schema.String,
      Schema.NullOr(
        Schema.Array(
          Schema.Struct({
            HostIp: Schema.String,
            HostPort: Schema.String,
          }),
        ),
      ),
    ),
  }),
})
const decodeInspection = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(Inspection)))

/** Drain all output while retaining only the byte budget so noisy processes cannot exhaust memory. */
const collectOutput = (
  stream: Stream.Stream<Uint8Array, import('effect/PlatformError').PlatformError>,
) =>
  Stream.runFold(
    stream,
    () => ({ bytes: NodeBuffer.Buffer.alloc(0), total: 0 }),
    (receipt, chunk) => ({
      bytes: NodeBuffer.Buffer.concat([
        receipt.bytes,
        chunk.subarray(0, Math.max(0, outputBudget - receipt.bytes.length)),
      ]),
      total: receipt.total + chunk.length,
    }),
  )

/** Docker is invoked as argv under a scoped Effect process; expected failures never leak arguments. */
export const dockerCommand = Effect.fn('Machine.docker.command')(
  function* (args: ReadonlyArray<string>) {
    const handle = yield* ChildProcess.make('docker', args, {
      stdin: 'ignore',
      forceKillAfter: '2 seconds',
    })
    const collected = yield* collectOutput(handle.all)
    const exitCode = yield* handle.exitCode
    // Binary output can expand when invalid UTF-8 becomes replacement characters. Budget the
    // actual returned UTF-8 too, rather than claiming a 64 KiB receipt that encodes to 192 KiB.
    const normalized = NodeBuffer.Buffer.from(
      new TextDecoder().decode(collected.bytes, {
        stream: collected.total > outputBudget,
      }),
    )
    const truncated = collected.total > outputBudget || normalized.length > outputBudget
    const length = truncated
      ? outputBudget - NodeBuffer.Buffer.byteLength(clippedMarker)
      : normalized.length
    // Streaming decoding drops an incomplete final code point at the clipping boundary.
    const text = new TextDecoder().decode(normalized.subarray(0, length), { stream: truncated })
    return CommandResult.make({
      exitCode,
      output: truncated ? text + clippedMarker : text,
      truncated,
    })
  },
  Effect.scoped,
  Effect.timeout('330 seconds'),
  Effect.mapError(() => new MachineOperationFailed({ operation: 'docker' })),
)

/** Infrastructure commands require a full successful receipt before changing lifecycle state. */
const checked = Effect.fn('Machine.docker.checked')(function* (args: ReadonlyArray<string>) {
  const result = yield* dockerCommand(args)
  if (result.exitCode !== 0)
    return yield* Effect.fail(new MachineOperationFailed({ operation: args[0] ?? 'docker' }))
  if (result.truncated)
    return yield* Effect.fail(new MachineResponseInvalid({ operation: 'docker' }))
  return result.output
})

/** Names contain only a branded opaque key and cannot become CLI options or mount syntax. */
const containerName = (key: MachineKey) => `vivid-computer-${key}`
const volumeName = (key: MachineKey) => `vivid-computer-home-${key}`

/** Stop the exact Computer after a lost executor or startup; killing a Docker client alone is insufficient. */
const stopContainer = Effect.fn('Machine.docker.shutdown')(function* (key: MachineKey) {
  yield* checked(['container', 'stop', '--time', '15', containerName(key)])
  const stopped = yield* inspect(key)
  if (Option.isSome(stopped) && stopped.value.State.ExitCode !== 0) {
    yield* Effect.fail(new MachineOperationFailed({ operation: 'shutdown' }))
  }
})

/** Distinguish absence using a successful exact-name listing, never by swallowing daemon failures. */
const inspect = Effect.fn('Machine.docker.inspect')(function* (key: MachineKey) {
  const found = yield* checked([
    'container',
    'ls',
    '--all',
    '--filter',
    `name=^/${containerName(key)}$`,
    '--format',
    '{{.Names}}',
  ])
  if (found.trim() === '') return Option.none()
  const raw = yield* checked(['container', 'inspect', containerName(key)])
  const decoded = yield* decodeInspection(raw).pipe(
    Effect.mapError(() => new MachineResponseInvalid({ operation: 'inspect' })),
  )
  const first = decoded[0]
  if (first === undefined)
    return yield* Effect.fail(new MachineResponseInvalid({ operation: 'inspect' }))
  return Option.some(first)
})

/** Docker timestamps are authoritative; malformed dates never become fabricated lifecycle times. */
const timestamp = Effect.fn('Machine.docker.timestamp')(function* (value: string) {
  const since = Date.parse(value)
  if (!Number.isFinite(since))
    return yield* Effect.fail(new MachineResponseInvalid({ operation: 'timestamp' }))
  return since
})

/** Only healthy desktops have an embeddable screen; the loopback URL stays inside the server boundary. */
const runningFacts = Effect.fn('Machine.docker.screen')(function* (
  inspection: typeof Inspection.Type,
) {
  const since = yield* timestamp(inspection.State.StartedAt)
  const ports = inspection.NetworkSettings.Ports['6080/tcp']
  if (ports === undefined || ports === null)
    return yield* Effect.fail(new MachineResponseInvalid({ operation: 'screen' }))
  const port = ports[0]
  if (port === undefined || port.HostIp !== '127.0.0.1')
    return yield* Effect.fail(new MachineResponseInvalid({ operation: 'screen' }))
  return ComputerState.cases.Running.make({
    since,
    screenAddress: `http://127.0.0.1:${port.HostPort}/vnc.html?autoconnect=true&resize=scale`,
  })
})

/** Docker status is observed independently of app-owned Computer records. */
const status = Effect.fn('Machine.docker.status')(function* (key: MachineKey) {
  const inspected = yield* inspect(key)
  if (Option.isNone(inspected)) return ComputerState.cases.Absent.make({})
  const { State: state } = inspected.value
  if (state.Status === 'created')
    return ComputerState.cases.Starting.make({ since: yield* timestamp(inspected.value.Created) })
  if (state.Status !== 'running') {
    const since = yield* timestamp(state.FinishedAt)
    if (state.Error !== '' || state.ExitCode !== 0) {
      return ComputerState.cases.Failed.make({
        since,
        reason: `Computer process exited with code ${state.ExitCode}.`,
      })
    }
    return ComputerState.cases.Stopped.make({ since })
  }
  const since = yield* timestamp(state.StartedAt)
  const ready = yield* dockerCommand(['exec', containerName(key), 'test', '-f', '/tmp/vivid/ready'])
  if (ready.exitCode !== 0) return ComputerState.cases.Starting.make({ since })
  return yield* runningFacts(inspected.value)
})

/** The Computer has no capabilities; a disposable root helper only installs its namespace firewall. */
const start = Effect.fn('Machine.docker.start')(
  function* (key: MachineKey, image: string) {
    yield* checked(['container', 'start', containerName(key)])
    yield* checked([
      'run',
      '--rm',
      '--name',
      `vivid-computer-guard-${key}`,
      '--network',
      `container:${containerName(key)}`,
      '--user',
      '0:0',
      '--read-only',
      '--cap-drop',
      'ALL',
      '--cap-add',
      'NET_ADMIN',
      '--security-opt',
      'no-new-privileges',
      '--tmpfs',
      '/run:rw,nosuid,nodev,noexec,size=1048576',
      '--entrypoint',
      '/opt/vivid/egress',
      image,
    ])
    yield* checked([
      'exec',
      containerName(key),
      '/bin/sh',
      '-c',
      'printf ready > /tmp/vivid/network',
    ])
    yield* checked([
      'exec',
      containerName(key),
      'timeout',
      '--kill-after=2s',
      '60s',
      'node',
      '/opt/vivid/cli.mjs',
    ])
  },
  (effect, key) =>
    Effect.onExit(effect, (exit) => (Exit.isFailure(exit) ? stopContainer(key) : Effect.void)),
)

/**
 * Read-only root and durable home follow the isolation/profile evidence in docs/21-reference-mining.md.
 * A reserved host-port range excludes the installation's database and service ports.
 * Chromium's sandbox is disabled because no-new-privileges forbids its setuid helper; Docker is the boundary.
 */
const create = Effect.fn('Machine.docker.create')(function* (key: MachineKey, image: string) {
  yield* checked(['volume', 'create', '--label', 'vivid.computer=true', volumeName(key)])
  yield* checked([
    'container',
    'create',
    '--pull',
    'never',
    '--name',
    containerName(key),
    '--label',
    'vivid.computer=true',
    '--user',
    '1000:1000',
    '--workdir',
    '/home/vivid',
    '--read-only',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--network',
    'bridge',
    '--dns',
    '1.1.1.1',
    '--dns',
    '8.8.8.8',
    '--ipc',
    'private',
    '--shm-size',
    '256m',
    '--memory',
    '2g',
    '--memory-swap',
    '2g',
    '--cpus',
    '2',
    '--pids-limit',
    '256',
    '--restart',
    'no',
    '--init',
    '--tmpfs',
    '/tmp:rw,nosuid,nodev,noexec,size=268435456,mode=1777',
    '--tmpfs',
    '/run:rw,nosuid,nodev,noexec,size=16777216,mode=1777',
    '--mount',
    `type=volume,source=${volumeName(key)},target=/home/vivid`,
    '--publish',
    '127.0.0.1:61000-65000:6080',
    image,
  ])
})

/** Configured Docker authority is captured once; lifecycle changes serialize to make ensure idempotent. */
export const dockerMachineLayer = (image: string) =>
  Layer.effect(
    Machine,
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner
      const lifecycle = yield* Semaphore.make(1)
      const browser = yield* Semaphore.make(1)

      /** Stop is idempotent and waits for Chromium to flush the durable profile before returning. */
      const stop = Effect.fn('Machine.docker.stop')(
        function* (key: MachineKey) {
          const current = yield* inspect(key)
          if (Option.isSome(current) && current.value.State.Status === 'running') {
            yield* stopContainer(key)
          }
        },
        (effect) => lifecycle.withPermit(effect),
        (effect) => Effect.provideService(effect, ChildProcessSpawner, spawner),
      )

      /** A failed startup is stopped; the persistent home remains available to a later explicit ensure. */
      const ensure = Effect.fn('Machine.docker.ensure')(
        function* (key: MachineKey) {
          const current = yield* inspect(key)
          if (Option.isNone(current)) yield* create(key, image)
          const state = yield* status(key)
          if (ComputerState.guards.Running(state)) return state
          if (Option.isSome(current) && current.value.State.Status === 'running') {
            yield* stopContainer(key)
          }
          yield* start(key, image)
          const ready = yield* inspect(key)
          if (Option.isNone(ready)) return yield* Effect.fail(new MachineNotRunning({ key }))
          return yield* runningFacts(ready.value)
        },
        (effect) => lifecycle.withPermit(effect),
        (effect) => Effect.provideService(effect, ChildProcessSpawner, spawner),
      )

      /** User commands are shell source only inside the unprivileged Computer, with an in-container deadline. */
      const exec = Effect.fn('Machine.docker.exec')(
        function* (input: Parameters<typeof Machine.Service.exec>[0]) {
          if (
            !Number.isInteger(input.timeoutSeconds) ||
            input.timeoutSeconds < 1 ||
            input.timeoutSeconds > 300 ||
            input.command.length === 0 ||
            input.command.length > 8000
          )
            return yield* Effect.fail(new MachineInputInvalid())
          const current = yield* status(input.key)
          if (!ComputerState.guards.Running(current))
            return yield* Effect.fail(new MachineNotRunning({ key: input.key }))
          const result = yield* dockerCommand([
            'exec',
            '--user',
            '1000:1000',
            '--workdir',
            '/home/vivid',
            containerName(input.key),
            'timeout',
            '--signal=TERM',
            '--kill-after=2s',
            `${input.timeoutSeconds}s`,
            '/bin/bash',
            '--noprofile',
            '--norc',
            '-c',
            input.command,
          ]).pipe(
            Effect.onExit((exit) =>
              Exit.isFailure(exit) ? stopContainer(input.key) : Effect.void,
            ),
          )
          if (result.exitCode === 124 || result.exitCode === 137) yield* stopContainer(input.key)
          return result
        },
        (effect) => Effect.provideService(effect, ChildProcessSpawner, spawner),
      )

      /** Browser actions serialize across driver connections so references never race an unrelated step. */
      const browse = Effect.fn('Machine.docker.browse')(
        function* (input: Parameters<typeof Machine.Service.browse>[0]) {
          const args = yield* browserArguments(input.action)
          const current = yield* status(input.key)
          if (!ComputerState.guards.Running(current))
            return yield* Effect.fail(new MachineNotRunning({ key: input.key }))
          const result = yield* dockerCommand([
            'exec',
            '--user',
            '1000:1000',
            '--workdir',
            '/home/vivid',
            containerName(input.key),
            'timeout',
            '--kill-after=2s',
            '45s',
            ...args,
          ])
          return yield* decodeBrowserOutput(result)
        },
        (effect) => browser.withPermit(effect),
        (effect) => Effect.provideService(effect, ChildProcessSpawner, spawner),
      )
      return Machine.of({
        ensure,
        stop,
        status: Effect.fn('Machine.status')(status, (effect) =>
          Effect.provideService(effect, ChildProcessSpawner, spawner),
        ),
        exec,
        browse,
      })
    }),
  ).pipe(Layer.provide(NodeServices.layer))

/** Only an explicit provider enables machine authority; image configuration is required when enabled. */
export const machineLayer = Layer.unwrap(
  Effect.gen(function* () {
    const provider = yield* Config.option(
      Config.schema(Schema.Literal('docker'), 'VIVID_COMPUTER_PROVIDER'),
    )
    if (Option.isNone(provider)) return unavailableMachineLayer
    const image = yield* Config.NonEmptyString('VIVID_COMPUTER_IMAGE')
    return dockerMachineLayer(image)
  }),
)
