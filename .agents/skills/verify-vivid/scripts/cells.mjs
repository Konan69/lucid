import * as NodeFSP from 'node:fs/promises'
import * as NodeEvents from 'node:events'
import { Schema } from 'effect'
import { decodeText, BucketCredentials, NativeState, NativeDeployment } from './receipts.mjs'
import { alive, ownsPort, root, signal, json, terminate } from './process.mjs'

const bucketImage = 'quay.io/minio/minio:RELEASE.2025-04-22T22-12-26Z'

/** All fleet credentials and native SQLite files belong to this run's disposable scratch. */
async function fleetEnvironment(state, cleanEnv) {
  const credentials = decodeText(
    BucketCredentials,
    await NodeFSP.readFile(state.scratch + '/bucket.json', 'utf8'),
  )
  return {
    ...cleanEnv,
    AWS_ACCESS_KEY_ID: credentials.access,
    AWS_SECRET_ACCESS_KEY: credentials.secret,
    AWS_REGION: 'us-east-1',
    AWS_EC2_METADATA_DISABLED: 'true',
    S3_ENDPOINT: `http://127.0.0.1:${state.ports.bucket}`,
  }
}

/** Docker health events prove bucket readiness. The pinned MinIO image includes curl and mc. */
async function bucket(state, services) {
  const { cleanEnv } = services
  const credentials = { access: 'verify-' + crypto.randomUUID(), secret: crypto.randomUUID() }
  await json(state.scratch + '/bucket.json', credentials)
  state.bucketContainer = 'vivid-verify-bucket-' + state.run
  state.bucketSetup = 'vivid-verify-bucket-setup-' + state.run
  await services.save()
  await services.run(
    [
      'docker',
      'run',
      '--detach',
      '--name',
      state.bucketContainer,
      '--label',
      'vivid.verify=' + state.run,
      '-p',
      `127.0.0.1:${state.ports.bucket}:9000`,
      '-e',
      'MINIO_ROOT_USER',
      '-e',
      'MINIO_ROOT_PASSWORD',
      '--health-cmd',
      'curl -fsS http://127.0.0.1:9000/minio/health/ready',
      '--health-interval',
      '1s',
      '--health-timeout',
      '3s',
      '--health-retries',
      '30',
      bucketImage,
      'server',
      '/data',
      '--address',
      ':9000',
    ],
    {
      env: {
        ...cleanEnv,
        MINIO_ROOT_USER: credentials.access,
        MINIO_ROOT_PASSWORD: credentials.secret,
      },
      heavy: true,
      redactions: Object.values(credentials),
      log: state.evidence + '/bucket-start.json',
    },
  )
  const health = await services.run([
    'docker',
    'inspect',
    '--format',
    '{{.State.Health.Status}}',
    state.bucketContainer,
  ])
  if (health !== 'healthy') {
    const events = await services.own('bucket-events', [
      'docker',
      'events',
      '--since',
      state.started,
      '--filter',
      'container=' + state.bucketContainer,
      '--filter',
      'event=health_status',
      '--format',
      '{{.Action}}',
    ])
    try {
      await signal(
        events,
        events.stdout,
        'data',
        (bytes) => bytes.toString().includes('health_status: healthy'),
        60_000,
      )
    } finally {
      const closed = NodeEvents.once(events, 'close')
      events.kill('SIGTERM')
      await closed
    }
  }
  await services.run(
    [
      'docker',
      'run',
      '--rm',
      '--network',
      'host',
      '--name',
      state.bucketSetup,
      '--label',
      'vivid.verify=' + state.run,
      '-e',
      'MC_HOST_verify',
      '--entrypoint',
      'mc',
      bucketImage,
      'mb',
      'verify/vivid',
    ],
    {
      env: {
        ...cleanEnv,
        MC_HOST_verify: `http://${credentials.access}:${credentials.secret}@127.0.0.1:${state.ports.bucket}`,
      },
      heavy: true,
      redactions: Object.values(credentials),
      log: state.evidence + '/bucket-create.json',
    },
  )
}

/** celld reports its serving listeners before public health can establish fleet readiness. */
async function startNode(state, services, node) {
  const env = await fleetEnvironment(state, services.cleanEnv)
  const child = await services.own(
    node.role,
    [
      'celld',
      '--bucket',
      's3://vivid',
      '--listen',
      `127.0.0.1:${node.port}`,
      '--internal-listen',
      `127.0.0.1:${node.operator}`,
      '--advertise',
      `127.0.0.1:${node.operator}`,
    ],
    {
      env: {
        ...env,
        CELLD_WATCH: state.scratch + '/' + node.role,
        CELLD_NODE: state.run + '-' + node.role,
      },
    },
  )
  await signal(child, child, 'output', (bytes) =>
    bytes.toString().includes('celld internal listening on '),
  )
  await signal(child, child, 'output', (bytes) => bytes.toString().includes('ready_gate_open'))
  const response = await fetch(`http://127.0.0.1:${node.port}/.well-known/celld/health`)
  if (!response.ok) throw new Error('Native celld fleet is not ready')
  return child
}

/** Deployment bindings are private config, never argv, process logs, or retained evidence.
 * celld deploy bundles the shipped Worker with its declared Markdown and SQL Text rules. */
export async function startCells(state, services, vars) {
  const version = await services.run(['celld', '--version'], { env: services.cleanEnv })
  if (version !== 'celld 0.6.2') throw new Error('celld 0.6.2 is required')
  await bucket(state, services)
  const source = await NodeFSP.readFile(root + '/apps/cells/wrangler.jsonc', 'utf8')
  const config = source.replace(/^\s*\{/u, '{\n"vars": ' + JSON.stringify(vars) + ',')
  const project = state.scratch + '/cell-project'
  await NodeFSP.mkdir(project)
  await NodeFSP.symlink(root + '/apps/cells/src', project + '/src', 'dir')
  const privateConfig = project + '/wrangler.json'
  await NodeFSP.writeFile(privateConfig, config, { mode: 0o600 })
  const receipt = state.evidence + '/cell-deploy.json'
  await services.run(
    [
      process.execPath,
      root + '/apps/cells/scripts/build.mjs',
      'deploy',
      privateConfig,
      receipt,
      '--bucket',
      's3://vivid',
    ],
    {
      env: await fleetEnvironment(state, services.cleanEnv),
      heavy: true,
      log: state.evidence + '/cell-build.json',
    },
  )
  const deployment = decodeText(NativeDeployment, await NodeFSP.readFile(receipt, 'utf8'))
  state.cells = {
    version,
    deployment: deployment.version,
    nodes: [
      { role: 'runtime', port: state.ports.runtime, operator: state.ports.runtimeOperator },
      {
        role: 'runtime-peer',
        port: state.ports.runtimePeer,
        operator: state.ports.runtimePeerOperator,
      },
    ],
  }
  await services.save()
  for (const node of state.cells.nodes) await startNode(state, services, node)
  await json(state.evidence + '/cells.json', state.cells)
}

/** Operator requests are allowed only on a listener owned by the captured celld generation. */
export async function operator(state, node, path, method = 'GET') {
  if (!(await ownsPort(state.processes[node.role], node.operator)))
    throw new Error('No owned celld operator listener')
  const response = await fetch(`http://127.0.0.1:${node.operator}${path}`, {
    method,
    signal: AbortSignal.timeout(60_000),
  })
  if (!response.ok) throw new Error('celld operator refused ' + path + ': ' + response.status)
  return response
}

/** Read the actual fleet and deployment without credentials or a model call. */
export async function cellSnapshot(state) {
  if (!state.cells) throw new Error('No native celld deployment')
  const nodes = []
  for (const node of state.cells.nodes) {
    const value = decodeText(NativeState, await (await operator(state, node, '/state')).text())
    if (value.deployment.version !== state.cells.deployment)
      throw new Error('celld serves a different deployment')
    nodes.push({ role: node.role, state: value })
  }
  return { version: state.cells.version, deployment: state.cells.deployment, nodes }
}

/** Lifecycle controls exercise native shutdown, handoff and process loss. Their receipt proves
 * the operation only. A journey must separately prove wake, settlement and reconnect behavior. */
export async function cellControl(state, services, input) {
  if (!state.cells) throw new Error('No native celld deployment')
  const node = state.cells.nodes.find((value) => value.role === input.role)
  if (!node) throw new Error('Select runtime or runtime-peer from this run')
  const directory = state.evidence + '/cell-' + crypto.randomUUID()
  await NodeFSP.mkdir(directory)
  await json(directory + '/request.json', input)
  if (input.operation === 'list') {
    const output = await services.run(
      ['celld', 'cell', 'list', 'Person', '--all', '--json', '--bucket', 's3://vivid'],
      { env: await fleetEnvironment(state, services.cleanEnv) },
    )
    await json(directory + '/cells.json', { output })
    return { evidence: directory, output }
  }
  if (input.operation === 'evict') {
    if (!/^Person:[a-f0-9]{64}$/u.test(input.scope))
      throw new Error('Use a Person scope from celld cell list')
    const response = await operator(state, node, '/evict/' + input.scope, 'POST')
    const receipt = decodeText(Schema.Json, await response.text())
    await json(directory + '/receipt.json', receipt)
    return { evidence: directory, receipt }
  }
  if (input.operation === 'state') {
    const value = await cellSnapshot(state)
    await json(directory + '/state.json', value)
    return { evidence: directory, ...value }
  }
  if (input.operation === 'start') {
    if (await alive(state.processes[node.role])) throw new Error('Owned node is already running')
    await startNode(state, services, node)
  } else {
    await stopNode(state, services, node, { operation: input.operation, directory })
  }
  const receipt = {
    operation: input.operation,
    role: node.role,
    process: state.processes[node.role],
    evidence: directory,
  }
  await json(directory + '/receipt.json', receipt)
  return receipt
}

/** A native handoff gets celld's complete shutdown budget before this captured child can restart. */
async function stopNode(state, services, node, { operation, directory }) {
  if (!['stop', 'restart', 'move', 'owner-loss'].includes(operation))
    throw new Error('Expected state, start, stop, restart, move or owner-loss')
  const child = services.children.get(node.role)
  if (!child || !(await alive(state.processes[node.role]))) throw new Error('Owned node is stopped')
  await json(directory + '/before.json', {
    process: state.processes[node.role],
    fleet: await cellSnapshot(state),
  })
  await Promise.all([
    NodeEvents.once(child, 'close', { signal: AbortSignal.timeout(60_000) }),
    operation === 'owner-loss'
      ? terminate(state.processes[node.role], 'SIGKILL')
      : operator(
          state,
          node,
          operation === 'restart' ? '/shutdown?handoff=preserve' : '/shutdown',
          'POST',
        ),
  ])
  if (operation !== 'stop') {
    await startNode(state, services, node)
    await json(directory + '/after.json', await cellSnapshot(state))
  }
}
