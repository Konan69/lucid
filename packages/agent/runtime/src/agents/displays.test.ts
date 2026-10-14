import { createParser } from '@openuidev/lang-core'
import { describe, expect, it } from 'vitest'
import { DISPLAYS, EXAMPLES } from './displays.ts'
import spec from './parts.json' with { type: 'json' }

const parser = createParser(spec.schema, spec.root)

describe('what Vivid is taught about displays', () => {
  it('teaches only examples OpenUI’s own parser finds nothing wrong with', () => {
    for (const example of EXAMPLES) {
      const result = parser.parse(example)
      expect(result.root).not.toBeNull()
      expect(result.meta.errors).toEqual([])
      expect(result.meta.unresolved).toEqual([])
      expect(DISPLAYS).toContain(example)
    }
  })

  it('has the model write a display inside its reply, in a fence, with Vivid’s own parts', () => {
    expect(DISPLAYS).toContain('## Inline Mode')
    expect(DISPLAYS).toContain('Chart(')
    expect(DISPLAYS).not.toContain('Your ENTIRE response must be valid openui-lang')
  })
})
