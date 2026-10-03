import * as AtomRegistry from 'effect/unstable/reactivity/AtomRegistry'
import { describe, expect, it } from 'vitest'
import { makeLink } from './link.js'

describe('the link to the server', () => {
  it('is connecting until the transport says otherwise, then follows it', () => {
    const registry = AtomRegistry.make()
    const link = makeLink()
    const unmount = registry.mount(link.atom)
    expect(registry.get(link.atom)).toBe('connecting')

    link.heard(false)
    expect(registry.get(link.atom)).toBe('lost')
    link.heard(true)
    expect(registry.get(link.atom)).toBe('open')
    unmount()
  })

  it('tells a screen that starts reading late where things stand now', () => {
    const registry = AtomRegistry.make()
    const link = makeLink()
    link.heard(true)
    link.heard(false)
    expect(registry.get(link.atom)).toBe('lost')
  })
})
