import { defineTool } from './tool.ts'
import { Tool, MemoryKind } from '@vivid/contracts'
import * as Effect from 'effect/Effect'
import * as v from 'valibot'
import { Notes, Note, NoteFile, NOTE_BODY_LIMIT } from '../notes.ts'
import { summary, text } from './inputs.ts'
import type { RunNote } from './scope.ts'

/** The model names a note by its file name; the rule is stated so a refusal explains itself. */
const file = v.pipe(
  v.string(),
  v.regex(/^[a-z0-9][a-z0-9-]{0,62}\.md$/u),
  v.description(
    'The note’s file name: lower-case words joined by hyphens, ending in .md, for example prefers-morning-meetings.md.',
  ),
)

/**
 * The tools Vivid keeps its own memory with: one note per thing it knows, in the acting Person's
 * own filesystem (`notes.ts`). They are file-shaped on purpose, because models are trained on
 * files, and typed where it matters: the tool builds the note's header from `kind` and
 * `description`, so every note is listed in the index and none has a header the index cannot read.
 *
 * There is no edit tool. A note is small, so changing one is reading it and writing it again
 * under the same file name; one fewer tool for a model that already has many.
 *
 * The acting Person comes from the server-prepared scope, never from model input, so a note can
 * only ever be read or written in that Person's own filesystem.
 *
 * Each call carries a `summary` like every other tool: it is the line a Person reads for the step.
 * The note tools had none, so a Person saw "Did something" whenever Vivid read or kept a note, and
 * the registry check that requires it (`tests/routes.ts`) never saw these tools, because the tests
 * ran without notes while production ran with them.
 */
export function noteTools(runTool: RunNote) {
  return [
    defineTool({
      name: Tool.read_note,
      description:
        'Open one of your notes, by its file name from the list of what you remember, to read the whole fact before you use it.',
      input: v.object({ summary, file }),
      run({ data, signal }) {
        return runTool(
          function (person) {
            return Effect.gen(function* () {
              const notes = yield* Notes
              const note = yield* notes.read(person, NoteFile.make(data.file))
              return { output: { kind: note.kind, description: note.description, note: note.body } }
            })
          },
          { signal, tool: 'read_note' },
        )
      },
    }),
    defineTool({
      name: Tool.write_note,
      description:
        'Keep one thing you learned as a note, or change a note you already have by writing it again under the same file name. One note per thing.',
      input: v.object({
        summary,
        file,
        kind: v.pipe(v.picklist(MemoryKind.literals), v.description('What kind of thing this is.')),
        description: text(
          'One line you will see in every later conversation and use to decide whether to open this note. Say what it is about and the key fact.',
          200,
        ),
        note: text(
          'The fact, self-contained. For a preference or a decision add a line starting "Why:" and a line starting "How to apply:".',
          NOTE_BODY_LIMIT,
        ),
      }),
      run({ data, signal }) {
        return runTool(
          function (person) {
            return Effect.gen(function* () {
              const notes = yield* Notes
              const replaced = yield* notes.write(
                person,
                Note.make({
                  file: NoteFile.make(data.file),
                  kind: data.kind,
                  description: data.description,
                  body: data.note,
                }),
              )
              return { output: { ok: true, file: data.file, replaced } }
            })
          },
          { signal, tool: 'write_note' },
        )
      },
    }),
    defineTool({
      name: Tool.delete_note,
      description:
        'Delete one of your notes when the person asks you to forget it, or when it is wrong and nothing in it should be kept.',
      input: v.object({ summary, file }),
      run({ data, signal }) {
        return runTool(
          function (person) {
            return Effect.gen(function* () {
              const notes = yield* Notes
              yield* notes.delete(person, NoteFile.make(data.file))
              return { output: { ok: true, deleted: data.file } }
            })
          },
          { signal, tool: 'delete_note' },
        )
      },
    }),
  ]
}
