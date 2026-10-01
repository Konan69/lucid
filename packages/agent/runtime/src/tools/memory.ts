import { defineTool } from '@flue/runtime'
import { MemoryKind } from '@vivid/contracts'
import * as Effect from 'effect/Effect'
import type * as Option from 'effect/Option'
import * as v from 'valibot'
import { asActing, type Acting } from '../client.ts'
import { forCompany, text } from './inputs.ts'
import { settle } from './result.ts'

/** Recall obeys server scope; Company writes always carry the person's explicit intent. */
export function memoryTools(acting: Option.Option<Acting>) {
  return [
    defineTool({
      name: 'recall',
      description:
        'Look up what Vivid remembers relevant to this request. Confirm current facts through a Connection before acting.',
      input: v.object({ query: text('The person, preference or fact to recall.', 400) }),
      /** Flue owns input decoding and cancellation; this boundary executes the attributed RPC Effect. */
      run({ data, signal }) {
        return Effect.runPromise(
          settle(
            asActing(acting, (client) =>
              client
                .Recall({ query: data.query, limit: 25 })
                .pipe(Effect.map((output) => ({ output }))),
            ),
          ),
          { signal },
        )
      },
    }),
    defineTool({
      name: 'remember',
      description:
        'Save a fact or preference when the person asks Vivid to remember it. Share with the Company only when they explicitly ask.',
      input: v.object({
        kind: v.pipe(v.picklist(MemoryKind.literals), v.description('The kind of memory.')),
        content: text('A self-contained fact or preference.', 1000),
        forCompany,
      }),
      /** Flue owns input decoding and cancellation; this boundary executes the attributed RPC Effect. */
      run({ data, signal }) {
        return Effect.runPromise(
          settle(
            asActing(acting, (client) =>
              client.Remember(data).pipe(Effect.map((output) => ({ output }))),
            ),
          ),
          { signal },
        )
      },
    }),
  ] as const
}
