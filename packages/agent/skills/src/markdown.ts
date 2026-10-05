import * as NodeFS from 'node:fs'
import { parseSkillMarkdown } from '@flue/runtime/internal'
import { Result, Schema } from 'effect'
import { manifest, type BuiltinRuntimeName } from './manifest.ts'

const RuntimeName = Schema.Literals(manifest.map((entry) => entry.runtimeName))

/** A missing release asset is different from an invalid procedure and needs a packaging fix. */
export class SkillFileUnavailable extends Schema.TaggedError<SkillFileUnavailable>()(
  'SkillFileUnavailable',
  { runtimeName: RuntimeName },
  { title: 'Shipped skill file unavailable' },
) {}

/** Invalid frontmatter is a release authoring failure, never an empty or invented procedure. */
export class SkillMarkdownInvalid extends Schema.TaggedError<SkillMarkdownInvalid>()(
  'SkillMarkdownInvalid',
  { runtimeName: RuntimeName },
  { title: 'Shipped skill Markdown invalid' },
) {}

/** Reuse Flue 2.2.2's exported parseSkillMarkdown (result-BWvTzP0z.mjs) and validated output.
 * Its result interface is private, so declarations name the exported function's ReturnType
 * instead of trying to import that interface. This preserves the exact upstream result.
 * The root API has no parser export; this narrow adapter uses its pinned /internal export until
 * a public replacement exists. It owns no second YAML grammar and never re-decodes trusted output. */
export const parseMarkdown = (
  runtimeName: BuiltinRuntimeName,
  source: string,
): Result.Result<ReturnType<typeof parseSkillMarkdown>, SkillMarkdownInvalid> =>
  Result.try({
    try: () =>
      parseSkillMarkdown(source, { directoryName: runtimeName, path: `${runtimeName}/SKILL.md` }),
    catch: () => new SkillMarkdownInvalid({ runtimeName }),
  })

/** The synchronous server catalogue reads immutable release files only at startup. Return tagged
 * failures to its startup boundary; runtime native imports do not read the host filesystem. */
export const readMarkdown = (
  runtimeName: BuiltinRuntimeName,
): Result.Result<
  ReturnType<typeof parseSkillMarkdown>,
  SkillFileUnavailable | SkillMarkdownInvalid
> =>
  Result.try({
    try: () => NodeFS.readFileSync(new URL(`../${runtimeName}/SKILL.md`, import.meta.url), 'utf8'),
    catch: () => new SkillFileUnavailable({ runtimeName }),
  }).pipe(Result.flatMap((source) => parseMarkdown(runtimeName, source)))
