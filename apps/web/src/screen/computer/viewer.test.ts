import { Option } from 'effect'
import { describe, expect, it } from 'vitest'
import { viewerOnDesk, viewerResolution } from './viewer'

// The form Boat issues: the screen's size and a light theme in the query, the permission in the
// fragment.
const ISSUED =
  'https://desktop.example/stream.html?hostId=1&appId=2&theme=light&width=1920&height=1080&fps=60#token=abc'

describe('a provider viewer address', () => {
  it('says the machine’s screen size, and nothing when it does not carry one', () => {
    expect(viewerResolution(ISSUED)).toEqual(Option.some({ width: 1920, height: 1080 }))
    expect(viewerResolution('https://desktop.example/stream.html?width=1920#token=abc')).toEqual(
      Option.none(),
    )
    expect(viewerResolution('https://desktop.example/stream.html?width=0&height=-4')).toEqual(
      Option.none(),
    )
    expect(viewerResolution('not an address')).toEqual(Option.none())
    expect(
      viewerResolution('https://desktop.example/stream.html?width=1e3&height=9007199254740993'),
    ).toEqual(Option.none())
  })

  it('is loaded dark, with its permission and the rest of it untouched', () => {
    const shown = new URL(viewerOnDesk(ISSUED))
    expect(shown.searchParams.has('theme')).toBe(false)
    expect(shown.searchParams.get('hostId')).toBe('1')
    expect(shown.searchParams.get('width')).toBe('1920')
    expect(shown.hash).toBe('#token=abc')
  })
})
