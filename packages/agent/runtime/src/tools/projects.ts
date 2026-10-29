import { defineTool } from './tool.ts'
import {
  Tool,
  CreateProjectRequest,
  ProjectChange,
  ProjectRevision,
  ProjectToolCallId,
  ProjectWork,
  UpdateProjectRequest,
  type Project,
} from '@vivid/contracts'
import { InvalidRequest } from '@vivid/contracts/rpc'
import { Effect, Match, Result, Schema } from 'effect'
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

/** The visible Project with this exact name; absence or ambiguity stops the call. */
const projectNamed = Effect.fn('ProjectTools.named')(function* (name: string) {
  const { client } = yield* Scope
  const response = yield* client.ListProjects()
  const selected = named(
    response.projects.map((item) => ({ name: item.name, item })),
    name,
  )
  return yield* Result.match(selected, { onFailure: Effect.fail, onSuccess: Effect.succeed })
})

const instant = (at: number) => new Date(at).toISOString()

/**
 * The Project's work in the model's words: no ids. Progress is the whole dated log, newest last,
 * bounded by the shared tool-output limit like any list (`result.ts`).
 */
const workView = (project: Project) =>
  ProjectWork.match<{ readonly [key: string]: Schema.Json }>(project.work, {
    Unspecified: () => ({ state: 'unspecified' }),
    Active: (work) => ({
      state: 'active',
      objective: modelText(work.objective),
      progress: work.progress.map((line) => ({ at: instant(line.at), text: modelText(line.text) })),
      next_step: modelText(work.nextStep),
    }),
    Completed: (work) => ({
      state: 'completed',
      objective: modelText(work.objective),
      progress: work.progress.map((line) => ({ at: instant(line.at), text: modelText(line.text) })),
      completed_at: instant(work.completedAt),
      proof: modelText(work.proof.summary),
    }),
  })

const changeInput = v.variant('kind', [
  v.strictObject({
    kind: v.literal('Define'),
    objective: text('What done means for this Project, in the Person’s terms.', 500),
    next_step: text('The one next step toward it.', 500),
  }),
  v.strictObject({
    kind: v.literal('Progress'),
    text: text('Where the work stands now, as one dated line.', 500),
    next_step: text('The next step after this progress.', 500),
  }),
  v.strictObject({
    kind: v.literal('Complete'),
    proof: text('What shows the objective is met.', 500),
    said: v.pipe(
      v.picklist(['person', 'vivid']),
      v.description(
        'person: the Person said in this conversation that it is done. vivid: you observed it yourself in this reply, with a tool result.',
      ),
    ),
  }),
])

const decodeCallId = Schema.decodeUnknownEffect(ProjectToolCallId)

/** The model's change as the wire change; the runtime adds the call identity for a completion. */
const changeFor = Effect.fn('ProjectTools.change')(function* (
  input: v.InferOutput<typeof changeInput>,
  toolCallId: string,
) {
  return yield* Match.value(input).pipe(
    Match.discriminatorsExhaustive('kind')({
      Define: ({ objective, next_step }) =>
        Effect.succeed(ProjectChange.cases.Define.make({ objective, nextStep: next_step })),
      Progress: ({ text: line, next_step }) =>
        Effect.succeed(ProjectChange.cases.Progress.make({ text: line, nextStep: next_step })),
      Complete: ({ proof, said }) =>
        Effect.map(
          decodeCallId(toolCallId).pipe(
            Effect.mapError(() => new InvalidRequest({ message: 'Project call is invalid' })),
          ),
          (id) => ProjectChange.cases.Complete.make({ summary: proof, toolCallId: id, said }),
        ),
    }),
  )
})

/** Thin model seam over CreateProject: Company/Person authority stays in the attributed RPC
 * client and server. Creating a group does not move Threads or invent project progress. */
export function projectTools(runTool: RunTool) {
  return [
    defineTool({
      name: Tool.create_project,
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
    defineTool({
      name: Tool.read_project,
      description:
        'Read one Project’s objective, dated progress, next step or completion, and its revision. Read it before update_project and pass that revision.',
      input: v.strictObject({ summary, name: text('Exact existing Project name.', 80) }),
      run({ data, signal }) {
        return runTool(
          Effect.gen(function* () {
            const project = yield* projectNamed(data.name)
            return {
              output: {
                name: modelText(project.name),
                revision: project.revision,
                ...workView(project),
              },
            }
          }),
          { signal, tool: 'read_project' },
        )
      },
    }),
    defineTool({
      name: Tool.update_project,
      description:
        'Change a Project’s work at the revision read_project returned. Define sets or corrects what done means and the next step (it also reopens a completed Project). Progress adds a dated line of where it stands and the next step after it. Complete marks it done only when the Person has said so in this conversation (said: person) or you observed it in this reply (said: vivid); it is refused otherwise. Do not guess progress the Person has not told you or you have not seen.',
      input: v.strictObject({
        summary,
        name: text('Exact existing Project name.', 80),
        expected_revision: v.pipe(v.number(), v.integer(), v.minValue(0)),
        change: changeInput,
      }),
      run({ data, signal, toolCallId }) {
        return runTool(
          Effect.gen(function* () {
            const { client } = yield* Scope
            const project = yield* projectNamed(data.name)
            const updated = yield* client.UpdateProject(
              UpdateProjectRequest.make({
                id: project.id,
                expected: ProjectRevision.make(data.expected_revision),
                change: yield* changeFor(data.change, toolCallId),
              }),
            )
            return {
              output: {
                ok: true,
                name: modelText(updated.name),
                revision: updated.revision,
                ...workView(updated),
              },
            }
          }),
          { signal, tool: 'update_project' },
        )
      },
    }),
  ] as const
}
