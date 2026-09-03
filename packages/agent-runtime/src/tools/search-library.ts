import { defineTool } from "@flue/runtime";
import * as v from "valibot";
import { searchLibrary } from "../library-store.ts";

export const searchLibraryTool = defineTool({
  name: "search_library",
  description: "Search the user's uploaded Library documents for relevant passages. Use this before answering questions that may depend on those documents. Returns read-only excerpts with filename and page citations; cite the supplied sources in the answer.",
  input: v.object({
    query: v.pipe(v.string(), v.minLength(2), v.maxLength(500)),
    limit: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(10))),
  }),
  async run({ data }) {
    const results = searchLibrary(data.query, data.limit ?? 6).map((result) => ({
      documentId: result.documentId,
      filename: result.filename,
      page: result.page,
      text: result.text,
      score: result.score,
      citation: result.page ? `[${result.filename}, p.${result.page}]` : `[${result.filename}]`,
    }));
    return { output: { query: data.query, results } };
  },
});
