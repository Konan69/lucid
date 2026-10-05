import { describe, expect, it } from '@effect/vitest'
import { Option } from 'effect'
import { printed } from './lines.ts'

describe('Printed lines', () => {
  it('joins a message split across pieces and separates messages that arrive together', () => {
    const first = printed('', '{"a":', 64)
    expect(first).toEqual(Option.some({ lines: [], rest: '{"a":' }))
    expect(printed('{"a":', '1}\n{"b":2}\n{"c"', 64)).toEqual(
      Option.some({ lines: ['{"a":1}', '{"b":2}'], rest: '{"c"' }),
    )
  })

  it('refuses a line past the limit whether it ended or is still being printed', () => {
    expect(printed('', `${'x'.repeat(9)}\n`, 8)).toEqual(Option.none())
    expect(printed('xxxx', 'xxxxx', 8)).toEqual(Option.none())
    expect(printed('', `${'x'.repeat(8)}\n`, 8)).toEqual(
      Option.some({ lines: ['x'.repeat(8)], rest: '' }),
    )
  })

  it('measures the limit in UTF-8 bytes, not in characters', () => {
    // Three characters, nine bytes.
    expect(printed('', '日本語\n', 8)).toEqual(Option.none())
    expect(printed('', '日本語\n', 9)).toEqual(Option.some({ lines: ['日本語'], rest: '' }))
  })
})
