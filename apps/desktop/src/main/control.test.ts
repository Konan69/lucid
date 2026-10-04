import { describe, expect, it } from '@effect/vitest'
import {
  BrowserAction,
  DeviceAnswer,
  DeviceRequest,
  DeviceRequestId,
  RunId,
  ThreadId,
} from '@vivid/contracts'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as Option from 'effect/Option'
import * as TestClock from 'effect/testing/TestClock'
import {
  BrowserState,
  Page,
  PageFavicon,
  PageLoadFailure,
  PageMissing,
  PagesRequest,
  PagesResponse,
  ShowingTab,
  Tab,
  UsedTab,
} from '../shared/pages.ts'
import {
  PageGone,
  StepFailed,
  executor,
  scrollDelta,
  type CommandParameters,
  type ControlledBrowser,
} from './control.ts'

const first = Tab.make('7b0c7f0a-6c0e-4f61-9a55-0d8f6f1f2a10')
const second = Tab.make('1d1b7c1e-9a55-4c0e-8f61-2a100d8f6f1f')

const pageOf = (tab: Tab, title: string) =>
  Page.make({
    tab,
    address: `https://example.com/${title.toLowerCase()}`,
    title,
    favicon: PageFavicon.cases.None.make({}),
    loading: false,
    canGoBack: false,
    canGoForward: false,
    failed: PageLoadFailure.cases.None.make({}),
  })

const text = (value: string) => ({ type: 'string', value })
/** A page with one button and one field, as the debugger's accessibility domain describes it. */
const tree = {
  nodes: [
    { nodeId: '1', role: text('RootWebArea'), name: text('Inbox'), childIds: ['2', '3'] },
    { nodeId: '2', role: text('button'), name: text('Send'), parentId: '1', backendDOMNodeId: 20 },
    {
      nodeId: '3',
      role: text('textbox'),
      name: text('To'),
      value: text('ada@example.com'),
      parentId: '1',
      backendDOMNodeId: 30,
    },
  ],
}

/** What the debugger answers, per command, for a page drawn at (100, 40) to (140, 60). */
const answers = new Map<string, unknown>([
  ['DOM.getDocument', { root: { nodeId: 1 } }],
  ['DOM.querySelectorAll', { nodeIds: [] }],
  ['DOM.describeNode', { node: { backendNodeId: 30 } }],
  ['Accessibility.getFullAXTree', tree],
  ['DOM.getContentQuads', { quads: [[100, 40, 140, 40, 140, 60, 100, 60]] }],
  ['Runtime.evaluate', { result: { value: { width: 800, height: 600 } } }],
  ['DOM.resolveNode', { object: { objectId: 'object-30' } }],
  ['Runtime.callFunctionOn', { result: { value: 'ok' } }],
])

interface Sent {
  readonly method: string
  readonly parameters: CommandParameters
}

/**
 * A Browser that records what the executor asks of it. `during` runs inside a named command, which
 * is how a test presses Stop, or fails a command, at an exact moment of an action.
 */
function fixture(options: {
  readonly tabs: ReadonlyArray<Page>
  readonly during?: (sent: Sent, stop: (tab: Tab) => void) => Effect.Effect<void, StepFailed>
  readonly mayOpen?: (address: string) => boolean
  readonly answers?: ReadonlyMap<string, unknown>
}) {
  const sent: Array<Sent> = []
  const asked: Array<PagesRequest> = []
  const visited: Array<string> = []
  const used: Array<Option.Option<Tab>> = []
  const refusals = new Set<Tab>()
  let stop: (tab: Tab) => void = () => {}
  let focus = 'app'
  let state = BrowserState.make({
    revision: 0,
    tabs: options.tabs,
    showing: Option.match(Option.fromUndefinedOr(options.tabs[0]), {
      onNone: () => ShowingTab.cases.None.make({}),
      onSome: (page) => ShowingTab.cases.Some.make({ value: page.tab }),
    }),
    using: UsedTab.cases.None.make({}),
  })
  const show = (tab: Tab) => {
    state = BrowserState.make({ ...state, showing: ShowingTab.cases.Some.make({ value: tab }) })
  }
  const answer = (method: string) =>
    options.answers !== undefined && options.answers.has(method)
      ? options.answers.get(method)
      : answers.get(method)
  const browser: ControlledBrowser = {
    state: () => state,
    page: (tab) =>
      state.tabs.some((page) => page.tab === tab)
        ? Effect.succeed({
            tab,
            send: (method, parameters) =>
              Effect.gen(function* () {
                sent.push({ method, parameters })
                if (options.during !== undefined)
                  yield* options.during({ method, parameters }, stop)
                return answer(method)
              }),
            focus: Effect.sync(() => {
              focus = 'page'
              return Effect.sync(() => {
                focus = 'app'
              })
            }),
            capture: Effect.succeed({ png: 'cG5n', width: 800, height: 600 }),
            settle: Effect.void,
          })
        : Effect.fail(new PageGone({})),
    request: (request) => {
      asked.push(request)
      if (PagesRequest.guards.Show(request)) {
        if (!state.tabs.some((page) => page.tab === request.tab))
          return Effect.fail(new PageMissing({ tab: request.tab }))
        show(request.tab)
      }
      return Effect.succeed(PagesResponse.cases.Done.make({}))
    },
    visit: (tab, address) =>
      Effect.sync(() => {
        visited.push(address)
        return Option.getOrElse(tab, () => {
          state = BrowserState.make({ ...state, tabs: [...state.tabs, pageOf(opened, 'New')] })
          show(opened)
          return opened
        })
      }),
    refused: (tab) => refusals.delete(tab),
  }
  return {
    sent,
    asked,
    visited,
    used,
    refusals,
    methods: () => sent.map((command) => command.method),
    /** The pointer and key events sent, by their `type`, in order. */
    input: () =>
      sent.flatMap((command) =>
        command.method.startsWith('Input.dispatch') ? [command.parameters['type']] : [],
      ),
    focus: () => focus,
    control: Effect.map(
      executor({
        browser,
        mac: false,
        using: (tab) => used.push(tab),
        mayOpen: (address) =>
          Effect.succeed(options.mayOpen === undefined ? true : options.mayOpen(address)),
      }),
      (control) => {
        stop = control.stop
        return control
      },
    ),
  }
}

const opened = Tab.make('9c2d1f3a-5b7e-4a1c-8d2f-3e4a5b6c7d8e')

const request = (action: BrowserAction, expiresAt = 30_000) =>
  DeviceRequest.make({
    id: DeviceRequestId.make('3f0e2f52-6d0f-4c0f-9a34-6f6b3c0f8a11'),
    threadId: ThreadId.make('thread-1'),
    runId: RunId.make('run-1'),
    action,
    expiresAt,
  })

const refused = (reason: 'Stopped' | 'PageGone' | 'NotAllowed' | 'Unsupported') =>
  Option.some(DeviceAnswer.cases.Refused.make({ reason }))
const failed = Option.some(DeviceAnswer.cases.Failed.make({}))
const click = request(BrowserAction.cases.Click.make({ target: 'Send' }))
/** Presses Stop on the page at the moment a command of this kind is sent, and never answers it. */
const stopAt =
  (type: string) =>
  (sent: Sent, stop: (tab: Tab) => void): Effect.Effect<void, StepFailed> =>
    sent.parameters['type'] === type || sent.method === type
      ? Effect.sync(() => stop(first)).pipe(Effect.andThen(Effect.never))
      : Effect.void

describe('carrying out one action on this computer', () => {
  it.effect('reading answers with the page in front, its outline and the tabs', () =>
    Effect.gen(function* () {
      const page = fixture({ tabs: [pageOf(first, 'Inbox'), pageOf(second, 'Docs')] })
      const control = yield* page.control
      const answer = yield* control.execute(request(BrowserAction.cases.Read.make({})))
      expect(answer).toEqual(
        Option.some(
          DeviceAnswer.cases.Done.make({
            result: {
              address: 'https://example.com/inbox',
              title: 'Inbox',
              outline: 'button "Send"\ntextbox "To" = "ada@example.com"',
              truncated: false,
              tabs: [
                { title: 'Inbox', address: 'https://example.com/inbox', showing: true },
                { title: 'Docs', address: 'https://example.com/docs', showing: false },
              ],
            },
          }),
        ),
      )
      // The page said Vivid was using it for the length of the action, and not after.
      expect(page.used[0]).toEqual(Option.some(first))
      expect(page.used.at(-1)).toEqual(Option.none())
    }),
  )

  it.effect('a screenshot answers with the picture; no other action carries one', () =>
    Effect.gen(function* () {
      const control = yield* fixture({ tabs: [pageOf(first, 'Inbox')] }).control
      const pictureOf = (answer: Option.Option<DeviceAnswer>) =>
        Option.flatMap(answer, (given) =>
          DeviceAnswer.guards.Done(given)
            ? Option.some(Option.fromUndefinedOr(given.result.picture))
            : Option.none(),
        )
      const shot = yield* control.execute(request(BrowserAction.cases.Screenshot.make({})))
      expect(pictureOf(shot)).toEqual(Option.some(Option.some('cG5n')))
      const read = yield* control.execute(request(BrowserAction.cases.Read.make({})))
      expect(pictureOf(read)).toEqual(Option.some(Option.none()))
    }),
  )

  it.effect('what a password field holds is never in the answer', () =>
    Effect.gen(function* () {
      const page = fixture({
        tabs: [pageOf(first, 'Inbox')],
        // The document says the field Chromium calls node 30 is a password field.
        answers: new Map([['DOM.querySelectorAll', { nodeIds: [7] }]]),
      })
      const control = yield* page.control
      const answer = yield* control.execute(request(BrowserAction.cases.Read.make({})))
      expect(
        Option.exists(
          answer,
          (given) =>
            DeviceAnswer.guards.Done(given) &&
            given.result.outline === 'button "Send"\ntextbox "To" = "(hidden)"',
        ),
      ).toBe(true)
    }),
  )

  it.effect('a click is sent once, at the middle of the control, down then up', () =>
    Effect.gen(function* () {
      const page = fixture({ tabs: [pageOf(first, 'Inbox')] })
      const control = yield* page.control
      const answer = yield* control.execute(
        request(BrowserAction.cases.Click.make({ target: 'send' })),
      )
      expect(Option.exists(answer, DeviceAnswer.guards.Done)).toBe(true)
      expect(page.input()).toEqual(['mousePressed', 'mouseReleased'])
      expect(
        page.sent.find((command) => command.parameters['type'] === 'mousePressed'),
      ).toMatchObject({ parameters: { x: 120, y: 50, button: 'left', clickCount: 1 } })
    }),
  )

  it.effect('Stop ends the action at once: nothing further is sent', () =>
    Effect.gen(function* () {
      const page = fixture({
        tabs: [pageOf(first, 'Inbox')],
        during: stopAt('DOM.getContentQuads'),
      })
      const control = yield* page.control
      expect(yield* control.execute(click)).toEqual(refused('Stopped'))
      expect(page.input()).toEqual([])
      expect(page.used.at(-1)).toEqual(Option.none())
    }),
  )

  it.effect('a click stopped with the button down still lets the button up', () =>
    Effect.gen(function* () {
      const page = fixture({ tabs: [pageOf(first, 'Inbox')], during: stopAt('mousePressed') })
      const control = yield* page.control
      expect(yield* control.execute(click)).toEqual(refused('Stopped'))
      expect(page.input()).toEqual(['mousePressed', 'mouseReleased'])
    }),
  )

  it.effect('a press that fails to arrive is failed, released, and never sent again', () =>
    Effect.gen(function* () {
      const page = fixture({
        tabs: [pageOf(first, 'Inbox')],
        during: (sent) =>
          sent.parameters['type'] === 'mousePressed'
            ? Effect.fail(new StepFailed({ step: 'command' }))
            : Effect.void,
      })
      const control = yield* page.control
      expect(yield* control.execute(click)).toEqual(failed)
      expect(page.input()).toEqual(['mousePressed', 'mouseReleased'])
    }),
  )

  it.effect('a key stopped mid-press is still released and the keyboard given back', () =>
    Effect.gen(function* () {
      const page = fixture({ tabs: [pageOf(first, 'Inbox')], during: stopAt('keyDown') })
      const control = yield* page.control
      const answer = yield* control.execute(
        request(BrowserAction.cases.Press.make({ key: 'Enter' })),
      )
      expect(answer).toEqual(refused('Stopped'))
      expect(page.sent.slice(-2)).toMatchObject([
        { method: 'Input.dispatchKeyEvent', parameters: { type: 'keyUp', key: 'Enter' } },
        { method: 'Emulation.setFocusEmulationEnabled', parameters: { enabled: false } },
      ])
      expect(page.focus()).toBe('app')
    }),
  )

  it.effect(
    'an action interrupted from outside, as when the link ends, releases what it held',
    () =>
      Effect.gen(function* () {
        const reached = yield* Deferred.make<void>()
        const page = fixture({
          tabs: [pageOf(first, 'Inbox')],
          during: (sent) =>
            sent.parameters['type'] === 'mousePressed'
              ? Deferred.succeed(reached, undefined).pipe(Effect.andThen(Effect.never))
              : Effect.void,
        })
        const control = yield* page.control
        const acting = yield* Effect.forkChild(control.execute(click))
        yield* Deferred.await(reached)
        yield* Fiber.interrupt(acting)
        expect(page.input()).toEqual(['mousePressed', 'mouseReleased'])
        expect(page.used.at(-1)).toEqual(Option.none())
        // The turn was given back: the next action runs.
        const next = yield* control.execute(
          request(BrowserAction.cases.Wait.make({ seconds: 1 }), 0),
        )
        expect(next).toEqual(Option.none())
      }),
  )

  it.effect('typing replaces the field through its node and fails on anything else', () =>
    Effect.gen(function* () {
      const page = fixture({ tabs: [pageOf(first, 'Inbox')] })
      const control = yield* page.control
      const answer = yield* control.execute(
        request(BrowserAction.cases.Type.make({ target: 'To', text: 'ada@example.com' })),
      )
      expect(Option.exists(answer, DeviceAnswer.guards.Done)).toBe(true)
      expect(page.sent.find((command) => command.method === 'DOM.resolveNode')).toMatchObject({
        parameters: { backendNodeId: 30 },
      })
      expect(
        page.sent.find((command) => command.method === 'Runtime.callFunctionOn'),
      ).toMatchObject({
        parameters: { objectId: 'object-30', arguments: [{ value: 'ada@example.com' }] },
      })
      // A button is not something to type into: nothing is sent to the page for it.
      const wrong = yield* control.execute(
        request(BrowserAction.cases.Type.make({ target: 'Send', text: 'x' })),
      )
      expect(wrong).toEqual(failed)
    }),
  )

  it.effect('the page keeping other text than was typed is a failed step', () =>
    Effect.gen(function* () {
      const page = fixture({
        tabs: [pageOf(first, 'Inbox')],
        answers: new Map([['Runtime.callFunctionOn', { result: { value: 'different' } }]]),
      })
      const control = yield* page.control
      const answer = yield* control.execute(
        request(BrowserAction.cases.Type.make({ target: 'To', text: 'ada' })),
      )
      expect(answer).toEqual(failed)
    }),
  )

  it.effect('Vivid opens only real web addresses on the public internet', () =>
    Effect.gen(function* () {
      const page = fixture({
        tabs: [pageOf(first, 'Inbox')],
        mayOpen: (address) => !address.includes('192.168.') && !address.includes('intranet'),
      })
      const control = yield* page.control
      const open = (address: string) =>
        control.execute(request(BrowserAction.cases.Open.make({ address })))
      const openTab = (address: string) =>
        control.execute(request(BrowserAction.cases.OpenTab.make({ address })))
      expect(yield* open('http://localhost:3000')).toEqual(refused('NotAllowed'))
      expect(yield* open('http://192.168.1.1/admin')).toEqual(refused('NotAllowed'))
      // A public-looking name that resolves to the Person's network is refused the same way.
      expect(yield* openTab('https://intranet.example/')).toEqual(refused('NotAllowed'))
      expect(yield* openTab('cute cats')).toEqual(refused('NotAllowed'))
      expect(page.visited).toEqual([])
      expect(Option.exists(yield* open('https://example.com/'), DeviceAnswer.guards.Done)).toBe(
        true,
      )
      expect(page.visited).toEqual(['https://example.com/'])
    }),
  )

  it.effect('a redirect the Browser refused is answered as not allowed, not as the page', () =>
    Effect.gen(function* () {
      const page = fixture({ tabs: [pageOf(first, 'Inbox')] })
      const control = yield* page.control
      // The first address was public; a later hop led to the Person's network and was cancelled.
      page.refusals.add(first)
      const answer = yield* control.execute(
        request(BrowserAction.cases.Open.make({ address: 'https://example.com/' })),
      )
      expect(answer).toEqual(refused('NotAllowed'))
    }),
  )

  it.effect('a key outside the ones Vivid may press is unsupported, and nothing is pressed', () =>
    Effect.gen(function* () {
      const page = fixture({ tabs: [pageOf(first, 'Inbox')] })
      const control = yield* page.control
      const answer = yield* control.execute(
        request(BrowserAction.cases.Press.make({ key: 'Control+w' })),
      )
      expect(answer).toEqual(refused('Unsupported'))
      expect(page.input()).toEqual([])
    }),
  )

  it.effect('with no page open there is nothing to act on', () =>
    Effect.gen(function* () {
      const control = yield* fixture({ tabs: [] }).control
      expect(yield* control.execute(request(BrowserAction.cases.Read.make({})))).toEqual(
        refused('PageGone'),
      )
    }),
  )

  it.effect('a tab number means the tab the last answer listed there', () =>
    Effect.gen(function* () {
      const page = fixture({ tabs: [pageOf(first, 'Inbox'), pageOf(second, 'Docs')] })
      const control = yield* page.control
      const show = request(BrowserAction.cases.ShowTab.make({ tab: 2 }))
      // Nothing has been listed yet, so a number names nothing.
      expect(yield* control.execute(show)).toEqual(failed)
      yield* control.execute(request(BrowserAction.cases.Read.make({})))
      const answer = yield* control.execute(show)
      expect(page.asked).toEqual([PagesRequest.cases.Show.make({ tab: second })])
      expect(
        Option.exists(
          answer,
          (given) => DeviceAnswer.guards.Done(given) && given.result.title === 'Docs',
        ),
      ).toBe(true)
    }),
  )

  it.effect('an action past its deadline is not started, and a slow one is not finished', () =>
    Effect.gen(function* () {
      const page = fixture({ tabs: [pageOf(first, 'Inbox')] })
      const control = yield* page.control
      expect(yield* control.execute(request(BrowserAction.cases.Read.make({}), 0))).toEqual(
        Option.none(),
      )
      expect(page.sent).toEqual([])
      const waiting = yield* Effect.forkChild(
        control.execute(request(BrowserAction.cases.Wait.make({ seconds: 10 }), 5_000)),
      )
      yield* TestClock.adjust('5 seconds')
      expect(yield* Fiber.join(waiting)).toEqual(Option.none())
      expect(page.used.at(-1)).toEqual(Option.none())
    }),
  )

  it.effect('Stop ends a wait at once; Stop on a page Vivid is not using does nothing', () =>
    Effect.gen(function* () {
      const page = fixture({ tabs: [pageOf(first, 'Inbox'), pageOf(second, 'Docs')] })
      const control = yield* page.control
      const waiting = yield* Effect.forkChild(
        control.execute(request(BrowserAction.cases.Wait.make({ seconds: 10 }))),
      )
      yield* TestClock.adjust('1 second')
      control.stop(second)
      yield* TestClock.adjust('1 second')
      expect(waiting.pollUnsafe()).toBeUndefined()
      control.stop(first)
      expect(yield* Fiber.join(waiting)).toEqual(refused('Stopped'))
      // With nothing running, Stop has nothing to end and the next action is untouched.
      control.stop(first)
      const next = yield* control.execute(request(BrowserAction.cases.Read.make({})))
      expect(Option.exists(next, DeviceAnswer.guards.Done)).toBe(true)
    }),
  )

  it('a notch is a hundred pixels the way the wheel turns', () => {
    expect(scrollDelta('down', 3)).toEqual({ left: 0, top: 300 })
    expect(scrollDelta('up', 1)).toEqual({ left: 0, top: -100 })
    expect(scrollDelta('left', 2)).toEqual({ left: -200, top: 0 })
  })
})
