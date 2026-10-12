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
    // The whole address, so a parameter the provider's page needs cannot be dropped unseen.
    expect(viewerOnDesk(ISSUED)).toBe(
      'https://desktop.example/stream.html?hostId=1&appId=2&width=1920&height=1080&fps=60#token=abc',
    )
    // The fragment is the permission: a `theme` written there is not the setting.
    expect(viewerOnDesk('https://desktop.example/stream.html?width=1920#theme=light')).toBe(
      'https://desktop.example/stream.html?width=1920#theme=light',
    )
  })
})
