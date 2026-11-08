import { InvalidRequest, ReviseMadeIntegrationRequest, Tool } from '@vivid/contracts'
import { Effect, Schema } from 'effect'
import * as v from 'valibot'
import { defineTool } from './tool.ts'
import { summary, text } from './inputs.ts'
import { Scope, type RunTool } from './scope.ts'
import { watchView } from './watches.ts'

const account = text('The exact account name returned by find_integrations.', 300)
const decodeRevision = Schema.decodeEffect(ReviseMadeIntegrationRequest)

/** Read saved source and replace complete bodies under the existing Watch or Integration identity. */
export function revisionTools(runTool: RunTool) {
  return [
    defineTool({
      name: Tool.read_integration,
      description:
        'Read the active source of an Integration Vivid made for this Person. Read before revising, preserve unrelated instructions and schedule settings, and read again after revising before promising future runs changed.',
      input: v.object({ summary, name: account }),
      run({ data, signal }) {
        return runTool(
          Effect.gen(function* () {
            const { client } = yield* Scope
            return { output: yield* client.ReadMadeIntegration({ account: data.name }) }
          }),
          { signal, tool: 'read_integration' },
        )
      },
    }),
    defineTool({
      name: Tool.revise,
      description:
        'Revise existing scheduled work in place. Read list_watches or read_integration first. For a Watch, send its complete filters and instruction. For an Integration Vivid made, send its complete revised source files, preserving unrelated instructions, events and schedule settings. Change its time or code without making another Integration or Watch. Read back afterward before saying future runs changed.',
      input: v.object({
        summary,
        name: text('The exact existing Watch or Integration account name.', 300),
        target: v.variant('kind', [
          v.object({
            kind: v.literal('Watch'),
            filters: v.record(v.string(), v.union([v.string(), v.number(), v.boolean()])),
            instruction: text(
              'The complete revised instruction, preserving unrelated instructions.',
              4000,
            ),
          }),
          v.object({
            kind: v.literal('Integration'),
            files: v.pipe(
              v.array(
                v.object({
                  path: text('Relative source file path. Vivid supplies package.json.', 200),
                  content: v.pipe(v.string(), v.maxLength(200_000)),
                }),
              ),
              v.minLength(1),
              v.maxLength(30),
            ),
          }),
        ]),
      }),
      run({ data: { name, target: data }, signal }) {
        return runTool(
          Effect.gen(function* () {
            const { client } = yield* Scope
            if (data.kind === 'Watch') {
              const response = yield* client.ReviseWatch({
                name: name.trim(),
                arguments: data.filters,
                instruction: data.instruction.trim(),
              })
              return { output: watchView(response.watch) }
            }
            const request = yield* decodeRevision({
              account: name,
              files: data.files,
            }).pipe(
              Effect.mapError(
                () => new InvalidRequest({ message: 'Integration source files are invalid.' }),
              ),
            )
            return { output: yield* client.ReviseMadeIntegration(request) }
          }),
          { signal, tool: 'revise' },
        )
      },
    }),
  ] as const
}
