import { defineTool } from '@flue/runtime'
import { LibrarySearchRequest } from '@vivid/contracts'
import { Effect, Option } from 'effect'
import * as v from 'valibot'
import { summary, text } from './inputs.ts'
import { Scope, type RunTool } from './scope.ts'
import * as views from './views.ts'

/** Search is read-only; folder authority comes exclusively from the server delivery. */
export function libraryTools(runTool: RunTool) {
  return [
    defineTool({
      name: 'search_library',
      description: 'Search the Library before answering from documents and cite returned passages.',
      input: v.object({
        summary,
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
      }),
      /** Folder absence means ordinary Library search, never a model-selected folder. */
      run({ data, signal }) {
        return runTool(
          Effect.gen(function* () {
            const scope = yield* Scope
            const request = searchRequest(data, scope.folder)
            const response = yield* scope.client.SearchLibrary(request)
            return { output: { results: views.passages(response.results) } }
          }),
          { signal, tool: 'search_library' },
        )
      },
    }),
  ] as const
}

/** Both request variants preserve genuine absence and are constructed against the wire contract. */
export function searchRequest(
  data: { query: string; limit: number },
  folder: Scope['Service']['folder'],
) {
  return Option.match(folder, {
    onNone: () => LibrarySearchRequest.make({ query: data.query, limit: data.limit }),
    onSome: (folderId) =>
      LibrarySearchRequest.make({ query: data.query, limit: data.limit, folderId }),
  })
}
