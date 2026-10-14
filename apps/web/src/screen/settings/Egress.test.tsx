// @vitest-environment happy-dom
import { EgressStatus, Forbidden } from '@vivid/contracts'
import { LiveState } from '@vivid/state'
import { describe, expect, it } from 'vitest'
import { LABEL, said } from './Egress'

const off = said(LiveState.Ready({ value: EgressStatus.cases.Off.make({}) }))
const every = [
  off,
  said(LiveState.Ready({ value: EgressStatus.cases.Waiting.make({}) })),
  said(LiveState.Ready({ value: EgressStatus.cases.Routing.make({ streams: 2 }) })),
  said(LiveState.Ready({ value: EgressStatus.cases.Failed.make({ reason: 'Computer' }) })),
  said(LiveState.Loading()),
  said(LiveState.Failed({ failure: Forbidden.make({ message: 'No access' }) })),
]

describe('what is said under the switch for Vivid’s browsing', () => {
  it('says whose address sites see while it is off: the address of Vivid’s computer', () => {
    expect(off).toContain('Vivid’s computer')
    expect(off).not.toMatch(/your own address|as when you signed in/u)
  })

  it('says something of its own for each thing that can be true, the unknown ones included', () => {
    expect(new Set(every).size).toBe(every.length)
  })

  it('never says it is the computer the Person is looking at', () => {
    // The way out is the first computer of theirs with the Vivid app open, which may be at
    // home while Settings is open at work, or in a browser on a computer with no app at all.
    for (const words of [LABEL, ...every]) expect(words).not.toMatch(/this computer/iu)
    expect(LABEL).toBe('Send Vivid’s browsing through your computer')
    const routing = said(
      LiveState.Ready({ value: EgressStatus.cases.Routing.make({ streams: 0 }) }),
    )
    expect(routing).toContain('a computer of yours that has the Vivid app open')
  })

  it('uses the product’s words, never the mechanism’s', () => {
    for (const words of [LABEL, ...every]) expect(words).not.toMatch(/egress|tunnel|proxy|agent/iu)
  })
})
