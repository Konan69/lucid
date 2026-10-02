import { defineTool } from '@flue/runtime'
import { MemoryKind } from '@vivid/contracts'
import { Effect } from 'effect'
import * as v from 'valibot'
import { forCompany, text } from './inputs.ts'
import { Scope, type RunTool } from './scope.ts'
import * as views from './views.ts'

/** Recall obeys server scope; Company writes always carry the person's explicit intent. */
export function memoryTools(runTool: RunTool) {
  return [
    defineTool({
      name: 'recall',
      description:
        'Look up relevant memories. Confirm current facts through a Connection before acting.',
      input: v.object({ query: text('The person, preference or fact to recall.', 400) }),
      /** Provenance and scope are projected into names rather than raw records. */
      run({ data, signal }) {
        return runTool(
          Effect.gen(function* () {
            const { client } = yield* Scope
            const response = yield* client.Recall({ query: data.query, limit: 25 })
            return { output: views.memories(response.memories) }
          }),
          { signal },
        )
      },
    }),
    defineTool({
      name: 'remember',
      description:
        'Save a fact or preference when asked. Share with the Company only when the person explicitly asks.',
      input: v.object({
        kind: v.pipe(v.picklist(MemoryKind.literals), v.description('The kind of memory.')),
        content: text('A self-contained fact or preference.', 1000),
        forCompany,
      }),
      /** Saving confirms content without exposing a Memory or Person reference. */
      run({ data, signal }) {
        return runTool(
          Effect.gen(function* () {
            const { client } = yield* Scope
            const response = yield* client.Remember(data)
            return { output: views.remembered(response.memory) }
          }),
          { signal },
        )
      },
    }),
  ] as const
}
