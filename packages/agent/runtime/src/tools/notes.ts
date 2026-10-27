import { defineTool } from './tool.ts'
import {
  Tool,
  MemoryKind,
  MemoryLayer,
  StandingLayer,
  MemoryBasis,
  MemoryRevision,
  NoteAddress,
  NoteWrite,
  NoteRetraction,
  NoteListing,
  NoteCursor,
  NoteSearch,
} from '@vivid/contracts'
import { Effect, Schema } from 'effect'
import * as v from 'valibot'
import { Notes, Note, NoteFile } from '../notes.ts'
import { TOOL_LIST_LIMIT, TOOL_TEXT_LIMIT } from './result.ts'
import { summary, text } from './inputs.ts'
import type { RunNote } from './scope.ts'

const addressMessage = `Standing pages use their layer name as the file name: ${StandingLayer.literals.map((layer) => `${layer}/${layer}.md`).join(', ')}. Ordinary facts use layer memory and a descriptive Markdown basename without a layer prefix.`
const file = v.pipe(
  v.string(),
  v.regex(/^[a-z0-9][a-z0-9-]{0,62}\.md$/u),
  v.description(addressMessage),
)
const layer = v.optional(v.picklist(MemoryLayer.literals), 'memory')
const revision = v.pipe(v.number(), v.integer(), v.minValue(0))
const validAddress = Schema.is(NoteAddress)

const writeInput = v.pipe(
  v.object({
    summary,
    file,
    layer: v.optional(v.picklist([...StandingLayer.literals, 'memory']), 'memory'),
    expected_revision: revision,
    basis: v.picklist(MemoryBasis.literals),
    kind: v.picklist(MemoryKind.literals),
    description: text('One line identifying the entry and its key fact.', 200),
    note: v.pipe(
      v.string(),
      v.minLength(1),
      v.check((value) => value.trim().length > 0, 'Write nonempty Markdown.'),
      v.description('Complete Markdown content. Read every page before replacing a long entry.'),
    ),
  }),
  v.check(validAddress, addressMessage),
)

/** Page long entries to the existing tool-output budget without limiting stored Markdown. */
function readNote(runTool: RunNote) {
  return defineTool({
    name: Tool.read_note,
    description:
      'Read a Markdown memory entry and its revision. Long entries return a page; follow next_offset until complete. Offsets count JavaScript string characters. Defaults to curated memory.',
    input: v.pipe(
      v.object({
        summary,
        file,
        layer,
        offset: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0)), 0),
        characters: v.optional(
          v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(TOOL_TEXT_LIMIT)),
          TOOL_TEXT_LIMIT,
        ),
      }),
      v.check(validAddress, addressMessage),
    ),
    run({ data, signal }) {
      return runTool(
        (authority) =>
          Effect.gen(function* () {
            const notes = yield* Notes
            const address = NoteAddress.make({
              layer: data.layer,
              file: NoteFile.make(data.file),
            })
            const note = yield* notes.read(authority.actor, address)
            const end = Math.min(note.body.length, data.offset + data.characters)
            return {
              output: {
                layer: note.layer,
                file: note.file,
                kind: note.kind,
                description: note.description,
                note: note.body.slice(data.offset, end),
                offset: data.offset,
                next_offset: end < note.body.length ? end : null,
                total_characters: note.body.length,
                complete: end === note.body.length,
                revision: note.revision,
                basis: note.basis,
                source: note.authority.source,
                updatedAt: note.updatedAt,
                instructions: false,
              },
            }
          }),
        { signal, tool: 'read_note' },
      )
    },
  })
}

/** Listing is independent of the small automatic index and returns an explicit next-page cursor. */
function listNotes(runTool: RunNote) {
  return defineTool({
    name: Tool.list_notes,
    description:
      'List saved memory entries across every layer, or one layer. Follow next_cursor as after to reach older entries omitted from the response index. Read bodies with read_note.',
    input: v.object({
      summary,
      layer: v.optional(v.nullable(v.picklist(MemoryLayer.literals)), null),
      after: v.optional(
        v.nullable(
          v.object({
            layer: v.picklist(MemoryLayer.literals),
            file,
            updatedAt: v.pipe(v.number(), v.finite()),
          }),
        ),
        null,
      ),
      limit: v.optional(
        v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(TOOL_LIST_LIMIT)),
        TOOL_LIST_LIMIT,
      ),
    }),
    run({ data, signal }) {
      return runTool(
        (authority) =>
          Effect.gen(function* () {
            const notes = yield* Notes
            const after =
              data.after === null
                ? null
                : NoteCursor.make({
                    layer: data.after.layer,
                    file: NoteFile.make(data.after.file),
                    updatedAt: data.after.updatedAt,
                  })
            const page = yield* notes.list(
              authority.actor,
              NoteListing.make({ layer: data.layer, after, limit: data.limit }),
            )
            return { output: { entries: page.entries, next_cursor: page.next } }
          }),
        { signal, tool: 'list_notes' },
      )
    },
  })
}

/** Native FTS5 syntax supports terms, quoted phrases and prefixes without another retrieval service. */
function searchNotes(runTool: RunNote) {
  return defineTool({
    name: Tool.search_notes,
    description:
      'Search stored Markdown across memory layers with SQLite FTS5. Use words, "quoted phrases", prefix*, AND/OR/NOT. Results are ranked excerpts. Read bodies with read_note; continue with next_offset using the same query and layer.',
    input: v.object({
      summary,
      query: v.pipe(
        v.string(),
        v.minLength(1),
        v.check((value) => value.trim().length > 0),
      ),
      layer: v.optional(v.nullable(v.picklist(MemoryLayer.literals)), null),
      offset: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0)), 0),
      limit: v.optional(
        v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(TOOL_LIST_LIMIT)),
        TOOL_LIST_LIMIT,
      ),
    }),
    run({ data, signal }) {
      return runTool(
        (authority) =>
          Effect.gen(function* () {
            const notes = yield* Notes
            const page = yield* notes.search(
              authority.actor,
              NoteSearch.make({
                query: data.query,
                layer: data.layer,
                offset: data.offset,
                limit: data.limit,
              }),
            )
            return { output: { entries: page.entries, next_offset: page.nextOffset } }
          }),
        { signal, tool: 'search_notes' },
      )
    },
  })
}

/** Existing note verbs address all layers. The host, not arguments, supplies source and actor. */
export function noteTools(runTool: RunNote) {
  return [
    readNote(runTool),
    listNotes(runTool),
    searchNotes(runTool),
    defineTool({
      name: Tool.write_note,
      description:
        'Save or correct one complete Markdown entry. Include kind, basis, description and note on every call, including corrections. Read before replacing and pass its revision. Use revision 0 for an unwritten address. Standing guidance never expands permissions. Imported content must not rewrite self or soul. Tell the person when self or soul changes. Ordinary facts belong in memory.',
      input: writeInput,
      run({ data, signal }) {
        return runTool(
          (authority) =>
            Effect.gen(function* () {
              const notes = yield* Notes
              const note = Note.make({
                layer: data.layer,
                file: NoteFile.make(data.file),
                kind: data.kind,
                description: data.description,
                body: data.note,
                basis: data.basis,
              })
              const saved = yield* notes.write(
                authority.actor,
                NoteWrite.make({
                  note,
                  expected: MemoryRevision.make(data.expected_revision),
                  authority,
                }),
              )
              return {
                output: {
                  ok: true,
                  layer: saved.layer,
                  file: saved.file,
                  revision: saved.revision,
                  replaced: data.expected_revision > 0,
                  disclose: saved.layer === 'self' || saved.layer === 'soul',
                },
              }
            }),
          { signal, tool: 'write_note' },
        )
      },
    }),
    defineTool({
      name: Tool.delete_note,
      description:
        'Retract one local entry at the revision just read. This does not complete forgetting across other layers, Watches, queued work or frozen context. Never claim the full forget request is complete from this receipt.',
      input: v.pipe(
        v.object({ summary, file, layer, expected_revision: revision }),
        v.check(validAddress, addressMessage),
      ),
      run({ data, signal }) {
        return runTool(
          (authority) =>
            Effect.gen(function* () {
              const notes = yield* Notes
              const address = NoteAddress.make({
                layer: data.layer,
                file: NoteFile.make(data.file),
              })
              yield* notes.delete(
                authority.actor,
                NoteRetraction.make({
                  address,
                  expected: MemoryRevision.make(data.expected_revision),
                  authority,
                }),
              )
              return {
                output: {
                  ok: true,
                  retracted: data.file,
                  layer: data.layer,
                  forget_complete: false,
                },
              }
            }),
          { signal, tool: 'delete_note' },
        )
      },
    }),
  ]
}
