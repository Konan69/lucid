import { Conflict, InputAnswer, InputRequestId, type InputQuestion } from '@vivid/contracts'
import { InputAnswerCountMismatch, InputAnswerUnknownLabel } from '@vivid/contracts/rpc'
import { Option } from 'effect'
import { describe, expect, it } from 'vitest'
import {
  advance,
  answerOf,
  answersOf,
  back,
  begin,
  Draft,
  pickedIn,
  press,
  progressOf,
  refusalIn,
  refusedAt,
  returnTo,
  said,
  Step,
  toggle,
  type,
  write,
  writtenIn,
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

describe('said', () => {
  it('joins picked labels and gives written words as they are', () => {
    expect(said(chosen('Monday', 'Friday'))).toBe('Monday, Friday')
    expect(said(InputAnswer.cases.Written.make({ words: 'Lunch on Friday' }))).toBe(
      'Lunch on Friday',
    )
  })
})
