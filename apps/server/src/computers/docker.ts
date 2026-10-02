import * as NodeServices from '@effect/platform-node/NodeServices'
import { CommandResult, ComputerState } from '@vivid/contracts'
import {
  Cache,
  Duration,
  Effect,
  Exit,
  Redacted,
  Layer,
  Option,
  Schema,
  Semaphore,
  Stream,
} from 'effect'
import * as ChildProcess from 'effect/unstable/process/ChildProcess'
import { ChildProcessSpawner } from 'effect/unstable/process/ChildProcessSpawner'
import * as NodeBuffer from 'node:buffer'
import * as NodeCrypto from 'node:crypto'
import { browserArguments, decodeBrowserOutput } from './browser.js'
import {
  Machine,
  computerScreenAddress,
  MachineInputInvalid,
  MachineCapabilityUnavailable,
  MachineExecutionUnknown,
  MachineNotRunning,
  MachineOperationFailed,
  MachineResponseInvalid,
  type MachineKey,
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

/** Output accounting is shared by infrastructure and private stdin executions; receipts never retain unbounded output. */
const receipt = Effect.fn('Machine.docker.receipt')(function* (
  handle: import('effect/unstable/process/ChildProcessSpawner').ChildProcessHandle,
) {
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
})

/** Docker infrastructure uses argv only; no private execution payload is accepted by this entry point. */
export const dockerCommand = Effect.fn('Machine.docker.command')(
  function* (args: ReadonlyArray<string>) {
    const handle = yield* ChildProcess.make('docker', args, {
      stdin: 'ignore',
      forceKillAfter: '2 seconds',
    })
    return yield* receipt(handle)
  },
  Effect.scoped,
  Effect.timeout('330 seconds'),
  Effect.mapError(() => new MachineOperationFailed({ operation: 'docker' })),
)

/** A spawn failure is definite; only transport/deadline failures after spawn lose the execution receipt. */
export const dockerExecution = Effect.fn('Machine.docker.execution')(function* (
  key: MachineKey,
  args: ReadonlyArray<string>,
  input: string,
) {
  const handle = yield* ChildProcess.make('docker', args, {
    stdin: 'pipe',
    forceKillAfter: '2 seconds',
  }).pipe(Effect.mapError(() => new MachineOperationFailed({ operation: 'exec' })))
  const result = yield* Effect.all(
    {
      receipt: receipt(handle),
      input: Stream.run(Stream.make(new TextEncoder().encode(input)), handle.stdin),
    },
    { concurrency: 'unbounded' },
  ).pipe(
    Effect.timeout('330 seconds'),
    Effect.mapError(() => new MachineExecutionUnknown({ key })),
  )
  return result.receipt
}, Effect.scoped)

/** Shell source stays on stdin, absent from both host process arguments and dockerd exec metadata. */
export const commandInvocation = (input: Parameters<typeof Machine.Service.exec>[0]) => ({
  args: [
    'exec',
    '-i',
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
    '-s',
  ],
  input: `${input.command}\n`,
})

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
const networkName = (key: MachineKey) => `vivid-computer-network-${key}`

/** Stop the exact Computer only for explicit stop or failed startup; execution deadlines never destroy the desktop. */
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

/** Published endpoints remain private provider authority; wire Running state contains only the app's WebSocket path. */
const screenEndpoint = Effect.fn('Machine.docker.screen')(function* (
  inspection: typeof Inspection.Type,
) {
  const ports = inspection.NetworkSettings.Ports['6080/tcp']
  if (ports === undefined || ports === null)
    return yield* Effect.fail(new MachineResponseInvalid({ operation: 'screen' }))
  const port = ports[0]
  if (port === undefined || port.HostIp !== '127.0.0.1')
    return yield* Effect.fail(new MachineResponseInvalid({ operation: 'screen' }))
  return `ws://127.0.0.1:${port.HostPort}/websockify`
})

/** A single inspected container supplies lifecycle state; authority hydration shares this observation. */
const inspectedStatus = Effect.fn('Machine.docker.inspectedStatus')(function* (
  key: MachineKey,
  inspection: typeof Inspection.Type,
) {
  const state = inspection.State
  if (state.Status === 'created')
    return ComputerState.cases.Starting.make({ since: yield* timestamp(inspection.Created) })
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
  yield* screenEndpoint(inspection)
  return ComputerState.cases.Running.make({
    since,
    screen: ComputerState.cases.Running.fields.screen.cases.Relay.make({
      address: computerScreenAddress,
    }),
  })
})

/** Docker status is observed independently of app-owned Computer records, without exposing host addresses. */
const status = Effect.fn('Machine.docker.status')(function* (key: MachineKey) {
  const inspected = yield* inspect(key)
  if (Option.isNone(inspected)) return ComputerState.cases.Absent.make({})
  return yield* inspectedStatus(key, inspected.value)
})

/** The Computer has no capabilities; a disposable root helper only installs its namespace firewall. */
const start = Effect.fn('Machine.docker.start')(
  function* (key: MachineKey, image: string, authorization: Redacted.Redacted) {
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
    const bootstrap = yield* dockerExecution(
      key,
      [
        'exec',
        '-i',
        containerName(key),
        'timeout',
        '--kill-after=2s',
        '60s',
        'node',
        '/opt/vivid/cli.mjs',
        'network',
      ],
      Redacted.value(authorization),
    )
    if (bootstrap.exitCode !== 0)
      yield* Effect.fail(new MachineOperationFailed({ operation: 'bootstrap' }))
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
  const networks = yield* checked([
    'network',
    'ls',
    '--filter',
    `name=^${networkName(key)}$`,
    '--format',
    '{{.Name}}',
  ])
  if (networks.trim() === '')
    yield* checked([
      'network',
      'create',
      '--label',
      'vivid.computer=true',
      '--opt',
      'com.docker.network.bridge.enable_icc=false',
      networkName(key),
    ])
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
    networkName(key),
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

/** Warm facts are bounded and successful only; tmpfs authority is rehydrated once after a server restart. */
const authority = Effect.fn('Machine.docker.authority')(function* () {
  const spawner = yield* ChildProcessSpawner
  const lifecycle = yield* Semaphore.make(1)
  const browser = yield* Semaphore.make(1)
  /** Rehydrate tmpfs provider state after a server restart; private authority is never encoded on the wire. */
  const lookup = Effect.fn('Machine.docker.lookup')(function* (key: MachineKey) {
    const inspected = yield* inspect(key)
    if (Option.isNone(inspected)) return yield* Effect.fail(new MachineNotRunning({ key }))
    const facts = yield* inspectedStatus(key, inspected.value)
    if (!ComputerState.guards.Running(facts))
      return yield* Effect.fail(new MachineNotRunning({ key }))
    const raw = yield* checked(['exec', containerName(key), 'cat', '/tmp/vivid/authorization'])
    const authorization = yield* Schema.decodeUnknownEffect(
      Schema.String.check(Schema.isPattern(/^Bearer [a-f0-9]{64}$/)),
    )(raw).pipe(Effect.mapError(() => new MachineResponseInvalid({ operation: 'screen' })))
    return {
      facts,
      address: yield* screenEndpoint(inspected.value),
      authorization: Redacted.make(authorization),
    }
  })
  const running = yield* Cache.makeWith(lookup, {
    capacity: 256,
    timeToLive: (exit) => (Exit.isSuccess(exit) ? Duration.infinity : Duration.zero),
  })
  return { running, lifecycle, browser, spawner }
})
type DockerAuthority = Effect.Success<ReturnType<typeof authority>>

/** Lifecycle serialization protects credential rotation, profile flushing, and cache invalidation. */
const lifecycleOperations = ({ running, lifecycle }: DockerAuthority, image: string) => {
  /** Plain Get still observes Docker; stopped/lost/restarted machines invalidate warm private facts. */
  const observe = Effect.fn('Machine.docker.observe')(
    function* (key: MachineKey) {
      const fresh = yield* status(key)
      const cached = yield* Cache.getSuccess(running, key)
      if (
        !ComputerState.guards.Running(fresh) ||
        (Option.isSome(cached) && cached.value.facts.since !== fresh.since)
      ) {
        yield* Cache.invalidate(running, key)
      }
      return fresh
    },
    (effect, key) => Effect.onError(effect, () => Cache.invalidate(running, key)),
  )
  /** Stop invalidates first, then allows Chromium to flush the durable profile. */
  const stop = Effect.fn('Machine.docker.stop')(
    function* (key: MachineKey) {
      yield* Cache.invalidate(running, key)
      const current = yield* inspect(key)
      if (Option.isSome(current) && current.value.State.Status === 'running')
        yield* stopContainer(key)
    },
    (effect) => lifecycle.withPermit(effect),
  )
  /** The screen credential rotates on each container start and reaches bootstrap exclusively through stdin. */
  const ensure = Effect.fn('Machine.docker.ensure')(
    function* (key: MachineKey) {
      const current = yield* inspect(key)
      if (Option.isNone(current)) yield* create(key, image)
      const state = yield* observe(key)
      if (ComputerState.guards.Running(state)) return (yield* Cache.get(running, key)).facts
      if (Option.isSome(current) && current.value.State.Status === 'running')
        yield* stopContainer(key)
      const authorization = Redacted.make(`Bearer ${NodeCrypto.randomBytes(32).toString('hex')}`)
      yield* start(key, image, authorization)
      const facts = (yield* Cache.get(running, key)).facts
      return facts
    },
    (effect) => lifecycle.withPermit(effect),
  )
  return { ensure, stop, observe }
}

/** Action transport owns stdin and receipts independently of lifecycle and keyboard takeover policy. */
const actionOperations = ({ running, browser }: DockerAuthority) => {
  /** Commands retain a bounded receipt; even timeout exit codes leave the Person's live desktop alone. */
  const exec = Effect.fn('Machine.docker.exec')(function* (
    input: Parameters<typeof Machine.Service.exec>[0],
  ) {
    if (
      !Number.isInteger(input.timeoutSeconds) ||
      input.timeoutSeconds < 1 ||
      input.timeoutSeconds > 300 ||
      input.command.length === 0 ||
      input.command.length > 8000
    )
      return yield* Effect.fail(new MachineInputInvalid())
    yield* Cache.get(running, input.key)
    const invocation = commandInvocation(input)
    const result = yield* dockerExecution(input.key, invocation.args, invocation.input).pipe(
      Effect.onError(() => Cache.invalidate(running, input.key)),
    )
    if (result.exitCode !== 0) yield* Cache.invalidate(running, input.key)
    return result
  })
  /** Browser connections serialize, while private typed text is transported exclusively on stdin. */
  const browse = Effect.fn('Machine.docker.browse')(
    function* (input: Parameters<typeof Machine.Service.browse>[0]) {
      const step = yield* browserArguments(input.action)
      yield* Cache.get(running, input.key)
      const result = yield* dockerExecution(
        input.key,
        [
          'exec',
          '-i',
          '--user',
          '1000:1000',
          '--workdir',
          '/home/vivid',
          containerName(input.key),
          'timeout',
          '--kill-after=2s',
          '45s',
          ...step.args,
        ],
        step.input,
      )
      return yield* decodeBrowserOutput(result)
    },
    (effect, input) => Effect.onError(effect, () => Cache.invalidate(running, input.key)),
    (effect) => browser.withPermit(effect),
  )
  /** Only authenticated server-side proxy code consumes this authority; screenAddress remains credential-free. */
  const screen = Effect.fn('Machine.docker.endpoint')(function* (key: MachineKey) {
    const cached = yield* Cache.get(running, key)
    return { address: cached.address, authorization: cached.authorization }
  })
  return { exec, browse, screen }
}

/** One local provider boundary captures process authority; requests do not reacquire a platform Layer. */
export const dockerMachineLayer = (image: string) =>
  Layer.effect(
    Machine,
    Effect.gen(function* () {
      const state = yield* authority()
      const lifecycle = lifecycleOperations(state, image)
      const actions = actionOperations(state)
      const provide = <A, E>(effect: Effect.Effect<A, E, ChildProcessSpawner>) =>
        Effect.provideService(effect, ChildProcessSpawner, state.spawner)
      return Machine.of({
        ensure: Effect.fn('Machine.ensure')(lifecycle.ensure, provide),
        stop: Effect.fn('Machine.stop')(lifecycle.stop, provide),
        status: Effect.fn('Machine.status')(lifecycle.observe, provide),
        inspect: Effect.fn('Machine.inspect')(lifecycle.observe, provide),
        screen: Effect.fn('Machine.screen')(actions.screen, provide),
        exec: Effect.fn('Machine.exec')(actions.exec, provide),
        browse: Effect.fn('Machine.browse')(actions.browse, provide),
        desktop: Effect.fn('Machine.docker.desktop')(() =>
          Effect.fail(new MachineCapabilityUnavailable({ capability: 'desktop' })),
        ),
      })
    }),
  ).pipe(Layer.provide(NodeServices.layer))
