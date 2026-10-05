import * as Config from 'effect/Config'
import * as Effect from 'effect/Effect'

/**
 * Where the SQLite files are kept. Notes are Vivid's own memory and part of every Vivid, so
 * `VIVID_MEMORY_DIR` is required: a runtime without it does not start, and the failure names the
 * variable. There is no runtime that runs "without notes". Before, an unset directory silently
 * mounted no note tools and gave the model other instructions, while Vivid went on telling every
 * Person that it remembers.
 *
 * A directory that cannot be read or written later is a different thing, an infrastructure
 * failure: it is a typed failure on the note call that met it (`NotesUnavailable` in `notes.ts`),
 * told to the model for that response, and over as soon as the directory answers again.
 *
 * It is read here and not in `notes.ts` so that a note's schema or a tool's definition can be
 * imported, by a test or by the server's catalogue of built-in skills, without the runtime's
 * settings: only the agent and its context, which are the runtime, need the directory.
 */
// Flue renders an agent synchronously and the note tools are mounted in that render, so the
// setting is read synchronously here, once, when the module loads. A missing value throws here,
// which stops the runtime process before it serves anything.
// oxlint-disable-next-line vivid/no-runpromise-in-library
export const notesDirectory = Effect.runSync(Config.NonEmptyString('VIVID_MEMORY_DIR'))
