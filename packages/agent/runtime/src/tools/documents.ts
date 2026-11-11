import { defineTool, type ContentResult } from './tool.ts'
import type { ToolResult } from './result.ts'
import {
  Tool,
  ArtifactMessage,
  type ArtifactReference,
  DocumentToolCallId,
  ReadDocumentOutcome,
  WriteDocumentRequest,
  type WriteDocumentOutcome,
} from '@vivid/contracts'
import { InvalidRequest } from '@vivid/contracts/rpc'
import { Effect, Option, Schema } from 'effect'
import * as v from 'valibot'
import { summary, text } from './inputs.ts'
import { Scope, type RunTool } from './scope.ts'
import { modelText, quiet, refused } from './views.ts'

const decodeDocumentCallId = Schema.decodeUnknownEffect(DocumentToolCallId)

/** No-op writes confirm the saved body without claiming that a new version exists. */
function writeWords(outcome: typeof WriteDocumentOutcome.Type) {
  if (!outcome.changed) return 'The document is unchanged.'
  return outcome.created ? 'Wrote the document.' : 'Revised the document.'
}

/** Confirm a durable document in human words; product references and Run identity never reach the model. */
export function written(outcome: typeof WriteDocumentOutcome.Type) {
  return {
    ok: true,
    title: modelText(outcome.title),
    version: outcome.version,
    created: outcome.created,
    changed: outcome.changed,
    message: writeWords(outcome),
  }
}

/** Product references stay in Pi details; the model keeps the ordinary title/version receipt. */
export function delivered(
  result: { output: Schema.Json; terminate: boolean },
  reference: Option.Option<typeof ArtifactReference.Type>,
): ContentResult | ToolResult {
  return Option.match(reference, {
    onNone: () => result,
    onSome: (artifact) => ({
      content: [{ type: 'text', text: JSON.stringify(result.output) }],
      details: { output: ArtifactMessage.make({ kind: 'artifact', artifact }) },
      terminate: result.terminate,
    }),
  })
}

/** Missing documents offer only the titles in the acting Thread; found documents retain Markdown. */
function read(outcome: ReadDocumentOutcome) {
  return ReadDocumentOutcome.match<Schema.Json>(outcome, {
    Found: ({ title, version, body }) => ({
      ok: true,
      title: modelText(title),
      version,
      body: modelText(body),
      characters: body.length,
    }),
    // Vivid picks the right title from the list itself; the Person has nothing to hear.
    Missing: ({ titles }) => ({
      ...refused('No document has that title in this Thread. Choose from these titles.', quiet),
      titles: titles.map(modelText),
    }),
  })
}

/** Documents are server records, using the same scoped client as every other product tool. */
export function documentTools(runTool: RunTool) {
  return [
    defineTool({
      name: Tool.write_document,
      description:
        'Write a Markdown document the Person will keep, come back to or edit: a report, plan, proposal, meeting notes or long draft. Do not use it for an answer read once. Writing the same title again revises that document; send the whole revised body.',
      input: v.strictObject({
        summary,
        title: text('The document title, unique within this Thread.', 120),
        body: text('The whole document as Markdown.', 200_000),
        note: v.optional(text('One sentence saying what changed.', 200)),
      }),
      /** Pi supplies call identity outside model input, including when deliveries join a response. */
      run({ data, signal, toolCallId }) {
        let reference = Option.none<typeof ArtifactReference.Type>()
        return runTool(
          Effect.gen(function* () {
            const request: Schema.Struct.Mutable<WriteDocumentRequest> = {
              toolCallId: yield* decodeDocumentCallId(toolCallId).pipe(
                Effect.mapError(() => new InvalidRequest({ message: 'Document call is invalid' })),
              ),
              title: data.title,
              body: data.body,
            }
            if (data.note !== undefined) request.note = data.note
            const outcome = yield* (yield* Scope).client.WriteDocument(request)
            reference = Option.some(outcome.artifact)
            return { output: written(outcome) }
          }),
          { signal, tool: 'write_document' },
        ).then((result) => delivered(result, reference))
      },
    }),
    defineTool({
      name: Tool.read_document,
      description:
        'Read a Markdown document of this Thread by title to work on it in a later turn. A missing title returns the titles available here.',
      input: v.strictObject({ summary, title: text('The title of the document to read.', 120) }),
      run({ data, signal }) {
        return runTool(
          Effect.gen(function* () {
            return {
              output: read(yield* (yield* Scope).client.ReadDocument({ title: data.title })),
            }
          }),
          { signal, tool: 'read_document' },
        )
      },
    }),
  ] as const
}

/** Compose durable-writing guidance alongside show's display guidance, without duplicating tool descriptions. */
const instructions =
  'For a Word document, PDF or PNG deliverable, create the file on the Computer, then use inspect_file. Look at its returned preview, fix defects and inspect again, then publish_file with that inspection and a short visual review. The preview of DOCX/PDF shows the first page; check later pages on the Computer before publishing a multi-page file. Keep the editable source with exports. Never claim a file is delivered from a Computer path alone. Use write_document for something the Person will keep, come back to or edit: a report, plan, proposal, meeting notes or long draft. Use Markdown and a clear title. An answer read once belongs in your reply. Writing the same title again revises the document; send its whole revised body and an optional sentence about what changed. Use read_document to read it before working on it in a later turn; if it is Missing, choose one of the returned titles.'
documentTools.instructions = instructions
