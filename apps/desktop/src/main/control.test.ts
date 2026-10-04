import { describe, expect, it } from '@effect/vitest'
import {
  BrowserAction,
  DeviceAnswer,
  DeviceRequest,
  DeviceRequestId,
  RunId,
  ThreadId,
} from '@vivid/contracts'
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
} from '../shared/pages.ts'
import {
  PageGone,
  StepFailed,
  executor,
  scrollDelta,
  type CommandParameters,
  type ControlledBrowser,
} from './control.ts'
import { InputSignal, Touch } from './touch.ts'

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
    { nodeId: '3', role: text('textbox'), name: text('To'), parentId: '1', backendDOMNodeId: 30 },
  ],
}

/** What the debugger answers, per command, for a page drawn at (100, 40) to (140, 60). */
const answers = new Map<string, unknown>([
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
 * is how a test puts the Person's hand on the page at an exact moment of an action.
 */
function fixture(options: {
  readonly tabs: ReadonlyArray<Page>
  readonly during?: (sent: Sent, touch: Touch) => Effect.Effect<void, StepFailed>
}) {
  const touch = new Touch()
  const sent: Array<Sent> = []
  const asked: Array<PagesRequest> = []
  const used: Array<Option.Option<Tab>> = []
  let focus = 'app'
  let state = BrowserState.make({
    revision: 0,
    tabs: options.tabs,
    showing: Option.match(Option.fromUndefinedOr(options.tabs[0]), {
      onNone: () => ShowingTab.cases.None.make({}),
      onSome: (page) => ShowingTab.cases.Some.make({ value: page.tab }),
    }),
    using: ShowingTab.cases.None.make({}),
  })
  const show = (tab: Tab) => {
    state = BrowserState.make({ ...state, showing: ShowingTab.cases.Some.make({ value: tab }) })
  }
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
                  yield* options.during({ method, parameters }, touch)
                return answers.get(method)
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
  }
  return {
    touch,
    sent,
    asked,
    used,
    methods: () => sent.map((command) => command.method),
    focus: () => focus,
    control: executor({ browser, touch, mac: false, using: (tab) => used.push(tab) }),
  }
}

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
              outline: 'button "Send"\ntextbox "To"',
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

  it.effect(
    'a click is announced, sent once at the middle of the control, and is Vivid’s own',
    () =>
      Effect.gen(function* () {
        const owners: Array<string> = []
        const page = fixture({
          tabs: [pageOf(first, 'Inbox')],
          during: (sent, touch) =>
            Effect.sync(() => {
              if (sent.parameters['type'] === 'mousePressed')
                owners.push(
                  touch.judge(
                    first,
                    InputSignal.cases.Pointer.make({ x: 120, y: 50, button: 'left' }),
                    0,
                  ),
                )
            }),
        })
        const control = yield* page.control
        const answer = yield* control.execute(
          request(BrowserAction.cases.Click.make({ target: 'send' })),
        )
        expect(Option.exists(answer, DeviceAnswer.guards.Done)).toBe(true)
        expect(owners).toEqual(['Vivid'])
        expect(page.methods().slice(0, 7)).toEqual([
          'Accessibility.getFullAXTree',
          'Input.setIgnoreInputEvents',
          'DOM.scrollIntoViewIfNeeded',
          'DOM.getContentQuads',
          'Runtime.evaluate',
          'Input.dispatchMouseEvent',
          'Input.dispatchMouseEvent',
        ])
        expect(page.sent[5]).toMatchObject({
          parameters: { type: 'mousePressed', x: 120, y: 50, button: 'left', clickCount: 1 },
        })
        expect(page.sent[6]).toMatchObject({ parameters: { type: 'mouseReleased', x: 120, y: 50 } })
      }),
  )

  it.effect('the Person touching the page stops the action before any press is sent', () =>
    Effect.gen(function* () {
      const page = fixture({
        tabs: [pageOf(first, 'Inbox')],
        during: (sent, touch) =>
          sent.method === 'DOM.getContentQuads'
            ? Effect.sync(() => {
                touch.judge(first, InputSignal.cases.Key.make({ key: 'a', code: 'KeyA' }), 0)
              }).pipe(Effect.andThen(Effect.never))
            : Effect.void,
      })
      const control = yield* page.control
      const answer = yield* control.execute(
        request(BrowserAction.cases.Click.make({ target: 'Send' })),
      )
      expect(answer).toEqual(refused('Stopped'))
      expect(page.methods()).not.toContain('Input.dispatchMouseEvent')
      expect(page.used.at(-1)).toEqual(Option.none())
    }),
  )

  it.effect('a press that fails to arrive is answered as failed and never sent again', () =>
    Effect.gen(function* () {
      const page = fixture({
        tabs: [pageOf(first, 'Inbox')],
        during: (sent) =>
          sent.parameters['type'] === 'mousePressed'
            ? Effect.fail(new StepFailed({ step: 'command' }))
            : Effect.void,
      })
      const control = yield* page.control
      const answer = yield* control.execute(
        request(BrowserAction.cases.Click.make({ target: 'Send' })),
      )
      expect(answer).toEqual(Option.some(DeviceAnswer.cases.Failed.make({})))
      expect(page.methods().filter((method) => method === 'Input.dispatchMouseEvent')).toHaveLength(
        1,
      )
    }),
  )

  it.effect('a key taken over mid-press is still released and the keyboard given back', () =>
    Effect.gen(function* () {
      const page = fixture({
        tabs: [pageOf(first, 'Inbox')],
        during: (sent, touch) =>
          sent.parameters['type'] === 'keyDown'
            ? Effect.sync(() => {
                touch.judge(first, InputSignal.cases.Key.make({ key: 'x', code: 'KeyX' }), 0)
              }).pipe(Effect.andThen(Effect.never))
            : Effect.void,
      })
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
    'typing replaces the field through its node and fails when the page kept other text',
    () =>
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
        expect(wrong).toEqual(Option.some(DeviceAnswer.cases.Failed.make({})))
      }),
  )

  it.effect(
    'what the desktop app will not or cannot do is refused by name, with nothing sent',
    () =>
      Effect.gen(function* () {
        const page = fixture({ tabs: [pageOf(first, 'Inbox')] })
        const control = yield* page.control
        const answer = (action: BrowserAction) => control.execute(request(action))
        expect(
          yield* answer(BrowserAction.cases.Open.make({ address: 'http://localhost:3000' })),
        ).toEqual(refused('NotAllowed'))
        expect(yield* answer(BrowserAction.cases.OpenTab.make({ address: 'cute cats' }))).toEqual(
          refused('NotAllowed'),
        )
        expect(yield* answer(BrowserAction.cases.Press.make({ key: 'Control+w' }))).toEqual(
          refused('Unsupported'),
        )
        expect(page.asked).toEqual([])
        expect(page.methods()).not.toContain('Input.dispatchKeyEvent')
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
      expect(yield* control.execute(show)).toEqual(Option.some(DeviceAnswer.cases.Failed.make({})))
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

  it.effect(
    'an action whose deadline has passed is not started, and a slow one is not finished',
    () =>
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

  it.effect('touching the page ends a wait at once', () =>
    Effect.gen(function* () {
      const page = fixture({ tabs: [pageOf(first, 'Inbox')] })
      const control = yield* page.control
      const waiting = yield* Effect.forkChild(
        control.execute(request(BrowserAction.cases.Wait.make({ seconds: 10 }))),
      )
      yield* TestClock.adjust('1 second')
      page.touch.judge(first, InputSignal.cases.Pointer.make({ x: 1, y: 1, button: 'left' }), 1_000)
      expect(yield* Fiber.join(waiting)).toEqual(refused('Stopped'))
    }),
  )

  it('a notch is a hundred pixels the way the wheel turns', () => {
    expect(scrollDelta('down', 3)).toEqual({ left: 0, top: 300 })
    expect(scrollDelta('up', 1)).toEqual({ left: 0, top: -100 })
    expect(scrollDelta('left', 2)).toEqual({ left: -200, top: 0 })
  })
})
