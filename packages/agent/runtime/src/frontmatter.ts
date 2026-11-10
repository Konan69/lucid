import { Effect, Option, Schema } from 'effect'

/** One reference file shipped beside a SKILL.md, named by its path relative to the skill's folder
 * (`references/displays.md`), the way the procedure body points at it. */
export const SkillFile = Schema.Struct({
  name: Schema.String.check(Schema.isPattern(/^references\/[a-z0-9]+(?:-[a-z0-9]+)*\.md$/u)),
  body: Schema.NonEmptyString,
})
export interface SkillFile extends Schema.Schema.Type<typeof SkillFile> {}

/** A shipped skill's catalogue name, description, procedure body and reference files. Frontmatter
 * accepts the YAML subset shipped here. Names match their directories, descriptions are nonempty,
 * and unsupported syntax fails startup. Provenance metadata never enters the prompt. */
export const LoadedSkill = Schema.Struct({
  name: Schema.String.check(
    Schema.isPattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u),
    Schema.isMaxLength(64),
  ),
  description: Schema.NonEmptyString.check(Schema.isMaxLength(1024)),
  body: Schema.String,
  files: Schema.Array(SkillFile),
})
export interface LoadedSkill extends Schema.Schema.Type<typeof LoadedSkill> {}
class SkillInvalid extends Schema.TaggedError<SkillInvalid>()(
  'SkillInvalid',
  {
    name: Schema.String,
  },
  { title: 'Invalid shipped skill frontmatter' },
) {}
const decode = Schema.decodeUnknownEffect(LoadedSkill)

/** Literal blocks have exactly the owned indentation. Anything else would silently
 * alter Markdown, so unsupported YAML is refused instead of approximately interpreted. */
function literal(lines: ReadonlyArray<string>, start: number, indent: string) {
  const block: string[] = []
  let last = start
  for (;;) {
    const line = lines[last + 1]
    if (line === undefined || (line !== '' && !line.startsWith(indent))) break
    if (indent.length === 2 && line.startsWith('    ')) return undefined
    block.push(line.slice(indent.length))
    last++
  }
  return { value: block.join('\n').trim(), last }
}

/** Metadata is the shipped provenance mapping, never executable instruction text. */
function field(
  lines: ReadonlyArray<string>,
  index: number,
  key: string,
  value: Option.Option<string>,
) {
  if (key === 'metadata' && Option.isNone(value)) {
    const provenance = lines[index + 1]
    if (provenance !== '  provenance: |-' && provenance !== '  provenance: |') return undefined
    return literal(lines, index + 1, '    ')
  }
  if (Option.isNone(value)) return undefined
  const scalar = value.value
  if (scalar === '|' || scalar === '|-') return literal(lines, index, '  ')
  if (/^["'|>[\]{&*!%@`]/u.test(scalar) || /:\s/u.test(scalar) || /^\s/u.test(scalar))
    return undefined
  return { value: scalar, last: index }
}

/** Own only one-line scalars and literal blocks; duplicates and unsupported YAML fail closed. */
function header(lines: ReadonlyArray<string>) {
  const fields = new Map<string, string>()
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    if (line === undefined || line === '') continue
    const match = /^([a-z][a-z-]*):(?: (.*))?$/u.exec(line)
    if (match === null || match[1] === undefined || fields.has(match[1])) return undefined
    const parsed = field(lines, index, match[1], Option.fromUndefinedOr(match[2]))
    if (parsed === undefined) return undefined
    fields.set(match[1], parsed.value)
    index = parsed.last
  }
  return fields
}

/** Parse authored Markdown at filesystem ingress; a malformed release fails startup, never silently
 * removes a built-in procedure or borrows another skill's name. A body that points at a reference
 * file the release does not ship is malformed too: a bundle that forgot to import one fails here
 * rather than leave the model reading a pointer to nothing. */
export const parseSkill = Effect.fn('Skills.parse')(function* (
  content: string,
  name: string,
  files: ReadonlyArray<SkillFile>,
) {
  const match = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)([\s\S]*)$/u.exec(
    content.replace(/^\uFEFF/u, ''),
  )
  if (match === null || match[1] === undefined || match[2] === undefined)
    return yield* new SkillInvalid({ name })
  const fields = header(match[1].split(/\r?\n/u))
  if (fields === undefined) return yield* new SkillInvalid({ name })
  const parsed = yield* decode({
    name: fields.get('name'),
    description: fields.get('description'),
    body: match[2].trim(),
    files,
  }).pipe(Effect.mapError(() => new SkillInvalid({ name })))
  if (parsed.name !== name) return yield* new SkillInvalid({ name })
  const shipped = new Set(parsed.files.map((file) => file.name))
  for (const [pointer] of parsed.body.matchAll(/references\/[a-z0-9-]+\.md/gu))
    if (!shipped.has(pointer)) return yield* new SkillInvalid({ name })
  return parsed
})
