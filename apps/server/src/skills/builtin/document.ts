import { Procedure } from './procedure.ts'

/**
 * Adapted from Muse's shipped procedure, read in full at
 * `artifacts/night/raw/wesbos-muse/repo/opt/hatch/skills/artifacts/document/SKILL.md`.
 * Its Word tooling is not carried over: a Vivid document is the Markdown record kept in the
 * Thread, so the saved body is the editable source and the read-back is the verification.
 */
export const procedure = Procedure.make({
  starter: false,
  name: 'Write a document',
  about:
    'Writes a document you will keep, with real structure, and reads it back before handing it over.',
  useWhen:
    'When the Person wants a report, plan, proposal, notes or long draft they will keep or edit.',
  needs: ['write_document', 'read_document', 'search_library', 'ask_person'],
  connections: [],
  instructions: `Settle what the document is for, who reads it and what it must contain before writing. Use \`search_library\` for supplied material and ask with \`ask_person\` only when a missing fact changes the content. Content comes from what was gathered or supplied; a value you do not have is a stated gap or a question, never an invented figure.

Write it with \`write_document\` under a clear, human-readable title that says what it is; the title is how the Person and later turns find it. Give it real structure: headings for the sections a reader navigates by, real numbered or bulleted lists rather than typed symbols, a table only for things compared on the same attributes, and separate paragraphs rather than line breaks inside one. Follow the outline, headings and wording the Person specified literally.

The saved document is the editable source for every later revision. To change it, read the current version with \`read_document\`, then write the whole revised body under the same title with one sentence about what changed. Never rewrite from memory of an earlier draft, and never start a second title for the same document. If the title is missing, choose from the titles returned rather than guessing.

Before handing it over, read it back with \`read_document\` and check what the Person will actually see: every section present and in order, no heading without a body, no cut-off sentence, no leftover placeholder, note to self or sample text. Fix what you find and read again. Say the document is ready only after a clean read-back, and report its title and what it covers. A document kept in the Thread is Markdown; if the Person needs a Word file, say plainly that this is not that file. Sending or sharing it outside the Thread needs its own Approval.`,
})
