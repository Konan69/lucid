import { defineTool } from '@flue/runtime'
import {
  ConnectionStep,
  AddIntegrationOutcome,
  InvalidRequest,
  TestIntegrationOutcome,
  ToolOutcome,
} from '@vivid/contracts'
import { Effect, Result, Schema } from 'effect'
import * as v from 'valibot'
import { summary, text } from './inputs.ts'
import { catalog, named } from './names.ts'
import { toolOutcome } from './outcomes.ts'
import { Scope, type RunTool } from './scope.ts'
import * as views from './views.ts'
import * as connectionViews from './connectionviews.ts'
import { INTEGRATIONS } from './integrations.ts'
import { warnFailure } from './result.ts'

/**
 * A tool's arguments are a JSON object. Some models write that object as JSON text instead, and
 * Executor then refuses the call ("input: Expected object") however correct the text is. Text that
 * holds a JSON object or array is read as that value here, at the model's ingress; any other value,
 * including other text, is kept exactly as it was sent.
 */
const ToolInput = Schema.Union([
  Schema.fromJsonString(
    Schema.Union([Schema.Record(Schema.String, Schema.Json), Schema.Array(Schema.Json)]),
  ),
  Schema.Json,
])
export const decodeToolInput = Schema.decodeUnknownEffect(ToolInput)

/** Discovery and execution recheck access through the same attributed RPC client. */
export function connectionTools(runTool: RunTool) {
  return [
    defineTool({
      name: 'find_tools',
      description:
        'Find Integration tools for a concrete request. Returns call expressions and TypeScript signatures, plus Integrations that could be connected to help. The call expression works inside run_code; here, pass the same account and tool to use_tool. withheld counts matching tools on an account whose name cannot be shown; tell the person to rename that Integration if they need it.',
      input: v.object({ summary, query: text('What you need to do or find.', 200) }),
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
        'Offer an integration as a secure connect card for the person. Use it for a service named in unconnected by find_tools. A person can have several accounts on one integration: to ask for one more account on a service they already connected (a second Gmail, their work GitHub), set another to true and say in reason which account you need.',
      input: v.object({
        summary,
        service: text(
          'The integration name: one shown in unconnected by find_tools, or with another set to true, one the person already connected.',
          200,
        ),
        reason: text(
          'Why this request needs the integration, or which other account it needs.',
          400,
        ),
        another: v.optional(
          v.pipe(
            v.boolean(),
            v.description(
              'True to ask for one more account on an integration the person already connected. Leave it out for a service they have not connected.',
            ),
          ),
        ),
      }),
      /**
       * FindServices is Person-only; runtime authority resolves services through FindTools instead.
       *
       * Discovery answers with two lists: services the Person has no account on (`unconnected`),
       * and services they have one on (`connected`). An ordinary offer names one of the first. A
       * request for one more account names one of either: the server answers a service with no
       * account yet as an ordinary offer. A service that is already connected and was not asked
       * for again gets no card, and the model is told how to ask for another account, so it
       * neither shows a card that is already settled nor fails on a name that does exist.
       */
      run({ data, signal }) {
        return runTool(
          Effect.gen(function* () {
            const { client } = yield* Scope
            const found = yield* client.FindTools({ query: data.service, limit: 25 })
            const name = (item: (typeof found.unconnected)[number]) => views.modelText(item.name)
            const another = data.another === true
            if (!another) {
              const held = named(catalog(found.connected, name), data.service)
              if (Result.isSuccess(held)) return { output: views.alreadyConnected(held.success) }
            }
            const service = yield* Effect.fromResult(
              named(
                catalog(
                  another ? [...found.connected, ...found.unconnected] : found.unconnected,
                  name,
                ),
                data.service,
              ),
            )
            const response = yield* client.OfferConnection({
              service: service.id,
              reason: data.reason,
              wanted: another ? 'Another' : 'Service',
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
      'Call one Integration tool that find_tools returned, with JSON input matching its signature. If approval is requested, stop and wait.',
    input: v.object({
      account: text('The exact account name returned by find_tools.', 300),
      tool: text('The exact tool name returned by find_tools.', 200),
      input: v.pipe(v.unknown(), v.description('JSON input matching the tool’s signature.')),
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
          const input = yield* decodeToolInput(data.input).pipe(
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
        'List up to 24 accessible integration accounts: query matches first, then newest first within each group. omittedAccounts counts accessible accounts left out; narrow the query to surface them. Then list up to 24 catalogue matches, with connected status and whether this Vivid is set up to connect them.',
      input: v.object({ summary, query: v.pipe(v.string(), v.maxLength(200)) }),
      /** Access is rechecked by the server for the injected acting Person. */
      run({ data, signal }) {
        return runTool(
          Effect.gen(function* () {
            const { client } = yield* Scope
            const response = yield* client.FindIntegrations({ query: data.query })
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
        summary,
        address: text('Public MCP or OpenAPI specification URL, without credentials.', 4000),
        name: text('A clear name for this integration account.', 40),
      }),
      /** Models cannot choose Company sharing or submit credential fields. */
      run({ data, signal }) {
        return runTool(
          Effect.gen(function* () {
            const { client } = yield* Scope
            const outcome = yield* client.AddIntegration({
              address: data.address,
              name: data.name,
              shared: false,
            })
            if (AddIntegrationOutcome.isAnyOf(['NotAnIntegration', 'Unreachable'])(outcome))
              yield* warnFailure('add_integration', outcome._tag)
            return {
              output: connectionViews.added(outcome),
              // A resumed sign-in shows the same card as a new one, so the Run stops for it too.
              terminate:
                AddIntegrationOutcome.isAnyOf(['NeedsSignIn', 'NeedsKey'])(outcome) ||
                (AddIntegrationOutcome.guards.PendingAuthorization(outcome) &&
                  !ConnectionStep.guards.Done(outcome.step)),
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
        summary,
        account: text('The exact account name shown by find_integrations or find_tools.', 300),
      }),
      /** Gate decisions and external dispatch remain server-owned. */
      run({ data, signal }) {
        return runTool(
          Effect.gen(function* () {
            const { client } = yield* Scope
            const outcome = yield* client.TestIntegration({ account: data.account })
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
