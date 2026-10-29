import {
  ArtifactSourcePath,
  ArtifactInspectionId,
  DocumentToolCallId,
  InvalidRequest,
  Tool,
  type ArtifactReference,
} from '@vivid/contracts'
import { Effect, Option, Schema } from 'effect'
import * as v from 'valibot'
import { delivered, written } from './documents.ts'
import { summary, text } from './inputs.ts'
import { pictureResult } from './picture.ts'
import { Scope, type RunTool } from './scope.ts'
import { defineTool } from './tool.ts'

const decodeCall = Schema.decodeUnknownEffect(DocumentToolCallId)
const decodeInspection = Schema.decodeUnknownEffect(ArtifactInspectionId)

/** Pi supplies tool-call identity. The model sees a preview before it can name the opaque inspection to publish. */
export function artifactTools(runTool: RunTool) {
  return [
    defineTool({
      name: Tool.inspect_file,
      description:
        'Capture a DOCX, PDF or PNG on your Computer and look at its exact bytes before delivery. Returns a PNG preview and an inspection reference for publish_file. DOCX/PDF previews show the first page. For PDF exports retain the editable source. A failed render cannot be published.',
      input: v.strictObject({
        summary,
        path: text('Computer path to the output file.', 4096),
        source: v.variant('kind', [
          v.strictObject({ kind: v.literal('output') }),
          v.strictObject({
            kind: v.literal('separate'),
            path: text('Computer path to its editable source.', 4096),
          }),
        ]),
      }),
      run({ data, signal, toolCallId }) {
        let picture = Option.none<string>()
        return runTool(
          Effect.gen(function* () {
            const call = yield* decodeCall(toolCallId).pipe(
              Effect.mapError(() => new InvalidRequest({ message: 'Inspection call is invalid' })),
            )
            const source =
              data.source.kind === 'output'
                ? ArtifactSourcePath.cases.Output.make({})
                : ArtifactSourcePath.cases.Separate.make({ path: data.source.path })
            const outcome = yield* (yield* Scope).client.InspectArtifactFile({
              toolCallId: call,
              path: data.path,
              source,
            })
            picture = Option.some(Buffer.from(outcome.picture).toString('base64'))
            return {
              output: {
                ok: true,
                inspection: outcome.inspection,
                file: outcome.output,
                message:
                  'Look at this captured preview. Publish this inspection only after checking it. DOCX/PDF preview covers the first page.',
              },
            }
          }),
          { signal, tool: Tool.inspect_file },
        ).then((result) => pictureResult(result, picture))
      },
    }),
    defineTool({
      name: Tool.publish_file,
      description:
        'Deliver the exact file bytes from an inspect_file result after looking at its render. Uses the captured output, source and preview even if Computer paths changed. The same title appends a file version. If you find a defect, fix it and inspect again first.',
      input: v.strictObject({
        summary,
        inspection: text('Inspection reference returned by inspect_file.', 100),
        title: text('File title, unique within this Thread.', 120),
        review: text(
          'What you checked visually and any limitations, including pages not shown in the preview.',
          2000,
        ),
        note: v.optional(text('One sentence about what changed.', 200)),
      }),
      run({ data, signal, toolCallId }) {
        let reference = Option.none<typeof ArtifactReference.Type>()
        return runTool(
          Effect.gen(function* () {
            const request = {
              toolCallId: yield* decodeCall(toolCallId).pipe(
                Effect.mapError(
                  () => new InvalidRequest({ message: 'Publication call is invalid' }),
                ),
              ),
              inspection: yield* decodeInspection(data.inspection).pipe(
                Effect.mapError(
                  () => new InvalidRequest({ message: 'Inspection reference is invalid' }),
                ),
              ),
              title: data.title,
              review: data.review,
            }
            const outcome = yield* (yield* Scope).client.PublishArtifactFile(
              data.note === undefined ? request : { ...request, note: data.note },
            )
            reference = Option.some(outcome.artifact)
            return {
              output: {
                ...written(outcome),
                message: outcome.created ? 'Delivered the file.' : 'Delivered a new file version.',
              },
            }
          }),
          { signal, tool: Tool.publish_file },
        ).then((result) => delivered(result, reference))
      },
    }),
  ] as const
}
