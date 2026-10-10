import { Option } from 'effect'
import { describe, expect, it } from 'vitest'
import { inThread, Source, sourceOf, type Sourced } from './source'

/**
 * Messages as Flue 2.2.2 projects them (`classifySignal` and the signal branch beside it in
 * `@flue/runtime`'s `conversation-projections.ts`): every signal record is a `system` message
 * marked `diagnostic`, with a `signal` only when the record carried a tag or attributes.
 */
const system = (rest: Pick<Sourced, 'signal' | 'settlement'>): Sourced => ({
  role: 'system',
  display: 'diagnostic',
  ...rest,
})

/** The runtime telling the model its instructions changed: no tag, no attributes, no signal. */
const instructions = system({})
/** The runtime restating the tools and skills that changed: attributes only, no tag. */
const resources = system({ signal: { attributes: { resource: 'skills' } } })
/** A Person speaking in a shared Thread, as the server delivers it. */
const shared = system({
  signal: { tagName: 'message', attributes: { from: 'Dami Cole', turn: '7' } },
})
/** A submission the runtime gave up on; its record carries attributes as well as the marker. */
const failed = system({
  signal: { attributes: { submissionId: 'submission-7', kind: 'dispatch', reason: 'failed' } },
  settlement: { outcome: 'failed' },
})

describe('where a message in a Thread came from', () => {
  it('never draws the runtime telling the model its instructions changed', () => {
    expect(sourceOf(instructions)).toEqual(Source.Plumbing())
    expect(inThread(instructions)).toBe(false)
  })

  it('never draws the runtime restating the tools and skills that changed', () => {
    expect(sourceOf(resources)).toEqual(Source.Plumbing())
    expect(inThread(resources)).toBe(false)
  })

  it('draws a Person’s message in a shared Thread, with the turn and name it came under', () => {
    expect(sourceOf(shared)).toEqual(
      Source.Said({ turn: Option.some('7'), from: Option.some('Dami Cole') }),
    )
    expect(inThread(shared)).toBe(true)
    // A message the server could not attribute keeps its place and simply has neither.
    expect(sourceOf(system({ signal: { tagName: 'message' } }))).toEqual(
      Source.Said({ turn: Option.none(), from: Option.none() }),
    )
  })

  it('draws a reply that was not finished, although its record carries attributes too', () => {
    expect(sourceOf(failed)).toEqual(Source.Failed())
    expect(inThread(failed)).toBe(true)
    expect(sourceOf(system({ settlement: { outcome: 'failed' } }))).toEqual(Source.Failed())
  })

  it('does not draw a reply the Person stopped', () => {
    const stopped = system({
      signal: { attributes: { submissionId: 'submission-7', reason: 'aborted' } },
      settlement: { outcome: 'aborted' },
    })
    expect(inThread(stopped)).toBe(false)
  })

  it('draws a Routine coming due and a follow-up falling due as the reason Vivid spoke', () => {
    const due = system({ signal: { tagName: 'schedule', attributes: { name: 'Morning brief' } } })
    const chase = system({ signal: { tagName: 'follow-up' } })
    expect(sourceOf(due)).toEqual(
      Source.Wake({ reason: 'routine', name: Option.some('Morning brief') }),
    )
    expect(sourceOf(chase)).toEqual(Source.Wake({ reason: 'follow-up', name: Option.none() }))
    expect([due, chase].every(inThread)).toBe(true)
  })

  it('leaves every other wake to its card or to Vivid’s reply, and an unknown one undrawn', () => {
    for (const tagName of ['approval', 'answer', 'first-conversation', 'something-new']) {
      const wake = system({ signal: { tagName, attributes: { from: 'Dami Cole', turn: '7' } } })
      expect(sourceOf(wake)).toEqual(Source.Plumbing())
      expect(inThread(wake)).toBe(false)
    }
  })

  it('draws a private turn and a reply, unless Flue marks them hidden', () => {
    expect(sourceOf({ role: 'user', display: 'visible' })).toEqual(Source.Person())
    expect(sourceOf({ role: 'assistant', display: 'visible' })).toEqual(Source.Vivid())
    expect(inThread({ role: 'assistant', display: 'hidden' })).toBe(false)
    expect(inThread({ role: 'user', display: 'hidden' })).toBe(false)
  })
})
