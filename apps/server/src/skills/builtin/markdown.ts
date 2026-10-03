import * as NodeFS from 'node:fs'
import { Schema } from 'effect'
import type { BuiltinRuntimeName } from '../../../../../packages/agent/skills/src/manifest.ts'

const Frontmatter = Schema.Struct({
  name: Schema.NonEmptyString,
  description: Schema.NonEmptyString.check(Schema.isMaxLength(1024)),
})
const decodeFrontmatter = Schema.decodeUnknownSync(Frontmatter)

/** Shipped files use a fixed YAML layout: plain name, literal description and metadata block.
 * Extract only the two fields the server needs, then decode at startup; this is not an importer
 * for arbitrary third-party YAML. Literal scalars preserve descriptions and provenance through
 * formatting. Flue 2.2.2 parseSkillMarkdown validates the complete frontmatter and bundles folders;
 * malformed release assets fail startup instead of inventing a second procedure definition. */
export function readMarkdown(name: BuiltinRuntimeName) {
  const file = new URL(`../../../../../packages/agent/skills/${name}/SKILL.md`, import.meta.url)
  const source = NodeFS.readFileSync(file, 'utf8')
  const match =
    /^---\nname: ([a-z0-9-]+)\ndescription: \|-\n  ([^\n]+)\nmetadata:[\s\S]*?\n---\n\n([\s\S]*)$/u.exec(
      source,
    )
  if (match === null || match[3] === undefined)
    throw new Error(`Invalid shipped skill Markdown: ${name}`)
  const frontmatter = decodeFrontmatter({ name: match[1], description: match[2] })
  if (frontmatter.name !== name) throw new Error(`Shipped skill folder/name mismatch: ${name}`)
  return { description: frontmatter.description, instructions: match[3].trim() }
}
