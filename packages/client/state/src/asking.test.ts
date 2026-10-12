import {
  Conflict,
  InputAnswer,
  InputRequestId,
  InputRequestState,
  PersonId,
  ThreadId,
  type InputQuestion,
  type InputRequest,
} from '@vivid/contracts'
import {
  InputAnswerCountMismatch,
  InputAnswerSeveralForbidden,
  InputAnswerUnknownLabel,
} from '@vivid/contracts/rpc'
import { Option } from 'effect'
import { describe, expect, it } from 'vitest'
import {
  advance,
  answerOf,
  answersOf,
  back,
  begin,
  Draft,
  draftingOf,
  Hold,
  holdOf,
  Line,
  linesOf,
  pickedIn,
  press,
  progressOf,
  refusalIn,
  refusedAt,
  refusedOf,
  repliedWords,
  Reply,
  replyOf,
  returnTo,
  standingOf,
  standOf,
  Step,
  toggle,
  Tried,
  triesAfter,
  type,
  untried,
  upOf,
  write,
  writtenIn,
  type Spoken,
} from './asking.js'

const option = (label: string) => ({ label, detail: '' })

const one: InputQuestion = {
  question: 'Which inbox should I start with?',
  options: [option('Work'), option('Personal')],
  selection: 'One',
  allowsOwnAnswer: false,
}
const several: InputQuestion = {
  question: 'Which days suit you?',
  options: [option('Monday'), option('Tuesday'), option('Friday')],
  selection: 'Several',
  allowsOwnAnswer: false,
}
const open: InputQuestion = {
  question: 'What should the subject line say?',
  options: [],
  selection: 'One',
  allowsOwnAnswer: true,
}
const questions = [one, several, open] as const

const chosen = (...labels: [string, ...Array<string>]) => InputAnswer.cases.Chosen.make({ labels })

describe('toggle', () => {
  it('replaces the pick under One', () => {
    const first = toggle(one, Draft.Blank(), 'Work')
    expect(pickedIn(toggle(one, first, 'Personal'))).toEqual(['Personal'])
  })

  it('adds and takes out under Several, in the order picked', () => {
    const two = toggle(several, toggle(several, Draft.Blank(), 'Friday'), 'Monday')
    expect(pickedIn(two)).toEqual(['Friday', 'Monday'])
    expect(pickedIn(toggle(several, two, 'Friday'))).toEqual(['Monday'])
  })

  it('is blank again when the last pick is taken out', () => {
    const picked = toggle(several, Draft.Blank(), 'Monday')
    expect(toggle(several, picked, 'Monday')).toEqual(Draft.Blank())
  })

  it('replaces words that were written', () => {
    expect(pickedIn(toggle(several, Draft.Wrote({ words: 'any day' }), 'Monday'))).toEqual([
      'Monday',
    ])
  })
})

describe('write', () => {
  it('replaces picks with words', () => {
    const picked = toggle(several, Draft.Blank(), 'Monday')
    expect(writtenIn(write(picked, 'any day'))).toBe('any day')
    expect(pickedIn(write(picked, 'any day'))).toEqual([])
  })

  it('leaves picks alone when the field is cleared', () => {
    const picked = toggle(several, Draft.Blank(), 'Monday')
    expect(write(picked, '   ')).toEqual(picked)
  })

  it('is blank when written words are cleared', () => {
    expect(write(Draft.Wrote({ words: 'any day' }), '')).toEqual(Draft.Blank())
  })
})

describe('answerOf', () => {
  it('is nothing for a blank draft', () => {
    expect(answerOf(one, Draft.Blank())).toEqual(Option.none())
  })

  it('is the picked labels', () => {
    expect(answerOf(several, Draft.Picked({ labels: ['Friday', 'Monday'] }))).toEqual(
      Option.some(chosen('Friday', 'Monday')),
    )
  })

  it('counts only one pick under One', () => {
    expect(answerOf(one, Draft.Picked({ labels: ['Work', 'Personal'] }))).toEqual(
      Option.some(chosen('Work')),
    )
  })

  it('does not count a label the question does not offer', () => {
    expect(answerOf(one, Draft.Picked({ labels: ['Elsewhere'] }))).toEqual(Option.none())
  })

  it('is the written words without the spaces round them', () => {
    expect(answerOf(open, Draft.Wrote({ words: '  Hello there ' }))).toEqual(
      Option.some(InputAnswer.cases.Written.make({ words: 'Hello there' })),
    )
  })

  it('does not count words where the question takes only its options', () => {
    expect(answerOf(one, Draft.Wrote({ words: 'neither' }))).toEqual(Option.none())
  })
})

describe('progressOf', () => {
  it('starts on the first question with nothing answered', () => {
    const progress = progressOf(questions, begin(questions))
    expect(progress).toMatchObject({
      at: 0,
      of: 3,
      question: one,
      answered: 0,
      first: true,
      last: false,
      canAdvance: false,
    })
  })

  it('counts the questions that have an answer', () => {
    const asking = press(questions, begin(questions), 'Work')
    expect(progressOf(questions, asking)).toMatchObject({ answered: 1, canAdvance: true })
  })

  it('never stands past the last question', () => {
    const progress = progressOf(questions, returnTo(begin(questions), 9))
    expect(progress).toMatchObject({ at: 2, question: open, last: true })
  })
})

describe('advance', () => {
  it('stays while the question that is up has no answer', () => {
    expect(advance(questions, begin(questions))).toEqual(Step.Stay())
  })

  it('puts the next question up and keeps what was picked', () => {
    const asking = press(questions, begin(questions), 'Work')
    const step = advance(questions, asking)
    expect(step).toEqual(Step.Next({ asking: { at: 1, drafts: asking.drafts } }))
  })

  it('sends every answer, in the questions order, from the last question', () => {
    const first = press(questions, begin(questions), 'Work')
    const second = press(questions, press(questions, returnTo(first, 1), 'Monday'), 'Friday')
    const third = type(questions, returnTo(second, 2), 'Lunch on Friday')
    expect(advance(questions, third)).toEqual(
      Step.Send({
        answers: [
          chosen('Work'),
          chosen('Monday', 'Friday'),
          InputAnswer.cases.Written.make({ words: 'Lunch on Friday' }),
        ],
      }),
    )
  })

  it('does not send a short list when an earlier question has no answer', () => {
    const last = type(questions, returnTo(begin(questions), 2), 'Lunch on Friday')
    expect(advance(questions, last)).toEqual(Step.Stay())
    expect(answersOf(questions, last)).toEqual(Option.none())
  })

  it('sends a single question at once', () => {
    const asking = press([one], begin([one]), 'Personal')
    expect(advance([one], asking)).toEqual(Step.Send({ answers: [chosen('Personal')] }))
  })
})

describe('back', () => {
  it('returns to the question before with its picks kept', () => {
    const first = press(questions, begin(questions), 'Work')
    const second = returnTo(first, 1)
    expect(progressOf(questions, back(second))).toMatchObject({
      at: 0,
      draft: Draft.Picked({ labels: ['Work'] }),
    })
  })

  it('stays on the first question', () => {
    expect(back(begin(questions)).at).toBe(0)
  })
})

describe('refusedAt', () => {
  const id = InputRequestId.make('request')

  it('is the question a refusal names', () => {
    const refusal = new InputAnswerUnknownLabel({
      id,
      questionIndex: 1,
      message: 'Choose only options offered for this question.',
    })
    expect(refusedAt(refusal)).toEqual(Option.some(1))
  })

  it('is found in what a send failed with, and nothing else is', () => {
    const refusal = new InputAnswerUnknownLabel({
      id,
      questionIndex: 0,
      message: 'Choose only options offered for this question.',
    })
    expect(refusalIn(refusal)).toEqual(Option.some(refusal))
    expect(refusalIn(new Conflict({ message: 'Input request already answered' }))).toEqual(
      Option.none(),
    )
  })

  it('is no question when the count of answers was wrong', () => {
    const refusal = new InputAnswerCountMismatch({
      id,
      expected: 3,
      received: 2,
      message: 'Every question needs one answer.',
    })
    expect(refusedAt(refusal)).toEqual(Option.none())
  })
})

const me = { id: PersonId.make('me'), name: 'Ada', image: null }
const them = { id: PersonId.make('them'), name: 'Bisi', image: null }

const waiting = InputRequestState.cases.Waiting.make({})
const answered = InputRequestState.cases.Answered.make({
  answeredBy: me,
  answers: [InputAnswer.cases.Chosen.make({ labels: ['Work'] })],
  answeredAt: 2,
})
const withdrawn = InputRequestState.cases.Withdrawn.make({ withdrawnAt: 2 })

const request = (id: string, patch: Partial<InputRequest> = {}): InputRequest => ({
  id: InputRequestId.make(id),
  threadId: ThreadId.make('thread'),
  runId: null,
  questions: [
    {
      question: 'Which inbox should I start with?',
      options: [
        { label: 'Work', detail: '' },
        { label: 'Personal', detail: '' },
      ],
      selection: 'One',
      allowsOwnAnswer: true,
    },
  ],
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
    const newer = request('a', { createdAt: 5 })
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

describe('triesAfter', () => {
  const a = { attempt: 1, id: InputRequestId.make('a') }
  const b = { attempt: 2, id: InputRequestId.make('b') }
  const failure = new Conflict({ message: 'Input request already answered' })

  it('puts a try on its way and forgets what was last refused', () => {
    const refused = triesAfter(
      triesAfter(untried, Tried.Began({ tried: a })),
      Tried.Failed({ tried: a, failure }),
    )
    expect(Option.isSome(refused.refused)).toBe(true)
    expect(triesAfter(refused, Tried.Began({ tried: b }))).toEqual({
      pending: Option.some(b),
      refused: Option.none(),
    })
  })

  it('ends the try that failed and keeps why', () => {
    const after = triesAfter(
      triesAfter(untried, Tried.Began({ tried: a })),
      Tried.Failed({ tried: a, failure }),
    )
    expect(after.pending).toEqual(Option.none())
    expect(Option.map(after.refused, (refusal) => refusal.attempt)).toEqual(Option.some(1))
  })

  it('leaves a later try on its way when an earlier one fails late', () => {
    const later = triesAfter(untried, Tried.Began({ tried: b }))
    expect(triesAfter(later, Tried.Failed({ tried: a, failure })).pending).toEqual(Option.some(b))
  })

  it('keeps why a try failed even when nothing was on its way any more', () => {
    const after = triesAfter(untried, Tried.Failed({ tried: a, failure }))
    expect(after.pending).toEqual(Option.none())
    expect(Option.map(after.refused, (refusal) => refusal.attempt)).toEqual(Option.some(1))
  })
})

describe('refusedOf', () => {
  const tried = { attempt: 3, id: InputRequestId.make('a') }

  it('says the server refusal as it is and names its question', () => {
    const failure = new InputAnswerSeveralForbidden({
      id: tried.id,
      questionIndex: 1,
      message: 'Choose one option for this question.',
    })
    expect(refusedOf(tried, failure)).toEqual({
      ...tried,
      words: 'Choose one option for this question.',
      place: Option.some(1),
    })
  })

  it('names no question for any other failure', () => {
    const failure = new Conflict({ message: 'Input request already answered' })
    expect(refusedOf(tried, failure)).toEqual({
      ...tried,
      words: 'That answer did not go through. It may already be answered.',
      place: Option.none(),
    })
  })
})

describe('repliedWords', () => {
  it('is the picked label for a request of one question', () => {
    expect(repliedWords([InputAnswer.cases.Chosen.make({ labels: ['Work'] })])).toBe('Work')
  })

  it('is one line for each question, picks joined and written words as they are', () => {
    expect(
      repliedWords([
        InputAnswer.cases.Chosen.make({ labels: ['Work'] }),
        InputAnswer.cases.Chosen.make({ labels: ['Monday', 'Friday'] }),
        InputAnswer.cases.Written.make({ words: 'Lunch on Friday' }),
      ]),
    ).toBe('Work\nMonday, Friday\nLunch on Friday')
  })
})

describe('linesOf', () => {
  const spoke = (key: string, patch: Partial<Spoken> = {}): Spoken => ({
    key,
    asked: [],
    answers: Option.none(),
    at: Option.none(),
    ...patch,
  })
  const answeredAt = (id: string, at: number) =>
    request(id, {
      state: InputRequestState.cases.Answered.make({
        answeredBy: me,
        answers: [InputAnswer.cases.Chosen.make({ labels: [id] })],
        answeredAt: at,
      }),
    })
  const order = (lines: ReadonlyArray<Line>) =>
    lines.map((line) =>
      Line.$match(line, {
        Said: ({ key }) => key,
        Answer: ({ request: asked }) => `answer:${asked.id}`,
      }),
    )

  it('is the messages alone while nothing is answered', () => {
    const spoken = [spoke('q', { asked: [InputRequestId.make('a')] }), spoke('m')]
    expect(order(linesOf(spoken, [request('a')]))).toEqual(['q', 'm'])
  })

  it('puts an answer where the message that delivered it is', () => {
    const spoken = [
      spoke('q', { asked: [InputRequestId.make('a')] }),
      spoke('m'),
      spoke('signal', { answers: Option.some(InputRequestId.make('a')) }),
      spoke('reply', { at: Option.some(50) }),
    ]
    expect(order(linesOf(spoken, [answeredAt('a', 40)]))).toEqual(['q', 'm', 'answer:a', 'reply'])
  })

  it('puts an answer with no delivering message at the end, not under its question', () => {
    const spoken = [
      spoke('q', { asked: [InputRequestId.make('a')], at: Option.some(10) }),
      spoke('m'),
      spoke('later', { at: Option.some(20) }),
    ]
    expect(order(linesOf(spoken, [answeredAt('a', 30)]))).toEqual(['q', 'm', 'later', 'answer:a'])
  })

  it('puts an older answer before the first message stamped after it', () => {
    const spoken = [
      spoke('q', { asked: [InputRequestId.make('a')], at: Option.some(10) }),
      spoke('reply', { at: Option.some(50) }),
      spoke('more', { at: Option.some(60) }),
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
      spoke('before', { at: Option.some(50) }),
      spoke('q', { asked: [InputRequestId.make('a')], at: Option.some(60) }),
    ]
    // A clock that disagrees: the answer is stamped earlier than the reply before its question.
    expect(order(linesOf(spoken, [answeredAt('a', 40)]))).toEqual(['before', 'q', 'answer:a'])
  })

  it('orders several answers by when they were given', () => {
    const spoken = [
      spoke('q1', { asked: [InputRequestId.make('a')] }),
      spoke('q2', { asked: [InputRequestId.make('b')] }),
    ]
    expect(order(linesOf(spoken, [answeredAt('a', 90), answeredAt('b', 70)]))).toEqual([
      'q1',
      'q2',
      'answer:b',
      'answer:a',
    ])
  })
})

describe('replyOf', () => {
  const pick = { label: 'Work', detail: '' }
  const question = (patch: Partial<InputRequest['questions'][number]>) => ({
    question: 'What should the subject line say?',
    options: [],
    selection: 'One' as const,
    allowsOwnAnswer: true,
    ...patch,
  })
  const up = (set: InputRequest['questions'], at = 0) => {
    const asked = request('a', { questions: set })
    return Option.some({ request: asked, drafting: returnTo(begin(set), at) })
  }

  it('is an ordinary reply when the question offers options, own answer allowed or not', () => {
    expect(replyOf(up([question({ options: [pick] })]), 'skip that')).toEqual(Reply.Message())
  })

  it('is an ordinary reply when a question with no options takes no words either', () => {
    expect(replyOf(up([question({ allowsOwnAnswer: false })]), 'skip that')).toEqual(
      Reply.Message(),
    )
  })

  it('is an ordinary reply when no card is up', () => {
    expect(replyOf(Option.none(), 'hello')).toEqual(Reply.Message())
  })

  it('answers a question with no options in words, and sends every answer from the last', () => {
    const set = [question({ options: [pick] }), question({})] as const
    const first = press(set, begin(set), 'Work')
    const reply = replyOf(
      Option.some({ request: request('a', { questions: set }), drafting: returnTo(first, 1) }),
      'Lunch on Friday',
    )
    expect(Reply.$is('Answer')(reply) && reply.step).toEqual(
      Step.Send({
        answers: [
          InputAnswer.cases.Chosen.make({ labels: ['Work'] }),
          InputAnswer.cases.Written.make({ words: 'Lunch on Friday' }),
        ],
      }),
    )
  })

  it('moves on to the next question from one in the middle, with the words kept', () => {
    const set = [question({}), question({ options: [pick] })] as const
    const reply = replyOf(up(set), 'Lunch on Friday')
    expect(Reply.$is('Answer')(reply) && Step.$is('Next')(reply.step)).toBe(true)
    expect(Reply.$is('Answer')(reply) && writtenIn(reply.drafting.drafts[0] ?? Draft.Blank())).toBe(
      'Lunch on Friday',
    )
  })
})

describe('draftingOf', () => {
  const asked = request('a')
  const start = begin(asked.questions)

  it('starts a request nothing is kept for', () => {
    expect(draftingOf(asked, Option.none(), Option.none())).toEqual(start)
  })

  it('does not take another request drafts', () => {
    const other = {
      id: InputRequestId.make('b'),
      drafting: returnTo(start, 3),
      heeded: Option.none(),
    }
    expect(draftingOf(asked, Option.some(other), Option.none())).toEqual(start)
  })

  it('puts the question a new refusal names back up, once', () => {
    const kept = {
      id: asked.id,
      drafting: returnTo(start, 2),
      heeded: Option.none<number>(),
    }
    const refusal = { attempt: 4, id: asked.id, words: 'Choose one option.', place: Option.some(0) }
    expect(draftingOf(asked, Option.some(kept), Option.some(refusal)).at).toBe(0)
    const heeded = { ...kept, heeded: Option.some(4) }
    expect(draftingOf(asked, Option.some(heeded), Option.some(refusal)).at).toBe(2)
  })
})

describe('standOf', () => {
  it('is up until the grabber tucks it, and gone once it is leaving, tucked or not', () => {
    expect(standOf(false, false)).toBe('up')
    expect(standOf(false, true)).toBe('tucked')
    expect(standOf(true, false)).toBe('gone')
    expect(standOf(true, true)).toBe('gone')
  })
})

describe('standingOf', () => {
  it('is chosen when it is in the draft, sending or not; else on offer, or back while sending', () => {
    expect(standingOf(true, false)).toBe('chosen')
    expect(standingOf(true, true)).toBe('chosen')
    expect(standingOf(false, false)).toBe('open')
    expect(standingOf(false, true)).toBe('back')
  })
})
