// @vitest-environment happy-dom
import { EgressStatus, Forbidden } from '@vivid/contracts'
import { LiveState } from '@vivid/state'
import { describe, expect, it } from 'vitest'
import { said } from './Egress'

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

  it('uses the product’s words, never the mechanism’s', () => {
    for (const sentence of every) expect(sentence).not.toMatch(/egress|tunnel|proxy|agent/iu)
  })
})
