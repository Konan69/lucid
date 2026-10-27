import { defineTool } from './tool.ts'
import { Tool, LibrarySearchRequest } from '@vivid/contracts'
import { Effect } from 'effect'
import * as v from 'valibot'
import { summary, text } from './inputs.ts'
import { Scope, type RunTool } from './scope.ts'
import * as views from './views.ts'

/** Search is read-only and uses the acting Person’s Library access. */
export function libraryTools(runTool: RunTool) {
  return [
    defineTool({
      name: Tool.search_library,
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
      run({ data, signal }) {
        return runTool(
          Effect.gen(function* () {
            const scope = yield* Scope
            const request = LibrarySearchRequest.make({ query: data.query, limit: data.limit })
            const response = yield* scope.client.SearchLibrary(request)
            return { output: { results: views.passages(response.results) } }
          }),
          { signal, tool: 'search_library' },
        )
      },
    }),
  ] as const
}
