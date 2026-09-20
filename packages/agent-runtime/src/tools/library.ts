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
    const request =
      data.folderId === undefined
        ? { query: data.query, limit: data.limit ?? 6 }
        : {
            query: data.query,
            limit: data.limit ?? 6,
            folderId: LibraryFolderId.make(data.folderId),
          }
    const response = await Effect.runPromise(
      runServerRpc(
        Effect.gen(function* () {
          const client = yield* VividRpcClient
          return yield* client.SearchLibrary(request)
        }),
      ),
    )
    const results = response.results.map((result) => {
      const citation =
        result.page === null ? `[${result.filename}]` : `[${result.filename}, p.${result.page}]`
      return {
        chunkId: result.chunkId,
        documentId: result.documentId,
        filename: result.filename,
        page: result.page,
        text: result.text,
        score: result.score,
        citation,
      }
    })
    return { output: { query: data.query, results } }
  },
})
