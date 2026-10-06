import { defineTool } from '@flue/runtime'
import { MemoryKind } from '@vivid/contracts'
import { Effect } from 'effect'
import * as v from 'valibot'
import { summary, forCompany, text } from './inputs.ts'
import { Scope, type RunTool } from './scope.ts'
import * as views from './views.ts'

/**
 * The knowledge base, as Vivid uses it: search and add. Changing or removing what Vivid knows about
 * a Person is done on its notes (`tools/notes.ts`), which every runtime has. A second pair of tools
 * that corrected and forgot knowledge-base facts was mounted only in a runtime without notes, and
 * went when notes became required; the built-in skills that named them name the note tools now. A
 * Person still corrects and removes knowledge-base facts themselves, in Settings.
 */
export function memoryTools(runTool: RunTool) {
  return [
    defineTool({
      name: 'recall',
      description:
        'Look up relevant memories. Confirm current facts through a Connection before acting.',
      input: v.object({ summary, query: text('The person, preference or fact to recall.', 400) }),
      /** Provenance and scope are projected into names rather than raw records. */
      run({ data, signal }) {
        return runTool(
          Effect.gen(function* () {
            const { client } = yield* Scope
            const response = yield* client.Recall({ query: data.query, limit: 25 })
            return { output: views.memories(response.memories) }
          }),
          { signal, tool: 'recall' },
        )
      },
    }),
    defineTool({
      name: 'remember',
      description:
        'Save a fact or preference when asked. Share with the Company only when the person explicitly asks.',
      input: v.object({
        summary,
        kind: v.pipe(v.picklist(MemoryKind.literals), v.description('The kind of memory.')),
        content: text('A self-contained fact or preference.', 1000),
        forCompany,
      }),
      /** Saving confirms content without exposing a Memory or Person reference. */
      run({ data, signal }) {
        return runTool(
          Effect.gen(function* () {
            const { client } = yield* Scope
            const response = yield* client.Remember({
              kind: data.kind,
              content: data.content,
              forCompany: data.forCompany,
            })
            return { output: views.remembered(response.memory) }
          }),
          { signal, tool: 'remember' },
        )
      },
    }),
  ] as const
}
