import { defineTool } from '@flue/runtime'
import { CreateProjectRequest } from '@vivid/contracts'
import { Effect, Match, Result } from 'effect'
import * as v from 'valibot'
import { summary, text } from './inputs.ts'
import { named } from './names.ts'
import { modelText } from './views.ts'
import { Scope, type RunTool } from './scope.ts'

const location = v.variant('kind', [
  v.strictObject({ kind: v.literal('TopLevel') }),
  v.strictObject({
    kind: v.literal('Within'),
    project: text('Exact existing parent Project name.', 80),
  }),
])

/** Parent selection uses visible Project names in the acting scope. Ambiguity or absence must
 * stop creation, since choosing another parent would file work under the wrong logical group. */
const requestFor = Effect.fn('ProjectTools.request')(function* (
  name: string,
  placement: v.InferOutput<typeof location>,
) {
  const { client } = yield* Scope
  return yield* Match.value(placement).pipe(
    Match.discriminatorsExhaustive('kind')({
      TopLevel: () => Effect.succeed(CreateProjectRequest.make({ name, parentProjectId: null })),
      Within: ({ project }) =>
        Effect.gen(function* () {
          const response = yield* client.ListProjects()
          const selected = named(
            response.projects.map((item) => ({ name: item.name, item })),
            project,
          )
          const parent = yield* Result.match(selected, {
            onFailure: Effect.fail,
            onSuccess: Effect.succeed,
          })
          return CreateProjectRequest.make({ name, parentProjectId: parent.id })
        }),
    }),
  )
})

/** Thin model seam over CreateProject: Company/Person authority stays in the attributed RPC
 * client and server. Creating a group does not move Threads or invent project progress. */
export function projectTools(runTool: RunTool) {
  return [
    defineTool({
      name: 'create_project',
      description:
        'Create a Project when work clearly forms a logical group with its own ongoing goal. Use a short specific name and choose TopLevel or an exact existing parent Project name. Creates it in the acting Person’s current space; does not move this Thread or assign a status, deadline or next step. Do not create a Project for a one-off question or duplicate an existing group.',
      input: v.strictObject({ summary, name: text('Short specific Project name.', 80), location }),
      /** Return the server-confirmed name and relationship, never ownership or storage identifiers. */
      run({ data, signal }) {
        return runTool(
          Effect.gen(function* () {
            const { client } = yield* Scope
            const project = yield* client.CreateProject(yield* requestFor(data.name, data.location))
            const parent = Match.value(data.location).pipe(
              Match.discriminatorsExhaustive('kind')({
                TopLevel: () => null,
                Within: ({ project: name }) => modelText(name),
              }),
            )
            return {
              output: {
                ok: true,
                name: modelText(project.name),
                parent,
                message: 'Created the Project. Threads have not been moved.',
              },
            }
          }),
          { signal, tool: 'create_project' },
        )
      },
    }),
  ] as const
}
