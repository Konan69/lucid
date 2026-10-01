import { defineTool } from '@flue/runtime'
import { LibraryFolderId, LibrarySearchRequest } from '@vivid/contracts'
import * as Effect from 'effect/Effect'
import type * as Option from 'effect/Option'
import type * as Schema from 'effect/Schema'
import * as v from 'valibot'
import { asActing, type Acting } from '../client.ts'
import { id, text } from './inputs.ts'
import { settle } from './result.ts'

/** Search remains read-only, server-scoped, and preserves supplied source citations. */
export function libraryTools(acting: Option.Option<Acting>) {
  return [
    defineTool({
      name: 'search_library',
      description:
        'Search the person’s Library before answering questions that depend on uploaded documents and cite the returned passages. Pass a supplied folder id unchanged to search that folder and its descendants.',
      input: v.object({
        query: v.pipe(text('The question or passage to search for.', 500), v.minLength(2)),
        limit: v.optional(
          v.pipe(
            v.number(),
            v.integer(),
            v.minValue(1),
            v.maxValue(10),
            v.description('Maximum passages to return.'),
          ),
          6,
        ),
        folderId: v.optional(id),
      }),
      /** Flue owns input decoding and cancellation; this boundary executes the attributed RPC Effect. */
      run({ data, signal }) {
        const request: Schema.Struct.Mutable<typeof LibrarySearchRequest.Type> = {
          query: data.query,
          limit: data.limit,
        }
        if (data.folderId !== undefined) request.folderId = LibraryFolderId.make(data.folderId)
        return Effect.runPromise(
          settle(
            asActing(acting, (client) =>
              client.SearchLibrary(LibrarySearchRequest.make(request)).pipe(
                Effect.map((response) => ({
                  output: {
                    query: data.query,
                    results: response.results.map((result) => ({
                      ...result,
                      citation:
                        result.page === null
                          ? `[${result.filename}]`
                          : `[${result.filename}, p.${result.page}]`,
                    })),
                  },
                })),
              ),
            ),
          ),
          { signal },
        )
      },
    }),
  ] as const
}
