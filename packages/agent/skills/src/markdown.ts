import * as NodeFS from 'node:fs'
import { Option, Result, Schema } from 'effect'
import { manifest, type BuiltinRuntimeName } from './manifest.ts'

const RuntimeName = Schema.Literals(manifest.map((entry) => entry.runtimeName))

/** A missing release asset needs a packaging fix rather than a change to the procedure. */
export class SkillFileUnavailable extends Schema.TaggedError<SkillFileUnavailable>()(
  'SkillFileUnavailable',
  { runtimeName: RuntimeName },
  { title: 'Shipped skill file unavailable' },
) {}

/** Unsupported frontmatter fails startup rather than silently changing a shipped procedure. */
export class SkillMarkdownInvalid extends Schema.TaggedError<SkillMarkdownInvalid>()(
  'SkillMarkdownInvalid',
  { runtimeName: RuntimeName },
  { title: 'Shipped skill Markdown invalid' },
) {}

/** The catalogue consumes only routing words and instructions, never provenance metadata. */
const Markdown = Schema.Struct({
  name: Schema.String.check(
    Schema.isPattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u),
    Schema.isMaxLength(64),
  ),
  description: Schema.NonEmptyString.check(Schema.isMaxLength(1024)),
  body: Schema.String,
})
const decode = Schema.decodeUnknownResult(Markdown)

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

/** Parse only the scalar and literal-block grammar used by release files, matching the Pi
 * runtime's frontmatter.ts. General YAML is deliberately unsupported; malformed content is
 * a tagged authoring failure. Keep readMarkdown synchronous for the server's startup catalogue. */
const parseMarkdown = (
  runtimeName: BuiltinRuntimeName,
  source: string,
): Result.Result<typeof Markdown.Type, SkillMarkdownInvalid> => {
  const invalid = () => Result.fail(new SkillMarkdownInvalid({ runtimeName }))
  const match = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)([\s\S]*)$/u.exec(
    source.replace(/^\uFEFF/u, ''),
  )
  if (match === null || match[1] === undefined || match[2] === undefined) return invalid()
  const fields = header(match[1].split(/\r?\n/u))
  if (fields === undefined || fields.get('name') !== runtimeName) return invalid()
  return decode({
    name: fields.get('name'),
    description: fields.get('description'),
    body: match[2].trim(),
  }).pipe(Result.mapError(() => new SkillMarkdownInvalid({ runtimeName })))
}

/** Immutable release assets are read once by the server; filesystem failures stay distinct
 * from malformed procedures, and their host path never enters a failure payload. */
export const readMarkdown = (
  runtimeName: BuiltinRuntimeName,
): Result.Result<typeof Markdown.Type, SkillFileUnavailable | SkillMarkdownInvalid> =>
  Result.try({
    try: () => NodeFS.readFileSync(new URL(`../${runtimeName}/SKILL.md`, import.meta.url), 'utf8'),
    catch: () => new SkillFileUnavailable({ runtimeName }),
  }).pipe(Result.flatMap((source) => parseMarkdown(runtimeName, source)))
