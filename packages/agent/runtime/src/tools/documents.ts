import { defineTool, type DeliveredMessage } from '@flue/runtime'
import { NotFound, ReadDocumentOutcome, type WriteDocumentOutcome } from '@vivid/contracts'
import { Effect, Option, Schema } from 'effect'
import * as v from 'valibot'
import { text } from './inputs.ts'
import { Scope, type RunTool } from './scope.ts'
import { modelText } from './views.ts'

const decodeTurn = Schema.decodeUnknownOption(
  Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThan(0)),
)

/** Confirm a durable document in human words; product references and Run identity never reach the model. */
export function written(outcome: typeof WriteDocumentOutcome.Type) {
  return {
    ok: true,
    title: modelText(outcome.title),
    version: outcome.version,
    created: outcome.created,
    message: outcome.created ? 'Wrote the document.' : 'The document is saved at this version.',
  }
}

/** Missing documents offer only the titles in the acting Thread; found documents retain Markdown. */
export function read(outcome: ReadDocumentOutcome) {
  return ReadDocumentOutcome.match<Schema.Json>(outcome, {
    Found: ({ title, version, body }) => ({
      ok: true,
      title: modelText(title),
      version,
      body: modelText(body),
    }),
    Missing: ({ titles }) => ({
      ok: false,
      titles: titles.map(modelText),
      message: 'No document has that title in this Thread. Choose from these titles.',
    }),
  })
}

/** The render's delivery supplies the turn; absent metadata refuses the write rather than guessing the newest Run. */
const turnOf = (delivery: DeliveredMessage) =>
  delivery.kind === 'signal' && delivery.attributes !== undefined
    ? decodeTurn(delivery.attributes.turn)
    : Option.none<number>()

/** Documents are server records, using the same scoped client as every other product tool. */
export function documentTools(runTool: RunTool, delivery: DeliveredMessage) {
  const turn = turnOf(delivery)
  return [
    defineTool({
      name: 'write_document',
      description:
        'Write a Markdown document the Person will keep, come back to or edit: a report, plan, proposal, meeting notes or long draft. Do not use it for an answer read once. Writing the same title again revises that document; send the whole revised body.',
      input: v.strictObject({
        title: text('The document title, unique within this Thread.', 120),
        body: text('The whole document as Markdown.', 200_000),
        note: v.optional(text('One sentence saying what changed.', 200)),
      }),
      run({ data, signal }) {
        return runTool(
          Effect.gen(function* () {
            if (Option.isNone(turn))
              return yield* Effect.fail(
                new NotFound({ message: 'The document delivery turn is missing' }),
              )
            const outcome = yield* (yield* Scope).client.WriteDocument({
              ...data,
              turn: turn.value,
            })
            return { output: written(outcome) }
          }),
          { signal, tool: 'write_document' },
        )
      },
    }),
    defineTool({
      name: 'read_document',
      description:
        'Read a Markdown document of this Thread by title to work on it in a later turn. A missing title returns the titles available here.',
      input: v.strictObject({ title: text('The title of the document to read.', 120) }),
      run({ data, signal }) {
        return runTool(
          Effect.gen(function* () {
            return { output: read(yield* (yield* Scope).client.ReadDocument(data)) }
          }),
          { signal, tool: 'read_document' },
        )
      },
    }),
  ] as const
}

/** Compose durable-writing guidance alongside show's display guidance, without duplicating tool descriptions. */
export const instructions =
  'Use write_document for something the Person will keep, come back to or edit: a report, plan, proposal, meeting notes or long draft. Use Markdown and a clear title. An answer read once belongs in your reply. Writing the same title again revises the document; send its whole revised body and an optional sentence about what changed. Use read_document to read it before working on it in a later turn; if it is Missing, choose one of the returned titles.'
documentTools.instructions = instructions
