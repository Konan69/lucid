import { Effect, Option, Schema } from 'effect'

/**
 * A built-in skill as the runtime uses it: the name and description the catalogue lists, and the
 * procedure body activation returns. Shipped frontmatter is a YAML mapping of one-line scalars
 * and literal block strings; `metadata` is provenance and never enters the prompt.
 *
 * Flue 2.2.2 parsed these files with a YAML library (`parseSkillMarkdown`, `dist/result-*.mjs`):
 * the same frontmatter fence, a `name` of lowercase letters, digits and single hyphens of at most
 * 64 characters that equals the directory, a non-empty `description` of at most 1,024, and the
 * trimmed body. This parser keeps those rules and owns only the YAML the shipped files use, so the
 * runtime carries no YAML dependency; anything else fails startup instead of being approximated.
 */
export const LoadedSkill = Schema.Struct({
  name: Schema.String.check(
    Schema.isPattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u),
    Schema.isMaxLength(64),
  ),
  description: Schema.NonEmptyString.check(Schema.isMaxLength(1024)),
  body: Schema.String,
})
export interface LoadedSkill extends Schema.Schema.Type<typeof LoadedSkill> {}
export class SkillInvalid extends Schema.TaggedError<SkillInvalid>()(
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
 * removes a built-in procedure or borrows another skill's name. */
export const parseSkill = Effect.fn('Skills.parse')(function* (content: string, name: string) {
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
  }).pipe(Effect.mapError(() => new SkillInvalid({ name })))
  if (parsed.name !== name) return yield* new SkillInvalid({ name })
  return parsed
})
