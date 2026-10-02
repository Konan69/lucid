import { defineTool } from '@flue/runtime'
import { Memory, MemoryKind } from '@vivid/contracts'
import { Effect, Result, Schema } from 'effect'
import * as v from 'valibot'
import { forCompany, text } from './inputs.ts'
import { Scope, type RunTool } from './scope.ts'
import * as views from './views.ts'
import { named } from './names.ts'

/** A model supplies words; the authorized Recall result alone supplies the record reference. */
const Target = Schema.TaggedUnion({
  One: { memory: Memory },
  Preview: { memories: Schema.Array(Memory) },
})

/** Recall the largest existing RPC limit so a small display limit cannot manufacture uniqueness.
 * A full statement can identify one exact match among ranked candidates; identical statements
 * remain ambiguous. Never pick the best-ranked hit or apply a broad plural request, even to one
 * hit. Recall's 400-character query limit does not shorten the words used for exact selection. */
const target = Effect.fn('MemoryTools.target')(function* (query: string) {
  const { client } = yield* Scope
  const response = yield* client.Recall({ query: query.slice(0, 400), limit: 100 })
  const exact = named(
    response.memories.map((memory) => ({
      name: views.modelText(memory.content),
      item: memory,
    })),
    query,
  )
  if (Result.isSuccess(exact)) return Target.cases.One.make({ memory: exact.success })
  return Target.cases.Preview.make({ memories: response.memories })
})

/** Forgetting keeps the reference inside the tool and delegates all write authority to Settings' RPC. */
function forgetTool(runTool: RunTool) {
  return defineTool({
    name: 'forget',
    description:
      'Forget one remembered fact the person asks to remove. Several matches are listed first; ask which one and forget nothing until they choose.',
    input: v.object({ what: text('The person’s words for the fact to forget.', 1000) }),
    run({ data, signal }) {
      return runTool(
        Effect.gen(function* () {
          const selected = yield* target(data.what)
          if (Target.guards.Preview(selected))
            return { output: views.memoryChoices(selected.memories) }
          const { client } = yield* Scope
          yield* client.ForgetMemory({ id: selected.memory.id })
          return { output: views.forgotten(selected.memory) }
        }),
        { signal },
      )
    },
  })
}

/** Corrections use the existing versioned write; success is reported only from its receipt. */
function correctTool(runTool: RunTool) {
  return defineTool({
    name: 'correct',
    description:
      'Correct one remembered fact when the person says it is wrong. List several matches and ask which one before changing anything.',
    input: v.object({
      was: text('The person’s words for the remembered fact that is wrong.', 1000),
      now: text('The corrected, self-contained fact.', 1000),
    }),
    run({ data, signal }) {
      return runTool(
        Effect.gen(function* () {
          const selected = yield* target(data.was)
          if (Target.guards.Preview(selected))
            return { output: views.memoryChoices(selected.memories) }
          const { client } = yield* Scope
          const response = yield* client.CorrectMemory({
            id: selected.memory.id,
            content: data.now,
          })
          return { output: views.corrected(selected.memory, response.memory) }
        }),
        { signal },
      )
    },
  })
}

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
    forgetTool(runTool),
    correctTool(runTool),
  ] as const
}
