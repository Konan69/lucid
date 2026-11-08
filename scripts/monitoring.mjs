import { Result, Schema } from 'effect'
import * as NodeFSP from 'node:fs/promises'
import * as NodeProcess from 'node:process'

const Detector = Schema.Struct({
  id: Schema.String,
  projectId: Schema.NullOr(Schema.String),
  type: Schema.String,
  name: Schema.String,
})
const Metric = Schema.Struct({
  ...Detector.fields,
  enabled: Schema.Boolean,
  workflowIds: Schema.Array(Schema.String),
  conditionGroup: Schema.Struct({
    conditions: Schema.Array(
      Schema.Struct({
        type: Schema.String,
        comparison: Schema.Finite,
        conditionResult: Schema.Finite,
      }),
    ),
  }),
  dataSources: Schema.Array(
    Schema.Struct({
      queryObj: Schema.Struct({
        snubaQuery: Schema.Struct({
          aggregate: Schema.String,
          query: Schema.String,
          timeWindow: Schema.Finite,
          environment: Schema.String,
        }),
      }),
    }),
  ),
})
const Action = Schema.Struct({
  id: Schema.String,
  type: Schema.Literal('email'),
  integrationId: Schema.NullOr(Schema.String),
  data: Schema.Struct({ fallthroughType: Schema.Literal('ActiveMembers') }),
  config: Schema.Struct({
    targetType: Schema.Literal('issue_owners'),
    targetIdentifier: Schema.NullOr(Schema.String),
  }),
  status: Schema.Literal('active'),
})
const Summary = Schema.Struct({ id: Schema.String, detectorIds: Schema.Array(Schema.String) })
const Workflow = Schema.Struct({
  ...Summary.fields,
  name: Schema.String,
  enabled: Schema.Boolean,
  environment: Schema.NullOr(Schema.String),
  config: Schema.Struct({ frequency: Schema.Finite }),
  actionFilters: Schema.Array(
    Schema.Struct({
      logicType: Schema.String,
      conditions: Schema.Array(Schema.Never),
      actions: Schema.Array(Action),
    }),
  ),
  triggers: Schema.Struct({ conditions: Schema.Array(Schema.Struct({ type: Schema.String })) }),
})

const origin = 'https://us.sentry.io/api/0/organizations/vivid-7t'
const token = NodeProcess.env.SENTRY_AUTH_TOKEN
if (!token) throw new Error('SENTRY_AUTH_TOKEN is required for Sentry alert reconciliation')
const apply = NodeProcess.argv.includes('--apply')
const plans = []

/** Reconcile through Sentry's current regional API; error responses never include credentials. */
async function api(path, schema, method = 'GET', body) {
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
  const request =
    body === undefined
      ? { method: 'GET', headers }
      : { method, headers, body: JSON.stringify(body) }
  const response = await fetch(origin + path, request)
  if (!response.ok) throw new Error(`Sentry ${method} ${path} refused with HTTP ${response.status}`)
  return Result.getOrThrow(
    Schema.decodeUnknownResult(Schema.fromJsonString(schema))(await response.text()),
  )
}

/** Existing issue-owner routing is preserved; no new recipient or notification integration is invented. */
function desired(workflow, project) {
  return {
    name:
      project === '4512198452772864'
        ? 'Vivid backend new or regressed errors'
        : 'Vivid mobile new or regressed errors',
    enabled: true,
    environment: 'production',
    detectorIds: workflow.detectorIds,
    config: { frequency: 60 },
    triggers: {
      logicType: 'any-short',
      conditions: ['first_seen_event', 'regression_event'].map((type) => ({
        type,
        comparison: true,
        conditionResult: true,
      })),
    },
    actionFilters: workflow.actionFilters.map((filter) => ({
      logicType: filter.logicType,
      conditions: filter.conditions,
      actions: filter.actions,
    })),
  }
}

const detectors = await api('/detectors/', Schema.Array(Detector))
const workflows = await api('/workflows/', Schema.Array(Summary))
for (const project of ['4512198452772864', '4512198445760512']) {
  const detector = detectors.find(
    (item) => item.projectId === project && item.type === 'issue_stream',
  )
  if (!detector) throw new Error(`No issue stream detector for project ${project}`)
  const matches = workflows.filter((item) => item.detectorIds.includes(detector.id))
  if (matches.length !== 1)
    throw new Error(`Expected one existing issue alert for project ${project}`)
  const existing = await api(`/workflows/${matches[0].id}/`, Workflow)
  const body = desired(existing, project)
  plans.push({ project, id: existing.id, body })
  if (apply) {
    await api(`/workflows/${existing.id}/`, Workflow, 'PUT', body)
    const actual = await api(`/workflows/${existing.id}/`, Workflow)
    if (
      !actual.enabled ||
      actual.environment !== body.environment ||
      actual.config.frequency !== 60
    )
      throw new Error(`Sentry workflow ${existing.id} did not retain the requested policy`)
    const triggers = actual.triggers.conditions.map((condition) => condition.type)
    if (!triggers.includes('first_seen_event') || !triggers.includes('regression_event'))
      throw new Error(`Sentry workflow ${existing.id} is missing incident triggers`)
  }
}
const result = { mode: apply ? 'applied-and-read-back' : 'plan', workflows: plans }
/** Short reads and writes have a different latency budget from presence, streaming and model work. */
const interactive =
  'rpc.method:[Me,ListThreads,GetThread,GetSettings,GetAppearance,MarkThreadRead,SaveDraft]'
const monitors = [
  {
    project: '4512198452772864',
    name: 'Vivid backend interactive RPC p95',
    source: {
      aggregate: 'p95(span.duration)',
      dataset: 'events_analytics_platform',
      eventTypes: ['trace_item_span'],
      query: interactive,
      timeWindow: 900,
      queryType: 1,
      environment: 'production',
      extrapolationMode: 'unknown',
    },
    threshold: 2000,
  },
  ...['4512198452772864', '4512198445760512'].map((project) => ({
    project,
    name:
      project === '4512198452772864'
        ? 'Vivid backend repeated errors'
        : 'Vivid mobile repeated errors',
    source: {
      aggregate: 'count()',
      dataset: 'events',
      eventTypes: ['error'],
      query: 'level:[error,fatal]',
      timeWindow: 600,
      queryType: 0,
      environment: 'production',
    },
    threshold: 5,
  })),
]
const monitorReceipts = []
for (const monitor of monitors) {
  const workflow = plans.find((plan) => plan.project === monitor.project)
  if (!workflow) throw new Error('No alert routing for monitor ' + monitor.name)
  const existing = detectors.filter(
    (item) => item.projectId === monitor.project && item.name === monitor.name,
  )
  if (existing.length > 1) throw new Error('Duplicate Sentry monitor ' + monitor.name)
  const body = {
    name: monitor.name,
    type: 'metric_issue',
    enabled: true,
    workflowIds: [workflow.id],
    dataSources: [monitor.source],
    config: { detectionType: 'static' },
    conditionGroup: {
      logicType: 'any',
      actions: [],
      conditions: [
        { type: 'gt', comparison: monitor.threshold, conditionResult: 75 },
        { type: 'lte', comparison: monitor.threshold, conditionResult: 0 },
      ],
    },
  }
  let actual
  if (apply) {
    const id = existing.length === 0 ? undefined : existing[0].id
    const path = id === undefined ? `/projects/${monitor.project}/detectors/` : `/detectors/${id}/`
    actual = await api(path, Detector, id === undefined ? 'POST' : 'PUT', body)
    const readback = await api(`/detectors/${actual.id}/`, Metric)
    if (
      readback.name !== body.name ||
      readback.projectId !== monitor.project ||
      !readback.enabled ||
      !readback.workflowIds.includes(workflow.id)
    )
      throw new Error('Sentry monitor readback disagrees with desired routing')
    const source = readback.dataSources[0].queryObj.snubaQuery
    if (
      source.aggregate !== monitor.source.aggregate ||
      source.query !== monitor.source.query ||
      source.timeWindow !== monitor.source.timeWindow ||
      source.environment !== 'production'
    )
      throw new Error('Sentry monitor query or window did not persist')
    const conditions = readback.conditionGroup.conditions
    if (
      !conditions.some(
        (condition) =>
          condition.type === 'gt' &&
          condition.comparison === monitor.threshold &&
          condition.conditionResult === 75,
      ) ||
      !conditions.some(
        (condition) =>
          condition.type === 'lte' &&
          condition.comparison === monitor.threshold &&
          condition.conditionResult === 0,
      )
    )
      throw new Error('Sentry monitor threshold or recovery did not persist')
    actual = readback
  }
  monitorReceipts.push({ project: monitor.project, desired: body, actual })
}
result.monitors = monitorReceipts
if (NodeProcess.env.VIVID_SENTRY_ALERT_RECEIPT)
  await NodeFSP.writeFile(
    NodeProcess.env.VIVID_SENTRY_ALERT_RECEIPT,
    JSON.stringify(result, null, 2) + '\n',
  )
console.log(JSON.stringify(result, null, 2))
