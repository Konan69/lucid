import { defineTool } from '@flue/runtime'
import { InvalidRequest } from '@vivid/contracts'
import { Effect, Schema } from 'effect'
import * as v from 'valibot'
import { summary, text } from './inputs.ts'
import { catalog, named } from './names.ts'
import { toolOutcome } from './outcomes.ts'
import { Scope, type RunTool } from './scope.ts'
import * as views from './views.ts'

const decodeInput = Schema.decodeUnknownEffect(Schema.Json)

/** Discovery and execution recheck access through the same attributed RPC client. */
export function connectionTools(runTool: RunTool) {
  return [
    defineTool({
      name: 'find_tools',
      description:
        'Find connected tools for a concrete request and services that could be connected to help.',
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
          { signal },
        )
      },
    }),
    useTool(runTool),
    defineTool({
      name: 'connect',
      description: 'Offer the service named in find_tools as a Connect card for the person.',
      input: v.object({
        service: text('The service name shown in unconnected by find_tools.', 200),
        reason: text('Why this request needs the service.', 400),
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
            return { output: views.connectionRequest(response) }
          }),
          { signal },
        )
      },
    }),
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
          return toolOutcome(
            yield* client.UseTool({
              connectionId: match.connectionId,
              tool: match.name,
              input,
              summary: data.summary,
              rationale: data.rationale,
            }),
          )
        }),
        { signal },
      )
    },
  })
}
