import { describe, expect, it } from '@effect/vitest'
import { Result } from 'effect'
import { parseMarkdown, readMarkdown, SkillMarkdownInvalid } from './markdown.ts'

/** Exercise Flue's actual frontmatter grammar, including formats the removed regex rejected. */
describe('shipped Markdown adapter', () => {
  it('accepts plain YAML, absent metadata, multiline descriptions and CRLF', () => {
    for (const source of [
      '---\nname: deep-research\ndescription: Check evidence\n---\n\nRead primary sources.',
      '---\r\nname: deep-research\r\ndescription: |-\r\n  Check evidence\r\n  across sources.\r\n---\r\n\r\nRead primary sources.',
    ]) {
      const parsed = Result.getOrThrow(parseMarkdown('deep-research', source))
      expect(parsed.name).toBe('deep-research')
      expect(parsed.description).toContain('Check evidence')
      expect(parsed.body).toBe('Read primary sources.')
    }
  })

  it('returns a precise tagged error for malformed YAML and a folder/name mismatch', () => {
    for (const source of [
      '---\nname: [\n---\nBad frontmatter.',
      '---\nname: wrong-name\ndescription: Check evidence\n---\nRead sources.',
    ]) {
      const result = parseMarkdown('deep-research', source)
      expect(Result.isFailure(result)).toBe(true)
      if (Result.isFailure(result)) {
        expect(result.failure).toBeInstanceOf(SkillMarkdownInvalid)
        expect(result.failure.runtimeName).toBe('deep-research')
      }
    }
  })

  it('loads the real package asset and exposes only Flue-validated content', () => {
    const parsed = Result.getOrThrow(readMarkdown('deep-research'))
    expect(parsed.name).toBe('deep-research')
    expect(parsed.description.trim().length).toBeGreaterThan(0)
    expect(parsed.body.trim().length).toBeGreaterThan(0)
  })
})
