import {
  InputRequestId,
  InputRequestState,
  PersonId,
  ThreadId,
  type InputRequest,
} from '@vivid/contracts'
import { Option } from 'effect'
import { describe, expect, it } from 'vitest'
import {
  afterFailure,
  Hold,
  hasChoices,
  Line,
  linesOf,
  mayAnswer,
  type Spoken,
  holdOf,
  KEYBOARD_RESERVE,
  Send,
  sendOf,
  standingOf,
  standOf,
  tallestOf,
  upOf,
} from './asked'

const me = { id: PersonId.make('me'), name: 'Ada', image: null }
const them = { id: PersonId.make('them'), name: 'Bisi', image: null }

const waiting = InputRequestState.cases.Waiting.make({})
const answered = InputRequestState.cases.Answered.make({
  answeredBy: me,
  answer: 'Work',
  answeredAt: 2,
})
const withdrawn = InputRequestState.cases.Withdrawn.make({ withdrawnAt: 2 })

const request = (id: string, patch: Partial<InputRequest> = {}): InputRequest => ({
  id: InputRequestId.make(id),
  threadId: ThreadId.make('thread'),
  runId: null,
  question: 'Which inbox should I start with?',
  options: [
    { label: 'Work', detail: '' },
    { label: 'Personal', detail: '' },
  ],
  allowsOwnAnswer: true,
  askedOf: me,
  state: waiting,
  createdAt: 1,
  ...patch,
})

describe('upOf', () => {
  it('is the oldest request still waiting on this Person', () => {
    const requests = [request('a', { state: answered }), request('b'), request('c')]
    expect(Option.map(upOf(requests, me.id), (up) => up.id)).toEqual(
      Option.some(InputRequestId.make('b')),
    )
  })

  it('passes over a request asked of somebody else', () => {
    const requests = [request('a', { askedOf: them }), request('b')]
    expect(Option.map(upOf(requests, me.id), (up) => up.id)).toEqual(
      Option.some(InputRequestId.make('b')),
    )
  })

  it('is nothing when every request is settled', () => {
    const requests = [request('a', { state: answered }), request('b', { state: withdrawn })]
    expect(Option.isNone(upOf(requests, me.id))).toBe(true)
  })
})

describe('holdOf', () => {
  it('is free while nothing is held', () => {
    expect(holdOf(Option.none(), Option.some(request('a')))).toEqual(Hold.Free())
  })

  it('draws the held request from its newest record while it is up', () => {
    const newer = request('a', { question: 'Which one?' })
    expect(holdOf(Option.some(request('a')), Option.some(newer))).toEqual(
      Hold.Up({ request: newer }),
    )
  })

  it('keeps the held request as it was while it leaves for the next', () => {
    const held = request('a')
    expect(holdOf(Option.some(held), Option.some(request('b')))).toEqual(
      Hold.Leaving({ request: held }),
    )
  })

  it('leaves when nothing is up any more', () => {
    const held = request('a')
    expect(holdOf(Option.some(held), Option.none())).toEqual(Hold.Leaving({ request: held }))
  })
})

describe('hasChoices', () => {
  it('has no card for a request that offers nothing to press', () => {
    expect(hasChoices(request('a', { options: [] }))).toBe(false)
    expect(hasChoices(request('a'))).toBe(true)
  })
})

describe('sendOf', () => {
  it('answers the request that is up when it takes words of one own', () => {
    const up = request('a')
    expect(sendOf(Hold.Up({ request: up }), Option.some(up))).toEqual(
      Send.Answer({ id: InputRequestId.make('a') }),
    )
  })

  it('sends an ordinary message when the request takes only its choices', () => {
    const up = request('a', { allowsOwnAnswer: false })
    expect(sendOf(Hold.Up({ request: up }), Option.some(up))).toEqual(Send.Message())
  })

  it('sends an ordinary message when nothing is waiting, card leaving or not', () => {
    expect(sendOf(Hold.Free(), Option.none())).toEqual(Send.Message())
    expect(sendOf(Hold.Leaving({ request: request('a') }), Option.none())).toEqual(Send.Message())
  })

  it('waits while one card leaves and the next request is not up yet', () => {
    const next = Option.some(request('b'))
    expect(sendOf(Hold.Leaving({ request: request('a') }), next)).toEqual(Send.Wait())
    expect(sendOf(Hold.Free(), next)).toEqual(Send.Wait())
  })
})

describe('afterFailure', () => {
  const a = { attempt: 1, id: InputRequestId.make('a'), words: 'Work' }
  const b = { attempt: 2, id: InputRequestId.make('b'), words: 'Monday' }

  it('clears the try that failed', () => {
    expect(afterFailure(Option.some(a), 1)).toEqual(Option.none())
  })

  it('leaves a later try on its way when an earlier one fails late', () => {
    expect(afterFailure(Option.some(b), 1)).toEqual(Option.some(b))
  })

  it('has nothing to clear when nothing is on its way', () => {
    expect(afterFailure(Option.none(), 1)).toEqual(Option.none())
  })
})

describe('mayAnswer', () => {
  it('refuses a second answer to a request while one is in flight', () => {
    const flying = new Set([InputRequestId.make('a')])
    expect(mayAnswer(flying, InputRequestId.make('a'))).toBe(false)
    expect(mayAnswer(flying, InputRequestId.make('b'))).toBe(true)
  })
})

describe('linesOf', () => {
  const said = (key: string, patch: Partial<Spoken> = {}): Spoken => ({
    key,
    asked: [],
    answers: Option.none(),
    at: Option.none(),
    ...patch,
  })
  const answeredAt = (id: string, at: number) =>
    request(id, {
      state: InputRequestState.cases.Answered.make({ answeredBy: me, answer: id, answeredAt: at }),
    })
  const order = (lines: ReadonlyArray<Line>) =>
    lines.map((line) =>
      Line.$match(line, { Said: ({ key }) => key, Answer: ({ answer }) => `answer:${answer}` }),
    )

  it('is the messages alone while nothing is answered', () => {
    const spoken = [said('q', { asked: [InputRequestId.make('a')] }), said('m')]
    expect(order(linesOf(spoken, [request('a')]))).toEqual(['q', 'm'])
  })

  it('puts an answer where the message that delivered it is', () => {
    const spoken = [
      said('q', { asked: [InputRequestId.make('a')] }),
      said('m'),
      said('signal', { answers: Option.some(InputRequestId.make('a')) }),
      said('reply', { at: Option.some(50) }),
    ]
    expect(order(linesOf(spoken, [answeredAt('a', 40)]))).toEqual(['q', 'm', 'answer:a', 'reply'])
  })

  it('puts an answer with no delivering message at the end, not under its question', () => {
    const spoken = [
      said('q', { asked: [InputRequestId.make('a')], at: Option.some(10) }),
      said('m'),
      said('later', { at: Option.some(20) }),
    ]
    expect(order(linesOf(spoken, [answeredAt('a', 30)]))).toEqual(['q', 'm', 'later', 'answer:a'])
  })

  it('puts an older answer before the first message stamped after it', () => {
    const spoken = [
      said('q', { asked: [InputRequestId.make('a')], at: Option.some(10) }),
      said('reply', { at: Option.some(50) }),
      said('more', { at: Option.some(60) }),
    ]
    expect(order(linesOf(spoken, [answeredAt('a', 40)]))).toEqual([
      'q',
      'answer:a',
      'reply',
      'more',
    ])
  })

  it('never puts an answer before the reply that asked', () => {
    const spoken = [
      said('before', { at: Option.some(50) }),
      said('q', { asked: [InputRequestId.make('a')], at: Option.some(60) }),
    ]
    // A clock that disagrees: the answer is stamped earlier than the reply before its question.
    expect(order(linesOf(spoken, [answeredAt('a', 40)]))).toEqual(['before', 'q', 'answer:a'])
  })

  it('orders several answers by when they were given', () => {
    const spoken = [
      said('q1', { asked: [InputRequestId.make('a')] }),
      said('q2', { asked: [InputRequestId.make('b')] }),
    ]
    expect(order(linesOf(spoken, [answeredAt('a', 90), answeredAt('b', 70)]))).toEqual([
      'q1',
      'q2',
      'answer:b',
      'answer:a',
    ])
  })
})

describe('standOf', () => {
  it('is up until the grabber tucks it', () => {
    expect(standOf(false, false)).toBe('up')
    expect(standOf(false, true)).toBe('tucked')
  })

  it('is gone once it is leaving, tucked or not', () => {
    expect(standOf(true, false)).toBe('gone')
    expect(standOf(true, true)).toBe('gone')
  })
})

describe('standingOf', () => {
  it('is on offer while no answer is on its way', () => {
    expect(standingOf('Work', Option.none())).toBe('open')
  })

  it('is chosen when its own answer is on its way', () => {
    expect(standingOf('Work', Option.some('Work'))).toBe('chosen')
  })

  it('stands back for another row and for words of the Person own', () => {
    expect(standingOf('Work', Option.some('Personal'))).toBe('back')
    expect(standingOf('Work', Option.some('skip that, just sort my inbox'))).toBe('back')
  })
})

describe('tallestOf', () => {
  const phone = { window: 844, keyboard: KEYBOARD_RESERVE, bar: 147, composer: 60 }

  it('is what is left between the bar and the composer over the keyboard', () => {
    expect(tallestOf(phone)).toBe(844 - 336 - 147 - 60 - 12)
  })

  it('is never more than its ceiling on a large screen', () => {
    expect(tallestOf({ ...phone, window: 1366 })).toBe(560)
  })

  it('is never squeezed under its floor on a small one', () => {
    expect(tallestOf({ ...phone, window: 568 })).toBe(160)
  })

  it('counts a negative measure as none', () => {
    expect(tallestOf({ ...phone, keyboard: -40, window: 700 })).toBe(700 - 147 - 60 - 12)
  })
})
