import { describe, expect, it } from 'vitest'
import { mended } from './mend'

describe('a reply that is still arriving', () => {
  it('closes bold that has opened, and shows nothing for a bare opener', () => {
    expect(mended('**Why riv')).toBe('**Why riv**')
    expect(mended('**')).toBe('')
    expect(mended('Rivers **bend')).toBe('Rivers **bend**')
  })

  it('leaves finished marks and earlier paragraphs as they were written', () => {
    expect(mended('**Why rivers bend**\n\nWater is **slo')).toBe(
      '**Why rivers bend**\n\nWater is **slo**',
    )
    expect(mended('Plain words. A list:\n\n* one\n* two')).toBe(
      'Plain words. A list:\n\n* one\n* two',
    )
  })

  it('closes inline code, and does not read an asterisk inside code as bold', () => {
    expect(mended('Run `pnpm ga')).toBe('Run `pnpm ga`')
    expect(mended('Type `**` twice')).toBe('Type `**` twice')
  })

  it('closes a code fence that has no end yet, without touching what is in it', () => {
    expect(mended('Here:\n\n```ts\nconst a = `**')).toBe('Here:\n\n```ts\nconst a = `**\n```')
    expect(mended('```ts\nconst a = 1\n```\n\nDone **now')).toBe(
      '```ts\nconst a = 1\n```\n\nDone **now**',
    )
  })

  it('closes a fence with the marker and indent that opened it', () => {
    expect(mended('~~~\ncode ``` here')).toBe('~~~\ncode ``` here\n~~~')
    expect(mended('* item\n\n  ```sh\n  ls')).toBe('* item\n\n  ```sh\n  ls\n  ```')
  })

  it('does not read marks inside a finished link address or longer code span', () => {
    expect(mended('See [x](https://example.com/**) now')).toBe(
      'See [x](https://example.com/**) now',
    )
    expect(mended('Type ``a ** b`` then')).toBe('Type ``a ** b`` then')
    expect(mended('In code `[a](http')).toBe('In code `[a](http`')
  })

  it('shows a link as its words until its address has closed', () => {
    expect(mended('See [the guide](https://exam')).toBe('See the guide')
    expect(mended('See [the guide](https://example.com) now')).toBe(
      'See [the guide](https://example.com) now',
    )
  })
})
