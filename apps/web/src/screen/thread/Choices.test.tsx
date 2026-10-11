// @vitest-environment happy-dom
import {
  InputAnswer,
  InputRequestId,
  InputRequestState,
  PersonId,
  ThreadId,
  type InputQuestion,
  type InputRequest,
} from '@vivid/contracts'
import { asking as model } from '@vivid/state'
import { Option, type Array as Arr } from 'effect'
import { act, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import type { Asking } from './asking'
import { Raised } from './Choices'

/**
 * The banner a question from Vivid is asked in, answered the way a Person answers it: the real
 * `Raised` in a real React root, its rows given real clicks and the page real key presses. What
 * is claimed is what the banner hands on (`answer`, the one way an answer leaves it) and what
 * its rows say they are, not how it is drawn: where it sits and how it folds are CSS, which this
 * page (`happy-dom`) does not lay out.
 *
 * The moment a pressed option is shown before the banner moves on is a timer
 * (`asking.ADVANCE_AFTER`), so the clock is the test's own and nothing here waits.
 */

// React flushes what `act` wraps only where the page says it is being tested.
vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

const me = { id: PersonId.make('me'), name: 'Ada', image: null }

const inbox: InputQuestion = {
  question: 'Which inbox should I start with?',
  options: [
    { label: 'Work', detail: 'About forty unread' },
    { label: 'Personal', detail: '' },
  ],
  selection: 'One',
  allowsOwnAnswer: false,
}
const days: InputQuestion = {
  question: 'Which days suit you?',
  options: [
    { label: 'Monday', detail: '' },
    { label: 'Friday', detail: '' },
  ],
  selection: 'Several',
  allowsOwnAnswer: false,
}

const asked = (questions: InputRequest['questions']): InputRequest => ({
  id: InputRequestId.make('request'),
  threadId: ThreadId.make('thread'),
  runId: null,
  questions,
  askedOf: me,
  state: InputRequestState.cases.Waiting.make({}),
  createdAt: 1,
})

type Sent = Array<Arr.NonEmptyReadonlyArray<InputAnswer>>

/**
 * The banner for one request, with what a Thread keeps for it (`useAsking`) held by the test:
 * where the Person is in the questions, whether the request is still the one that is up, and
 * every set of answers the banner hands on.
 */
function Held({ request, leaving, sent }: { request: InputRequest; leaving: boolean; sent: Sent }) {
  const [drafting, setDrafting] = useState(() => model.begin(request.questions))
  const asking: Asking = {
    hold: leaving ? model.Hold.Leaving({ request }) : model.Hold.Up({ request }),
    draftingIn: () => drafting,
    draft: (_id, next) => setDrafting(next),
    written: () => false,
    onward: () => undefined,
    backward: () => undefined,
    progress: Option.some(model.progressOf(request.questions, drafting)),
    answering: false,
    waiting: !leaving,
    sendingTo: () => false,
    refusal: Option.none(),
    answer: (_id, answers) => {
      sent.push(answers)
    },
    release: () => undefined,
  }
  return (
    // `data-alive` is what the Thread's own frame carries (`Layout.tsx`): keys pressed in it
    // are this Thread's.
    <div data-alive>
      <Raised asking={asking} />
    </div>
  )
}

/** Draws the banner for a request and answers the ways a test reaches it. */
function raise(questions: InputRequest['questions']) {
  const sent: Sent = []
  const request = asked(questions)
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  onTestFinished(() => {
    act(() => root.unmount())
    container.remove()
  })
  const draw = (leaving: boolean) =>
    act(() => root.render(<Held request={request} leaving={leaving} sent={sent} />))
  draw(false)
  const rows = () => Array.from(container.querySelectorAll<HTMLElement>('[data-choice]'))
  const row = (label: string) => {
    const found = rows().find((one) => one.textContent.includes(label))
    if (found === undefined) throw new Error(`no row says ${label}`)
    return found
  }
  /** The banner's head row, which is the button that hides and shows what is under it. */
  const head = () => {
    const found = container.querySelector<HTMLButtonElement>('button[aria-expanded]')
    if (found === null) throw new Error('no banner is up')
    return found
  }
  return {
    sent,
    rows,
    row,
    head,
    withdraw: () => draw(true),
    press: (label: string) => act(() => row(label).click()),
    key: (key: string, target: EventTarget = document.body) =>
      act(() => {
        target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
      }),
    /** Lets the moment a pressed option is shown pass. */
    moveOn: () => act(() => vi.advanceTimersByTime(model.ADVANCE_AFTER)),
  }
}

const chosen = (...labels: [string, ...Array<string>]) => InputAnswer.cases.Chosen.make({ labels })

describe('a question that takes one option', () => {
  it('marks the pressed row, holds the rows for a moment, then asks the next question', () => {
    const banner = raise([inbox, days])
    banner.press('Work')
    expect(banner.row('Work').getAttribute('aria-pressed')).toBe('true')
    expect(banner.rows().map((row) => row.getAttribute('aria-disabled'))).toEqual(['true', 'true'])
    expect(banner.head().textContent).toContain(inbox.question)
    expect(banner.head().textContent).toContain('1/2')
    banner.moveOn()
    expect(banner.head().textContent).toContain(days.question)
    expect(banner.head().textContent).toContain('2/2')
    expect(banner.sent).toEqual([])
  })

  it('sends the answers from the last question, once', () => {
    const banner = raise([inbox])
    banner.press('Personal')
    banner.moveOn()
    banner.moveOn()
    expect(banner.sent).toEqual([[chosen('Personal')]])
  })

  it('sends nothing when the request stops being up within the moment', () => {
    const banner = raise([inbox])
    banner.press('Work')
    banner.withdraw()
    banner.moveOn()
    expect(banner.sent).toEqual([])
  })
})

describe('a question several options may be chosen for', () => {
  it('toggles its rows as checkboxes and never moves on by itself', () => {
    const banner = raise([days, inbox])
    banner.press('Monday')
    banner.press('Friday')
    banner.press('Monday')
    expect(banner.rows().map((row) => row.getAttribute('aria-checked'))).toEqual(['false', 'true'])
    banner.moveOn()
    // Moving on from it is the composer's (`Composer.test.tsx`): the banner has no button.
    expect(banner.head().textContent).toContain(days.question)
    expect(banner.sent).toEqual([])
  })
})

describe('the number keys', () => {
  it('pick the row with that number when nothing is being typed', () => {
    const banner = raise([inbox])
    banner.key('2')
    expect(banner.row('Personal').getAttribute('aria-pressed')).toBe('true')
    banner.moveOn()
    expect(banner.sent).toEqual([[chosen('Personal')]])
  })

  it('are left alone in a field, with a modifier, and past the last row', () => {
    const banner = raise([inbox])
    const field = document.body.appendChild(document.createElement('textarea'))
    onTestFinished(() => field.remove())
    banner.key('1', field)
    banner.key('3')
    act(() => {
      document.body.dispatchEvent(
        new KeyboardEvent('keydown', { key: '1', ctrlKey: true, bubbles: true }),
      )
    })
    banner.moveOn()
    expect(banner.rows().map((row) => row.getAttribute('aria-pressed'))).toEqual(['false', 'false'])
    expect(banner.sent).toEqual([])
  })

  it('are not heard while the banner is closed, and are again once it is opened', () => {
    const banner = raise([inbox])
    act(() => banner.head().click())
    expect(banner.head().getAttribute('aria-expanded')).toBe('false')
    banner.key('1')
    banner.moveOn()
    expect(banner.sent).toEqual([])
    act(() => banner.head().click())
    banner.key('1')
    banner.moveOn()
    expect(banner.sent).toEqual([[chosen('Work')]])
  })
})
