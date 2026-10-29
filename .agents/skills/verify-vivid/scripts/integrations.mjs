import * as NodeAssert from 'node:assert/strict'
import { Schema } from 'effect'
import {
  ConnectionGrant,
  CoverageReason,
  ResultAsOf,
  ResultCoverage,
  ToolOutcome,
} from '@vivid/contracts'
import { connectPulse } from './watch.mjs'
import { chat, decode, history, json, rpc, settled } from './wire.mjs'

const reading = Schema.Struct({
  ok: Schema.Literal(true),
  output: Schema.Json,
  coverage: ResultCoverage,
  sourceCoverage: ResultCoverage,
  asOf: ResultAsOf,
  observedAt: Schema.Finite,
})

/** Real Connect, Executor dispatch, public RPC and persisted model output prove the shared receipt.
 * Verify Pulse is deliberately unreviewed; neither a complete dataset nor a source time is inferred.
 */
export async function integrations(state, id, directory) {
  const integration = await connectPulse(state, directory)
  try {
    NodeAssert.ok(ConnectionGrant.guards.Granted(integration.connection.grant))
    const found = await rpc(state, 'FindIntegrations', { query: 'Verify Pulse' }, directory)
    const account = found.integrations.find(
      (entry) => entry.account === integration.connection.account,
    )
    NodeAssert.deepEqual(account.grant, integration.connection.grant)
    const result = await rpc(
      state,
      'UseDisplayTool',
      {
        name: 'read@' + integration.connection.account,
        input: {},
        kind: 'Query',
      },
      directory,
      'raw-read',
    )
    NodeAssert.ok(ToolOutcome.guards.Completed(result.outcome))
    NodeAssert.equal(result.outcome.output.records.length, 40)
    NodeAssert.ok(ResultCoverage.guards.Unknown(result.coverage))
    NodeAssert.ok(ResultAsOf.guards.Unknown(result.asOf))
    NodeAssert.ok(Number.isFinite(result.observedAt))
    await chat(
      state,
      id,
      'Read the sample records in my Verify Pulse Integration directly, without a program or display. Tell me how many records you actually received and whether you have the whole result. Do not infer unseen records.',
      directory,
    )
    await settled(state, id, 1, 'Completed', directory)
    const page = await history(state, id, directory, 'settled-history')
    const calls = page.messages
      .flatMap((message) => message.parts)
      .filter(
        (part) =>
          part.type === 'dynamic-tool' &&
          part.toolName === 'use_tool' &&
          part.state === 'output-available',
      )
    NodeAssert.ok(calls.length > 0, 'The real model did not call the Integration directly')
    const delivered = decode(reading, calls[0].output)
    NodeAssert.ok(ResultCoverage.guards.Partial(delivered.coverage))
    NodeAssert.ok(delivered.coverage.reasons.some(CoverageReason.guards.OutputClipped))
    NodeAssert.ok(ResultCoverage.guards.Unknown(delivered.sourceCoverage))
    NodeAssert.ok(ResultAsOf.guards.Unknown(delivered.asOf))
    NodeAssert.equal(delivered.output.records.length, 25)
    await json(directory + '/coverage.json', { raw: result, delivered })
    await json(directory + '/scope.json', {
      proved: [
        'Real key Connection grant',
        'Account discovery grant',
        'Unknown provider coverage and source time',
        'Model output clipping retains source coverage',
      ],
      blocked: [
        'Google partial consent, revocation, pagination and class controls need disposable Google authority',
        'Grant and coverage presentation needs the Claude UI unit',
        'Phone and desktop native journeys need their own clients',
      ],
    })
  } finally {
    await rpc(state, 'RemoveConnection', { id: integration.connection.id }, directory, 'removed')
  }
}
