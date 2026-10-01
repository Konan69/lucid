import { defineTool } from '@flue/runtime'
import { ConnectionId, InvalidRequest, ServiceId } from '@vivid/contracts'
import * as Effect from 'effect/Effect'
import type * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import * as v from 'valibot'
import { asActing, type Acting } from '../client.ts'
import { summary, text } from './inputs.ts'
import { toolOutcome } from './outcomes.ts'
import { settle } from './result.ts'

const decodeInput = Schema.decodeUnknownEffect(Schema.Json)

/** Discovery is always Person-scoped and provider effects remain behind the server's policy. */
export function connectionTools(acting: Option.Option<Acting>) {
  return [
    defineTool({
      name: 'find_tools',
      description:
        'Find connected tools for a concrete request and services that could be connected to help.',
      input: v.object({ query: text('What you need to do or find.', 200) }),
      /** Flue owns input decoding and cancellation; this boundary executes the attributed RPC Effect. */
      run({ data, signal }) {
        return Effect.runPromise(
          settle(
            asActing(acting, (client) =>
              client
                .FindTools({ query: data.query, limit: 25 })
                .pipe(Effect.map((output) => ({ output }))),
            ),
          ),
          { signal },
        )
      },
    }),
    defineTool({
      name: 'use_tool',
      description:
        'Use a tool found by find_tools with its exact account and input schema. If approval is requested, stop and wait.',
      input: v.object({
        connectionId: v.pipe(
          v.string(),
          v.uuid(),
          v.description('The connectionId returned by find_tools.'),
        ),
        tool: text('The exact tool name returned by find_tools.', 200),
        input: v.pipe(v.unknown(), v.description('JSON matching the tool’s input JSON Schema.')),
        summary,
        rationale: v.pipe(
          v.string(),
          v.maxLength(400),
          v.description('Why this action helps the request.'),
        ),
      }),
      /** Flue owns input decoding and cancellation; this boundary executes the attributed RPC Effect. */
      run({ data, signal }) {
        const program = Effect.fn('Tools.useTool')(function* () {
          const input = yield* decodeInput(data.input).pipe(
            Effect.mapError(() => new InvalidRequest({ message: 'Tool input must be JSON.' })),
          )
          return yield* asActing(acting, (client) =>
            client
              .UseTool({
                connectionId: ConnectionId.make(data.connectionId),
                tool: data.tool,
                input,
                summary: data.summary,
                rationale: data.rationale,
              })
              .pipe(Effect.map(toolOutcome)),
          )
        })
        return Effect.runPromise(settle(program()), { signal })
      },
    }),
    defineTool({
      name: 'connect',
      description:
        'Offer the service needed for the current request as a Connect card for the person.',
      input: v.object({
        service: text('The service id returned by find_tools.', 200),
        reason: text('Why this request needs the service.', 400),
      }),
      /** Flue owns input decoding and cancellation; this boundary executes the attributed RPC Effect. */
      run({ data, signal }) {
        return Effect.runPromise(
          settle(
            asActing(acting, (client) =>
              client
                .OfferConnection({ service: ServiceId.make(data.service), reason: data.reason })
                .pipe(Effect.map((output) => ({ output }))),
            ),
          ),
          { signal },
        )
      },
    }),
  ] as const
}
