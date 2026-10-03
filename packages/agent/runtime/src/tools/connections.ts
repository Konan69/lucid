import { defineTool } from '@flue/runtime'
import {
  AddIntegrationOutcome,
  InvalidRequest,
  TestIntegrationOutcome,
  ToolOutcome,
} from '@vivid/contracts'
import { Effect, Schema } from 'effect'
import * as v from 'valibot'
import { summary, text } from './inputs.ts'
import { catalog, named } from './names.ts'
import { toolOutcome } from './outcomes.ts'
import { Scope, type RunTool } from './scope.ts'
import * as views from './views.ts'
import * as connectionViews from './connectionviews.ts'
import { INTEGRATIONS } from './integrations.ts'
import { warnFailure } from './result.ts'

const decodeInput = Schema.decodeUnknownEffect(Schema.Json)

/** Discovery and execution recheck access through the same attributed RPC client. */
export function connectionTools(runTool: RunTool) {
  return [
    defineTool({
      name: 'find_tools',
      description:
        'Find Integration tools for a concrete request. Returns call expressions and TypeScript signatures, plus Integrations that could be connected to help.',
      input: v.object({ query: text('What you need to do or find.', 200) }),
      /** Account names are assigned by the server before ranking and limiting discovery. */
      run({ data, signal }) {
        return runTool(
          Effect.gen(function* () {
            const { client } = yield* Scope
            return {
              output: views.tools(yield* client.FindTools({ query: data.query, limit: 25 })),
            }
          }),
          { signal, tool: 'find_tools' },
        )
      },
    }),
    useTool(runTool),
    defineTool({
      name: 'connect',
      description:
        'Offer the integration named in find_tools as a secure connect card for the person.',
      input: v.object({
        service: text('The integration name shown in unconnected by find_tools.', 200),
        reason: text('Why this request needs the integration.', 400),
      }),
      /** FindServices is Person-only; runtime authority resolves services through FindTools instead. */
      run({ data, signal }) {
        return runTool(
          Effect.gen(function* () {
            const { client } = yield* Scope
            const found = yield* client.FindTools({ query: data.service, limit: 25 })
            const service = yield* Effect.fromResult(
              named(
                catalog(found.unconnected, (item) => views.modelText(item.name)),
                data.service,
              ),
            )
            const response = yield* client.OfferConnection({
              service: service.id,
              reason: data.reason,
            })
            // A connect card is the answer for this turn. Flue must settle it rather than
            // asking the model to keep discovering the same unavailable account. The card's
            // WatchConnections continuation sends a fresh delivery after authorization.
            return { output: views.connectionRequest(response), terminate: !response.ready }
          }),
          { signal, tool: 'connect' },
        )
      },
    }),
    ...integrationTools(runTool),
  ] as const
}

/** Both account and tool must resolve exactly; model input never carries Connection authority. */
function useTool(runTool: RunTool) {
  return defineTool({
    name: 'use_tool',
    description:
      'Use the exact account and tool names returned by find_tools, following its input schema. If approval is requested, stop and wait.',
    input: v.object({
      account: text('The exact account name returned by find_tools.', 300),
      tool: text('The exact tool name returned by find_tools.', 200),
      input: v.pipe(v.unknown(), v.description('JSON matching the tool’s input JSON Schema.')),
      summary,
      rationale: v.pipe(
        v.string(),
        v.maxLength(400),
        v.description('Why this action helps the request.'),
      ),
    }),
    /** Unknown JSON is decoded at ingress; only a server-resolved pair determines the Connection. */
    run({ data, signal }) {
      return runTool(
        Effect.gen(function* () {
          const { client } = yield* Scope
          const input = yield* decodeInput(data.input).pipe(
            Effect.mapError(() => new InvalidRequest({ message: 'Tool input must be JSON.' })),
          )
          const match = yield* client.ResolveTool({ account: data.account, tool: data.tool })
          const outcome = yield* client.UseTool({
            connectionId: match.connectionId,
            tool: match.name,
            input,
            summary: data.summary,
            rationale: data.rationale,
          })
          if (
            ToolOutcome.isAnyOf(['Blocked', 'ConnectionNotReady', 'Rejected', 'OutcomeUnknown'])(
              outcome,
            )
          )
            yield* warnFailure('use_tool', outcome._tag)
          return toolOutcome(outcome)
        }),
        { signal, tool: 'use_tool' },
      )
    },
  })
}

/** Fixed discovery/import/test tools keep credentials and record handles out of model inputs. */
function integrationTools(runTool: RunTool) {
  return [
    defineTool({
      name: 'find_integrations',
      description:
        'Find your integrations first, then catalogue matches, with connected status and whether this Vivid is set up to connect them.',
      input: v.object({ query: v.pipe(v.string(), v.maxLength(200)) }),
      /** Access is rechecked by the server for the injected acting Person. */
      run({ data, signal }) {
        return runTool(
          Effect.gen(function* () {
            const { client } = yield* Scope
            const response = yield* client.FindIntegrations(data)
            if (response.catalog === 'unavailable')
              yield* warnFailure('find_integrations', 'ServiceUnavailable')
            return { output: connectionViews.integrations(response) }
          }),
          { signal, tool: 'find_integrations' },
        )
      },
    }),
    defineTool({
      name: 'add_integration',
      description:
        'Add an integration from a public MCP server URL, API documentation URL, or OpenAPI specification URL. Sign-in or key entry uses a secure card; stop and wait when needed. Documentation must publish a specification link.',
      input: v.object({
        address: text('Public MCP or OpenAPI specification URL, without credentials.', 4000),
        name: text('A clear name for this integration account.', 40),
      }),
      /** Models cannot choose Company sharing or submit credential fields. */
      run({ data, signal }) {
        return runTool(
          Effect.gen(function* () {
            const { client } = yield* Scope
            const outcome = yield* client.AddIntegration({ ...data, shared: false })
            if (AddIntegrationOutcome.isAnyOf(['NotAnIntegration', 'Unreachable'])(outcome))
              yield* warnFailure('add_integration', outcome._tag)
            return {
              output: connectionViews.added(outcome),
              terminate: AddIntegrationOutcome.isAnyOf(['NeedsSignIn', 'NeedsKey'])(outcome),
            }
          }),
          { signal, tool: 'add_integration' },
        )
      },
    }),
    defineTool({
      name: 'test_integration',
      description:
        'List an integration’s tools and test one read-only call when its input can be safely determined. Report the result in a sentence; stop when approval is needed.',
      input: v.object({
        account: text('The exact account name shown by find_integrations or find_tools.', 300),
      }),
      /** Gate decisions and external dispatch remain server-owned. */
      run({ data, signal }) {
        return runTool(
          Effect.gen(function* () {
            const { client } = yield* Scope
            const outcome = yield* client.TestIntegration(data)
            if (TestIntegrationOutcome.isAnyOf(['NotTested', 'Blocked', 'Unreachable'])(outcome))
              yield* warnFailure('test_integration', outcome._tag)
            return {
              output: connectionViews.tested(outcome),
              terminate: TestIntegrationOutcome.guards.ApprovalRequired(outcome),
            }
          }),
          { signal, tool: 'test_integration' },
        )
      },
    }),
  ] as const
}

/** The instruction owner can use the already-imported factory to compose this lane's paragraph. */
connectionTools.instructions = INTEGRATIONS
