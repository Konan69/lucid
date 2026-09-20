import { defineTool } from '@flue/runtime'
import * as Effect from 'effect/Effect'
import * as v from 'valibot'
import { VividRpcClient } from '@vivid/client-runtime'
import { LibraryFolderId } from '@vivid/contracts'
import { runServerRpc } from '../client.ts'

export const searchLibraryTool = defineTool({
  name: 'search_library',
  description:
    "Search the user's uploaded Library documents for relevant passages. Use this before answering questions that may depend on those documents. When trusted routine instructions supply a folder id, pass it unchanged to scope retrieval to that folder and its descendants. Returns read-only excerpts with filename and page citations; cite the supplied sources in the answer.",
  input: v.object({
    query: v.pipe(v.string(), v.minLength(2), v.maxLength(500)),
    limit: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(10))),
    folderId: v.optional(v.pipe(v.string(), v.uuid())),
  }),
  async run({ data }) {
    const response = await runServerRpc(
      Effect.gen(function* () {
        const client = yield* VividRpcClient
        return yield* client.SearchLibrary({
          query: data.query,
          limit: data.limit ?? 6,
          ...(data.folderId === undefined ? {} : { folderId: LibraryFolderId.make(data.folderId) }),
        })
      }),
    )
    const results = response.results.map((result) => ({
      ...result,
      citation:
        result.page === null ? `[${result.filename}]` : `[${result.filename}, p.${result.page}]`,
    }))
    return { output: { query: data.query, results } }
  },
})
