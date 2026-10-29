import * as NodeFSP from 'node:fs/promises'
import { Schema } from 'effect'
import { Ready, decodeText } from './receipts.mjs'
import * as NodeEvents from 'node:events'
import { signal, json, skill } from './process.mjs'

export const ExecutorApp = Schema.Struct({ id: Schema.String, slug: Schema.String })
export const ExecutorInventory = Schema.Struct({
  apps: Schema.Array(Schema.Struct({ id: Schema.String })),
})
export const ExecutorTools = Schema.Struct({
  version: Schema.String,
  items: Schema.Array(Schema.Struct({ name: Schema.String })),
})
export const ExecutorResult = Schema.Json
const Configuration = Schema.Struct({
  origin: Schema.String,
  organization: Schema.String,
  key: Schema.String,
})
const Setup = Schema.Json
const Organizations = Schema.Array(Schema.Struct({ id: Schema.String }))
const ApiKey = Schema.Struct({ key: Schema.NonEmptyString })

export const image = 'ghcr.io/usefulsoftwareco/executor-selfhost:2.0.0-beta.23'

/** Setup owns a synthetic admin and key. Only scratch retains authority; evidence keeps safe ids. */
async function authority(state) {
  const origin = `http://127.0.0.1:${state.ports.executor}`
  let cookie = ''
  const request = async (schema, path, body) => {
    const response = await fetch(origin + '/api/auth/' + path, {
      method: body ? 'POST' : 'GET',
      headers: { origin, cookie, 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(120_000),
    })
    cookie =
      response.headers
        .getSetCookie()
        .map((value) => value.split(';')[0])
        .join('; ') || cookie
    if (!response.ok)
      throw new Error('Disposable Executor setup refused ' + path + ' ' + response.status)
    return decodeText(schema, await response.text())
  }
  await request(Setup, 'self-host/setup', {
    name: 'Verification owner',
    email: state.run + '@example.test',
    password: crypto.randomUUID() + '!Aa1',
    organizationName: 'Watch verification',
  })
  const organizations = await request(Organizations, 'organization/list')
  if (organizations.length !== 1) throw new Error('Expected one disposable organization')
  const organization = organizations[0].id
  const { key } = await request(ApiKey, 'api-key/create', {
    name: 'Watch journey',
    expiresIn: 7200,
    metadata: { organization },
  })
  if (!key) throw new Error('Executor setup returned no API key')
  await json(state.scratch + '/executor.json', { origin, organization, key })
  await json(state.evidence + '/executor.json', {
    origin,
    organization,
    image,
    callback: state.web,
    catalog: `http://127.0.0.1:${state.ports.catalog}/index.json`,
    transport: 'host network; explicit loopback HTTP policy',
  })
  return {
    VIVID_EXECUTOR_URL: origin,
    VIVID_EXECUTOR_ORGANIZATION: organization,
    VIVID_EXECUTOR_KEY: key,
  }
}

/** Host networking makes the real callback reachable without a public tunnel. Docker's health event
 * is the readiness signal. All created names are journaled before acquisition for crash cleanup. */
export async function executor(state, { run, own, save, cleanEnv }) {
  const inspector = state.scratch + '/inspector'
  await NodeFSP.mkdir(inspector, { recursive: true })
  await json(inspector + '/package.json', {
    private: true,
    type: 'module',
    packageManager: 'pnpm@12.4.2',
    dependencies: { '@electric-sql/pglite': '0.5.8' },
  })
  await run(['pnpm', '--dir', inspector, 'install', '--ignore-workspace', '--ignore-scripts'], {
    env: cleanEnv,
    heavy: true,
    log: state.evidence + '/inspector-install.json',
  })
  state.executorContainer = 'vivid-verify-executor-' + state.run
  await save()
  const catalog = await own(
    'catalog',
    [process.execPath, skill + '/scripts/pulse.mjs', String(state.ports.catalog)],
    {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: { ...cleanEnv, VIVID_VERIFY_WORLD: process.env.VIVID_VERIFY_WORLD },
    },
  )
  await signal(catalog, catalog, 'message', Schema.is(Ready))
  const env = {
    PORT: String(state.ports.executor),
    BETTER_AUTH_URL: `http://127.0.0.1:${state.ports.executor}`,
    EXECUTOR_OAUTH_CALLBACK_URL: state.web + '/api/connections/return',
    EXECUTOR_CATALOG_URL: `http://127.0.0.1:${state.ports.catalog}/index.json`,
    EXECUTOR_URL_ALLOW_LOOPBACK_HTTP: 'true',
    EXECUTOR_APPS_ALLOW_PRIVATE_FETCH: 'false',
    OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'http://127.0.0.1:9/v1/traces',
    OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: 'http://127.0.0.1:9/v1/logs',
    DO_NOT_TRACK: '1',
    EXECUTOR_DISABLE_ANALYTICS: '1',
  }
  await run(
    [
      'docker',
      'run',
      '--detach',
      '--init',
      '--memory',
      '2g',
      '--network',
      'host',
      '--volume',
      '/app/data',
      '--name',
      state.executorContainer,
      '--label',
      'vivid.verify=' + state.run,
      ...Object.keys(env).flatMap((name) => ['--env', name]),
      '--health-cmd',
      'executor-host health',
      '--health-interval',
      '2s',
      '--health-retries',
      '90',
      image,
    ],
    { env: { ...cleanEnv, ...env }, heavy: true, log: state.evidence + '/executor-container.json' },
  )
  const health = await run([
    'docker',
    'inspect',
    '--format',
    '{{.State.Health.Status}}',
    state.executorContainer,
  ])
  if (health !== 'healthy') {
    const events = await own('executor-events', [
      'docker',
      'events',
      '--since',
      state.started,
      '--filter',
      'container=' + state.executorContainer,
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
        240_000,
      )
    } finally {
      const closed = NodeEvents.once(events, 'close')
      events.kill('SIGTERM')
      await closed
    }
  }
  return authority(state)
}

/** No authority enters logs. Direct calls are confined to this run's own Executor origin. */
export async function executorRequest(state, path, { schema, body }) {
  const config = decodeText(
    Configuration,
    await NodeFSP.readFile(state.scratch + '/executor.json', 'utf8'),
  )
  const response = await fetch(
    `${config.origin}/api/organizations/${encodeURIComponent(config.organization)}${path}`,
    {
      method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: 'Bearer ' + config.key, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    },
  )
  if (!response.ok)
    throw new Error('Disposable Executor request failed ' + path + ' ' + response.status)
  return decodeText(schema, await response.text())
}
