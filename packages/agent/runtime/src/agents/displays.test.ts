import { createParser } from '@openuidev/lang-core'
import { describe, expect, it } from 'vitest'
import { DISPLAYS, EXAMPLES, TOOL_EXAMPLES } from './displays.ts'
import spec from './parts.json' with { type: 'json' }

const parser = createParser(spec.schema, spec.root)

/** An example is the heading the model reads, a blank line, then the program it may copy. */
const program = (example: string) => example.slice(example.indexOf('\n\n') + 2)

describe('what Vivid is taught about displays', () => {
  it('teaches only examples OpenUI’s own parser finds nothing wrong with', () => {
    for (const example of [...EXAMPLES, ...TOOL_EXAMPLES]) {
      const result = parser.parse(program(example))
      expect(result.root, example).not.toBeNull()
      expect(result.meta.errors, example).toEqual([])
      expect(result.meta.unresolved, example).toEqual([])
      expect(DISPLAYS).toContain(program(example))
    }
  })

  it('has the model draw inside its reply, with live Integration tools and state', () => {
    expect(DISPLAYS).toContain('## Inline Mode')
    expect(DISPLAYS).toContain('## Query')
    expect(DISPLAYS).toContain('## Mutation')
    expect(DISPLAYS).toContain('tool@account')
    expect(DISPLAYS).not.toContain('Your ENTIRE response must be valid openui-lang')
  })
})
