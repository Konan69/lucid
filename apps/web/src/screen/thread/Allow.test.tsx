// @vitest-environment happy-dom
import {
  ActionTarget,
  ApprovalDecision,
  ApprovalId,
  ApprovalResponse,
  ApprovalState,
  ConnectionId,
  DecideApprovalRequest,
  DesktopAction,
  InputRequestId,
  InputRequestState,
  PersonId,
  ThreadId,
  type Approval,
  type InputRequest,
} from '@vivid/contracts'
import { it as effectIt } from '@effect/vitest'
import { Effect, Option, type Schema } from 'effect'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { open, wire } from '../../test/browser'

/**
 * The banner an Approval is decided in, decided the way a Person decides it: the real banner in
 * a real React root, its buttons and its menu given real clicks. What is claimed is what leaves
 * it (a decision, the one way out) and what its controls say they are, not how it is drawn:
 * where it sits, how its words wrap and where its buttons go in a narrow banner are CSS, which
 * this page (`happy-dom`) does not lay out.
 *
 * Three seams are driven, each for what only it can show:
 * - `Allowed` with what a Thread keeps for it held by the test (`Allowing`): which decision each
 *   control hands on, and when nothing can be pressed.
 * - `decidingAfter`, the one step every end of a call goes through.
 * - `useAsks` and `Asks` as the Thread's column mounts them, with the real hooks: which banner
 *   is up when an Approval and a question both wait, and what a press puts on the socket.
 *
 * The app's data modules open the live socket as they load, so the socket's other end is the
 * fixture's (`test/browser.ts`). That fixture also puts a bare page in the DOM's place, which
 * React cannot draw into, so the DOM's own page is put back before the first module of the app
 * is imported (as `Composer.test.tsx` does).
 */

/** The page as the DOM made it: each name `open` replaces with a bare stand-in of its own. */
const page = {
  window: globalThis.window,
  document: globalThis.document,
  location: globalThis.location,
  history: globalThis.history,
  addEventListener: globalThis.addEventListener,
  matchMedia: globalThis.matchMedia,
  localStorage: globalThis.localStorage,
}
const browser = open()
for (const [name, own] of Object.entries(page)) vi.stubGlobal(name, own)
// React flushes what `act` wraps only where the page says it is being tested.
vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)

const { Allowed, Asks, Deciding, decidingAfter, Hold, Tried, useAsks } = await import('./Allow')
type Allowing = import('./Allow').Allowing

const me = { id: PersonId.make('me'), name: 'Ada', image: null }
const bola = { id: PersonId.make('bola'), name: 'Bola', image: null }

const gmail = ActionTarget.cases.Connection.make({
  connectionId: ConnectionId.make('connection'),
  account: 'Gmail (Work)',
  tool: 'send_email',
  input: { to: 'dami@example.com', subject: 'The signed NDA' },
})

/** An Approval waiting on this Person, with whatever a test says differently about it. */
const waitingOn = (
  id: string,
  action: Partial<Approval['action']> = {},
  askedOf: Approval['askedOf'] = me,
): Approval => ({
  id: ApprovalId.make(id),
  threadId: ThreadId.make('thread'),
  runId: null,
  action: {
    summary: 'Send the signed NDA to Dami',
    rationale: 'You asked me to get it to her today.',
    effect: 'destructive',
    target: gmail,
    ...action,
  },
  digest: `digest of ${id}`,
  askedOf,
  state: ApprovalState.cases.Pending.make({ expiresAt: 10 }),
  createdAt: 1,
})

/** The same Approval once this Person has allowed it and it is being done. */
const allowed = (approval: Approval): Approval => ({
  id: approval.id,
  threadId: approval.threadId,
  runId: approval.runId,
  action: approval.action,
  digest: approval.digest,
  askedOf: approval.askedOf,
  state: ApprovalState.cases.Executing.make({ decidedBy: me, decidedAt: 2 }),
  createdAt: approval.createdAt,
})

const question: InputRequest = {
  id: InputRequestId.make('request'),
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
      allowsOwnAnswer: false,
    },
  ],
  askedOf: me,
  state: InputRequestState.cases.Waiting.make({}),
  createdAt: 1,
}

/** A React root on the page, taken off it when the test ends, whether or not it passed. */
function mount() {
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  onTestFinished(() => {
    act(() => root.unmount())
    container.remove()
  })
  return { container, root }
}

const APPROVAL = '[data-asks="approval"]'

/** The ways a test reaches a banner drawn in `container`. The menu is drawn on the page. */
function reach(container: HTMLElement) {
  const button = (name: string) => {
    const found = Array.from(container.querySelectorAll('button')).find(
      (one) => one.getAttribute('aria-label') === name || one.textContent === name,
    )
    if (found === undefined) throw new Error(`The banner drew no button named ${name}.`)
    return found
  }
  /** One named part of the banner, which a test that reads it expects to be there. */
  const part = (name: string) => {
    const found = container.querySelector<HTMLElement>(`[data-asked="${name}"]`)
    if (found === null) throw new Error(`The banner has no ${name}.`)
    return found
  }
  /** The first thing the banner's column drew that matches, which a test expects to be there. */
  const drawn = (what: string, selector: string) => {
    const found = container.querySelector<HTMLElement>(selector)
    if (found === null) throw new Error(`There is no ${what}.`)
    return found
  }
  // A menu that has been shut stays on the page while it fades out, marked as closed, and this
  // page never ends a fade. So the items a Person can reach are those of a menu not so marked.
  const items = () =>
    Array.from(
      document.querySelectorAll<HTMLElement>('[role="menu"]:not([data-closed]) [role="menuitem"]'),
    )
  /** Every item on the page, those of a menu that is fading out included. */
  const lingering = () => Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]'))
  return {
    button,
    part,
    /** Whether the banner has a named part at all. */
    has: (name: string) => container.querySelector(`[data-asked="${name}"]`) !== null,
    items,
    lingering,
    /** Whether the banner of an Approval is up. */
    approval: () => container.querySelector(APPROVAL) !== null,
    /** Whether the banner of a question is up. */
    question: () => container.querySelector('[aria-label="Vivid\'s question"]') !== null,
    /** Everything the banner of the Approval says, in the order it says it. */
    says: () => drawn('banner of an Approval', APPROVAL).textContent,
    /** The box that holds exactly what would be done, open or not. */
    exactly: () => drawn('box of details', '[aria-label="Exactly what Vivid would do"]'),
    /** What is said over the banner when a decision did not go through. */
    alert: () => drawn('refusal', '[role="alert"]').textContent,
    press: (name: string) => act(() => button(name).click()),
    /** Opens the menu behind the ellipsis, as a pointer does. */
    more: () => act(() => button('More ways to answer').click()),
    /** Presses an item of the open menu. */
    choose: (name: string) =>
      act(() => {
        const item = items().find((one) => one.textContent === name)
        if (item === undefined) throw new Error(`The menu has no item named ${name}.`)
        item.click()
      }),
    /** The banner's fold has ended, which a page with no layout never says by itself. */
    folded: () =>
      act(() => {
        drawn('banner over the composer', '.asked-attachment').dispatchEvent(
          new Event('transitionend', { bubbles: true }),
        )
      }),
  }
}

/** What a Thread keeps for the banner (`useAllowing`), as a test says it stands. */
interface Standing {
  readonly approval: Approval
  readonly waiting: number
  readonly leaving: boolean
  readonly sending: boolean
  readonly refusal: Option.Option<string>
}

/**
 * Draws the banner of one Approval with what a Thread keeps for it held by the test, and
 * answers every decision the banner hands on.
 */
function raise(approval: Approval, standing: Partial<Standing> = {}) {
  const decided: Array<ApprovalDecision> = []
  const { container, root } = mount()
  const draw = (changed: Partial<Standing>) => {
    const now: Standing = {
      approval,
      waiting: 1,
      leaving: false,
      sending: false,
      refusal: Option.none(),
      ...standing,
      ...changed,
    }
    const up = { approval: now.approval, waiting: now.waiting }
    const allowing: Allowing = {
      hold: now.leaving ? Hold.Leaving({ up }) : Hold.Up({ up }),
      sending: () => now.sending,
      refusalOf: () => now.refusal,
      decide: (_approval, decision) => {
        decided.push(decision)
      },
      release: () => undefined,
    }
    act(() => root.render(<Allowed allowing={allowing} />))
  }
  draw({})
  return { decided, draw, ...reach(container) }
}

describe('the three answers', () => {
  it('hands on "allow this once" from Allow', () => {
    const banner = raise(waitingOn('one'))
    banner.press('Allow')
    expect(banner.decided).toEqual([ApprovalDecision.cases.AllowOnce.make({})])
  })

  it('hands on a refusal from Don’t allow', () => {
    const banner = raise(waitingOn('one'))
    banner.press('Don’t allow')
    expect(banner.decided).toEqual([ApprovalDecision.cases.Deny.make({})])
  })

  it('keeps Always allow in the menu behind the ellipsis, and hands it on from there', () => {
    const banner = raise(waitingOn('one'))
    expect(banner.items()).toEqual([])
    banner.more()
    expect(banner.items().map((item) => item.textContent)).toEqual(['Always allow'])
    banner.choose('Always allow')
    expect(banner.decided).toEqual([ApprovalDecision.cases.AlwaysAllow.make({})])
  })

  it('cannot be pressed while a decision is on its way', () => {
    const banner = raise(waitingOn('one'), { sending: true })
    const controls = ['Don’t allow', 'Allow', 'More ways to answer'].map(banner.button)
    expect(controls.map((control) => control.disabled)).toEqual([true, true, true])
    for (const control of controls) act(() => control.click())
    expect(banner.items()).toEqual([])
    expect(banner.decided).toEqual([])
  })

  it('shuts the menu, and sends nothing from it, when the Approval is settled meanwhile', () => {
    const banner = raise(waitingOn('one'))
    banner.more()
    expect(banner.items()).toHaveLength(1)
    banner.draw({ leaving: true })
    expect(banner.items()).toEqual([])
    // A press that lands on the item while the menu fades out is not a decision.
    for (const item of banner.lingering()) act(() => item.click())
    expect(banner.decided).toEqual([])
  })
})

describe('what the banner says', () => {
  it('says what kind of action it is, the account it uses, and what Vivid would do', () => {
    const banner = raise(waitingOn('one'))
    expect(banner.part('effect').textContent).toBe('Sends, deletes or pays')
    expect(banner.part('account').textContent).toBe('Gmail (Work)')
    expect(banner.part('summary').textContent).toBe('Send the signed NDA to Dami')
  })

  it('names no account for a step on the Computer', () => {
    const banner = raise(
      waitingOn('one', {
        target: ActionTarget.cases.Desktop.make({ action: DesktopAction.cases.Look.make({}) }),
      }),
    )
    expect(banner.has('account')).toBe(false)
  })

  it('counts the Approvals waiting only when there is more than one', () => {
    expect(raise(waitingOn('one'), { waiting: 1 }).has('count')).toBe(false)
    expect(raise(waitingOn('one'), { waiting: 12 }).part('count').textContent).toBe('1/12')
  })

  it('keeps a sentence with nowhere to break whole, and lets it choose its own direction', () => {
    const unbroken = 'https://example.com/'.padEnd(300, 'a')
    const banner = raise(waitingOn('one', { summary: unbroken }))
    expect(banner.part('summary').textContent).toBe(unbroken)
    // What reads right to left starts at the right in a banner that reads left to right.
    const arabic = raise(waitingOn('two', { summary: 'أرسل الاتفاقية الموقعة إلى دامي' }))
    expect(arabic.part('summary').getAttribute('dir')).toBe('auto')
  })

  it('says a long account name in full where exactly what is sent is read', () => {
    const account = 'Gmail '.padEnd(80, 'x')
    const banner = raise(
      waitingOn('one', {
        target: ActionTarget.cases.Connection.make({ ...gmail, account }),
      }),
    )
    const details = banner.button('Details')
    const box = banner.exactly()
    expect(details.getAttribute('aria-expanded')).toBe('false')
    expect(details.getAttribute('aria-controls')).toBe(box.id)
    expect(box.hidden).toBe(true)
    banner.press('Details')
    expect(details.getAttribute('aria-expanded')).toBe('true')
    expect(box.hidden).toBe(false)
    expect(box.textContent).toContain(account)
    expect(box.textContent).toContain('dami@example.com')
  })

  it('says a decision that did not go through over the banner, not in it', () => {
    const words = 'This was already decided, or it changed. Look again.'
    const banner = raise(waitingOn('one'), { refusal: Option.some(words) })
    expect(banner.alert()).toBe(words)
    expect(banner.says()).not.toContain(words)
  })

  it('says nothing but the action: no reason, and no standing sentences', () => {
    const banner = raise(waitingOn('one'))
    expect(banner.says()).toBe(
      'Sends, deletes or paysGmail (Work)Send the signed NDA to DamiDetails' +
        'Gmail (Work) · Send emailTodami@example.comSubjectThe signed NDA' +
        'Don’t allowAllow',
    )
  })
})

describe('the end of a try at deciding', () => {
  const first = { attempt: 1, id: ApprovalId.make('one') }
  const second = { attempt: 2, id: ApprovalId.make('two') }

  it('is a refusal when the try is still the one on its way', () => {
    const sending = decidingAfter(Deciding.Still(), Tried.Began({ tried: first }))
    expect(decidingAfter(sending, Tried.Failed({ tried: first }))).toEqual(
      Deciding.Refused({ tried: first }),
    )
  })

  it('does not wake, or refuse, the Approval a later try is deciding', () => {
    const later = [Tried.Began({ tried: first }), Tried.Began({ tried: second })].reduce(
      decidingAfter,
      Deciding.Still(),
    )
    expect(decidingAfter(later, Tried.Failed({ tried: first }))).toEqual(
      Deciding.Sending({ tried: second }),
    )
  })
})

/**
 * Everything Vivid asks of this Person, mounted as the Thread's column mounts it, with the real
 * hooks. Beside the banner it says whether the composer has a question to move on from, which
 * is what the column hands the composer's footer (`useOnward`, `Thread.tsx`).
 */
function Column({
  approvals,
  requests,
}: {
  approvals: ReadonlyArray<Approval>
  requests: ReadonlyArray<InputRequest>
}) {
  const { allowing, asked } = useAsks(approvals, requests, me.id)
  return (
    <div data-question={Option.isSome(asked.progress) ? 'up' : 'none'}>
      <Asks allowing={allowing} asked={asked} />
    </div>
  )
}

/** Draws the column for what waits in a Thread, and draws it again when that changes. */
function thread(approvals: ReadonlyArray<Approval>, requests: ReadonlyArray<InputRequest>) {
  const { container, root } = mount()
  const draw = (now: ReadonlyArray<Approval>, asked: ReadonlyArray<InputRequest>) =>
    act(() => root.render(<Column approvals={now} requests={asked} />))
  draw(approvals, requests)
  return {
    draw,
    /** Whether the composer's button would move on from a question. */
    composer: () => container.querySelector('[data-question="up"]') !== null,
    ...reach(container),
  }
}

describe('an Approval and a question both waiting', () => {
  it('shows the Approval, not the question, and leaves the composer an ordinary one', () => {
    const column = thread([waitingOn('one')], [question])
    expect(column.approval()).toBe(true)
    expect(column.question()).toBe(false)
    expect(column.composer()).toBe(false)
  })

  it('raises the question once the Approval is settled and its banner has gone', () => {
    const approval = waitingOn('one')
    const column = thread([approval], [question])
    column.draw([allowed(approval)], [question])
    // Still folding away: the question waits for the banner to have gone.
    expect(column.question()).toBe(false)
    column.folded()
    expect(column.approval()).toBe(false)
    expect(column.question()).toBe(true)
    expect(column.composer()).toBe(true)
  })

  it('takes the place of a question that was up, once that banner has gone', () => {
    const column = thread([], [question])
    expect(column.question()).toBe(true)
    column.draw([waitingOn('one')], [question])
    expect(column.approval()).toBe(false)
    expect(column.composer()).toBe(false)
    column.folded()
    expect(column.question()).toBe(false)
    expect(column.approval()).toBe(true)
  })

  it('brings the question back when the Approval is settled before its banner was drawn', () => {
    const approval = waitingOn('one')
    const column = thread([], [question])
    column.draw([approval], [question])
    column.draw([allowed(approval)], [question])
    expect(column.approval()).toBe(false)
    expect(column.question()).toBe(true)
    expect(column.composer()).toBe(true)
    // The place over the composer is free again: the next Approval is not kept out of it.
    column.draw([allowed(approval), waitingOn('two')], [question])
    column.folded()
    expect(column.approval()).toBe(true)
  })

  it('does not show an Approval that waits on somebody else', () => {
    const column = thread([waitingOn('one', {}, bola)], [question])
    expect(column.approval()).toBe(false)
    expect(column.question()).toBe(true)
  })

  it('raises the next Approval after the first, counted anew', () => {
    const [first, second] = [waitingOn('one'), waitingOn('two', { summary: 'Delete the draft' })]
    const column = thread([first, second], [])
    expect(column.part('count').textContent).toBe('1/2')
    column.draw([allowed(first), second], [])
    column.folded()
    expect(column.part('summary').textContent).toBe('Delete the draft')
    expect(column.has('count')).toBe(false)
  })
})

/**
 * Waits until the server has heard one kind of call, answers it, and gives what the call
 * carried. The wait ends on the call itself, whenever the page gets round to making it.
 */
const hears = (tag: string, answer: Schema.Json) =>
  Effect.callback<Schema.Json>((resume) => {
    browser.server.answers(tag, (payload) => {
      resume(Effect.succeed(payload))
      return answer
    })
  })

describe('a press, as the server hears it', () => {
  effectIt.live('decides exactly the record that was shown, once', () =>
    Effect.gen(function* () {
      const approval = waitingOn('heard')
      const column = thread([approval], [])
      column.press('Allow')
      // From the press, before the server has said anything: a second press is not a second
      // decision.
      expect(column.button('Allow').disabled).toBe(true)
      act(() => column.button('Allow').click())
      const carried = yield* hears(
        'DecideApproval',
        wire(ApprovalResponse, { approval: allowed(approval) }),
      )
      expect(carried).toEqual(
        wire(DecideApprovalRequest, {
          id: approval.id,
          digest: approval.digest,
          decision: ApprovalDecision.cases.AllowOnce.make({}),
        }),
      )
      expect(browser.server.asked('DecideApproval')).toHaveLength(1)
    }),
  )
})
