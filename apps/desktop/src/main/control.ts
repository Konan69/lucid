import { BrowseResult, BrowserAction, DeviceAnswer, type DeviceRequest } from '@vivid/contracts'
import * as Clock from 'effect/Clock'
import * as Deferred from 'effect/Deferred'
import * as Duration from 'effect/Duration'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Ref from 'effect/Ref'
import * as Schema from 'effect/Schema'
import * as Semaphore from 'effect/Semaphore'
import {
  PagesRequest,
  PagesResponse,
  ShowingTab,
  type BrowserState,
  type PagesFailure,
  type Tab,
} from '../shared/pages.ts'
import { AddressDecision, decideAddress } from './address.ts'
import { keySequence } from './keys.ts'
import { AccessibilityTree, findControl, outline, type ControlUse } from './outline.ts'
import { InputSignal, type Touch } from './touch.ts'

/** The page the action was for is closed, or there is no page open to act on. */
export class PageGone extends Schema.TaggedError<PageGone>()(
  'PageGone',
  {},
  { title: 'The page is no longer open' },
) {}
/** The step was tried and did not work. `step` names it for the log; it never leaves the app. */
export class StepFailed extends Schema.TaggedError<StepFailed>()(
  'StepFailed',
  { step: Schema.String },
  { title: 'The step did not work' },
) {}
/** The desktop app will not go there: a local address, a file, or text that is not an address. */
export class StepNotAllowed extends Schema.TaggedError<StepNotAllowed>()(
  'StepNotAllowed',
  {},
  { title: 'The desktop app does not allow this' },
) {}
/** The desktop app has no way to do this, such as a key outside the ones Vivid may press. */
export class StepUnsupported extends Schema.TaggedError<StepUnsupported>()(
  'StepUnsupported',
  {},
  { title: 'The desktop app cannot do this' },
) {}
/** The Person pressed a key or a button on the page while Vivid was acting on it. */
class TakenOver extends Schema.TaggedError<TakenOver>()(
  'TakenOver',
  {},
  { title: 'The Person took the page back' },
) {}

type StepFailure = PageGone | StepFailed | StepNotAllowed | StepUnsupported

/** A value inside a debugger command: the plain data its protocol carries. */
type CommandValue =
  | string
  | number
  | boolean
  | ReadonlyArray<CommandValue>
  | { readonly [name: string]: CommandValue }
/** The parameters of one debugger command. */
export interface CommandParameters {
  readonly [name: string]: CommandValue
}

/** A picture of a page: a PNG in base64, and its size in pixels. */
export interface PagePicture {
  readonly png: string
  readonly width: number
  readonly height: number
}

/**
 * One open page under Vivid's control. The implementation attaches Chromium's debugger to the
 * page (`driver.ts`); here it is only what an action needs, so the actions can be tested without
 * a browser.
 */
export interface ControlledPage {
  readonly tab: Tab
  /** One debugger command. Rejection is `StepFailed`, or `PageGone` when the page has closed. */
  readonly send: (
    method: string,
    parameters: CommandParameters,
  ) => Effect.Effect<unknown, PageGone | StepFailed>
  /** Gives the page the keyboard. The effect it returns gives the keyboard back. */
  readonly focus: Effect.Effect<Effect.Effect<void>, PageGone>
  /** Takes a picture of the page as it is drawn now. */
  readonly capture: Effect.Effect<PagePicture, PageGone | StepFailed>
  /** Waits for a page that is loading to stop, for a bounded time; returns at once otherwise. */
  readonly settle: Effect.Effect<void>
}

/** The app's own Browser, as the executor uses it. */
export interface ControlledBrowser {
  readonly state: () => BrowserState
  readonly page: (tab: Tab) => Effect.Effect<ControlledPage, PageGone | StepFailed>
  /** The same closed set of page operations the Person's own tab row and toolbar use. */
  readonly request: (request: PagesRequest) => Effect.Effect<PagesResponse, PagesFailure>
}

export interface ControlDependencies {
  readonly browser: ControlledBrowser
  readonly touch: Touch
  readonly mac: boolean
  /** Says which page Vivid is acting on, so the page can show it; nothing when it is not. */
  readonly using: (tab: Option.Option<Tab>) => void
}

/**
 * How far one notch scrolls, in CSS pixels. Vivid's own value: the contract counts in wheel
 * notches and the reference scrolls by pixels its caller chose (`performAutomationScroll`).
 */
const NOTCH_PIXELS = 100
const SCROLL_UNITS = {
  up: { left: 0, top: -1 },
  down: { left: 0, top: 1 },
  left: { left: -1, top: 0 },
  right: { left: 1, top: 0 },
}

/** The scroll for a direction and a number of notches, as `window.scrollBy` takes it. */
export function scrollDelta(direction: keyof typeof SCROLL_UNITS, notches: number) {
  const unit = SCROLL_UNITS[direction]
  const distance = notches * NOTCH_PIXELS
  // `|| 0` keeps a zero from becoming negative zero, which would be written as "-0".
  return { left: unit.left * distance || 0, top: unit.top * distance || 0 }
}

/** Where an element is drawn: four corners, eight numbers, in CSS pixels of the viewport. */
const ContentQuads = Schema.Struct({
  quads: Schema.NonEmptyArray(
    Schema.Tuple([
      Schema.Number,
      Schema.Number,
      Schema.Number,
      Schema.Number,
      Schema.Number,
      Schema.Number,
      Schema.Number,
      Schema.Number,
    ]),
  ),
})
const ResolvedNode = Schema.Struct({ object: Schema.Struct({ objectId: Schema.String }) })
/** A value an expression returned; `exceptionDetails` present means it threw instead. */
const evaluated = <S extends Schema.Top>(value: S) =>
  Schema.Struct({
    result: Schema.Struct({ value }),
    exceptionDetails: Schema.optionalKey(Schema.Unknown),
  })
const decodeTree = Schema.decodeUnknownEffect(AccessibilityTree)
const decodeQuads = Schema.decodeUnknownEffect(ContentQuads)
const decodeNode = Schema.decodeUnknownEffect(ResolvedNode)
const decodeViewport = Schema.decodeUnknownEffect(
  evaluated(Schema.Struct({ width: Schema.Number, height: Schema.Number })),
)
const decodeTyped = Schema.decodeUnknownEffect(
  evaluated(Schema.Literals(['ok', 'notEditable', 'different'] as const)),
)
const decodeScrolled = Schema.decodeUnknownEffect(evaluated(Schema.Literal('ok')))

/** A debugger answer that is not the shape its command promises is a failed step, not a guess. */
const failing = (step: string) => Effect.mapError(() => new StepFailed({ step }))

/**
 * Replaces what an editable element holds with `text`, in the page, then reads it back.
 *
 * Ported from the reference's `typeIntoAutomationTarget` (`preview/Manager.ts`) with `clear` on:
 * the same editable test, the same focus, select-all and `insertText`, the same fallback when the
 * field will not empty, and the same `change` event. It edits in the page's own runtime because
 * the debugger's `Input.insertText` silently drops text on a page that is not in front
 * (`performAutomationType` says so). What Vivid changes: the element arrives as `this`, resolved
 * from its accessible name, where the reference finds it with a selector; and the value is read
 * back, as Vivid's own Computer does after typing, so text the page rejected is not reported as
 * typed.
 */
const TYPE_INTO_ELEMENT = `function (text) {
  const element = this;
  const textControl =
    element instanceof HTMLTextAreaElement ||
    (element instanceof HTMLInputElement &&
      !new Set(["button", "checkbox", "color", "file", "hidden", "image", "radio", "range", "reset", "submit"]).has(element.type));
  const editable = textControl || element.isContentEditable;
  if (!editable || element.disabled || element.readOnly) return "notEditable";
  element.focus();
  if (document.activeElement !== element) return "notEditable";
  if (textControl) {
    element.select();
  } else {
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = document.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }
  const held = () => (textControl ? element.value : (element.textContent ?? ""));
  let inserted = true;
  if (text.length > 0) {
    inserted = document.execCommand("insertText", false, text);
  } else {
    document.execCommand("delete", false);
    if (held().length > 0) {
      if (textControl) {
        const prototype = element instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;
        const valueSetter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
        if (valueSetter) valueSetter.call(element, "");
        else element.value = "";
      } else {
        element.replaceChildren();
      }
      element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward" }));
    }
  }
  if (!inserted) return "notEditable";
  element.dispatchEvent(new Event("change", { bubbles: true }));
  return held() === text ? "ok" : "different";
}`

/** Reads the page's accessibility tree into its outline and named controls. */
const read = Effect.fn('DesktopControl.read')(function* (page: ControlledPage) {
  const answer = yield* page.send('Accessibility.getFullAXTree', {})
  return outline(yield* decodeTree(answer).pipe(failing('outline')))
})

/** Finds the one control with these words that can be used this way, on the page as it is now. */
const locate = Effect.fn('DesktopControl.locate')(function* (
  page: ControlledPage,
  target: string,
  use: ControlUse,
) {
  const found = findControl((yield* read(page)).controls, target, use)
  if (Option.isNone(found)) return yield* new StepFailed({ step: 'target' })
  return found.value
})

/** The middle of where an element is drawn, refused when it lies outside what the page shows. */
const pointOf = Effect.fn('DesktopControl.pointOf')(function* (page: ControlledPage, node: number) {
  yield* page.send('DOM.scrollIntoViewIfNeeded', { backendNodeId: node })
  const drawn = yield* page.send('DOM.getContentQuads', { backendNodeId: node })
  const { quads } = yield* decodeQuads(drawn).pipe(failing('locate'))
  const [x1, y1, x2, y2, x3, y3, x4, y4] = quads[0]
  const point = { x: (x1 + x2 + x3 + x4) / 4, y: (y1 + y2 + y3 + y4) / 4 }
  const measured = yield* page.send('Runtime.evaluate', {
    expression: '({ width: window.innerWidth, height: window.innerHeight })',
    returnByValue: true,
  })
  const { width, height } = (yield* decodeViewport(measured).pipe(failing('viewport'))).result.value
  if (point.x < 0 || point.y < 0 || point.x > width || point.y > height)
    return yield* new StepFailed({ step: 'outside' })
  return point
})

/**
 * Clicks the control with these words.
 *
 * Ported from the reference's `performAutomationClick` and `resolveClickPoint`: accept input,
 * bring the element into view, take the middle of where it is drawn, refuse a point outside the
 * viewport, announce the press, then send the button down and up through the debugger. The press
 * is announced immediately before it is sent, and never sent twice.
 *
 * What Vivid changes: the element comes from its accessible name, so it is scrolled and measured
 * through its node handle (`DOM.scrollIntoViewIfNeeded`, `DOM.getContentQuads`) where the
 * reference runs a selector in the page; and the reference's two pauses that animate its own
 * drawn cursor are left out, because the desktop app draws no cursor.
 */
const click = Effect.fn('DesktopControl.click')(function* (
  page: ControlledPage,
  touch: Touch,
  target: string,
) {
  const control = yield* locate(page, target, 'click')
  yield* page.send('Input.setIgnoreInputEvents', { ignore: false })
  const point = yield* pointOf(page, control.node)
  touch.expect(
    InputSignal.cases.Pointer.make({ ...point, button: 'left' }),
    yield* Clock.currentTimeMillis,
  )
  const button = { ...point, button: 'left', clickCount: 1 }
  yield* page.send('Input.dispatchMouseEvent', { ...button, type: 'mousePressed' })
  yield* page.send('Input.dispatchMouseEvent', { ...button, type: 'mouseReleased' })
  return undefined
})

/** Replaces the text of the field with these words, and fails if the page did not take it. */
const type = Effect.fn('DesktopControl.type')(function* (
  page: ControlledPage,
  target: string,
  text: string,
) {
  const control = yield* locate(page, target, 'type')
  const resolved = yield* page.send('DOM.resolveNode', { backendNodeId: control.node })
  const node = yield* decodeNode(resolved).pipe(failing('resolve'))
  const answer = yield* page.send('Runtime.callFunctionOn', {
    objectId: node.object.objectId,
    functionDeclaration: TYPE_INTO_ELEMENT,
    arguments: [{ value: text }],
    returnByValue: true,
    userGesture: true,
  })
  const typed = yield* decodeTyped(answer).pipe(failing('type'))
  if (typed.exceptionDetails !== undefined || typed.result.value !== 'ok')
    return yield* new StepFailed({ step: 'type' })
  return undefined
})

/**
 * Presses one key on the page.
 *
 * Ported from the reference's `performAutomationPress`: give the page itself the keyboard (not
 * its window), bring it to the front for the debugger, turn on focus emulation, announce the
 * press, send the key down; then, whatever happened, send the key up if the key went down, turn
 * focus emulation off and give the keyboard back to whatever had it. The release runs even when
 * the Person takes over midway, or a key would stay held and the next page would act as focused.
 */
const press = Effect.fn('DesktopControl.press')(function* (
  page: ControlledPage,
  touch: Touch,
  key: string,
  mac: boolean,
) {
  const sequence = keySequence(key, { mac })
  if (Option.isNone(sequence)) return yield* new StepUnsupported({})
  const { keyDown, keyUp, signal } = sequence.value
  yield* page.send('Input.setIgnoreInputEvents', { ignore: false })
  let went = false
  let giveBack: Effect.Effect<void> = Effect.void
  const release = Effect.fn('DesktopControl.release')(function* () {
    if (went) yield* page.send('Input.dispatchKeyEvent', keyUp).pipe(Effect.ignore)
    yield* page.send('Emulation.setFocusEmulationEnabled', { enabled: false }).pipe(Effect.ignore)
    yield* giveBack
  })
  const down = Effect.fn('DesktopControl.keyDown')(function* () {
    giveBack = yield* page.focus
    yield* page.send('Page.bringToFront', {})
    yield* page.send('Emulation.setFocusEmulationEnabled', { enabled: true })
    touch.expect(signal, yield* Clock.currentTimeMillis)
    went = true
    yield* page.send('Input.dispatchKeyEvent', keyDown)
  })
  yield* down().pipe(Effect.ensuring(release()))
  return undefined
})

/** Scrolls the page itself, at once, as the reference's `performAutomationScroll` does. */
const scroll = Effect.fn('DesktopControl.scroll')(function* (
  page: ControlledPage,
  delta: ReturnType<typeof scrollDelta>,
) {
  const answer = yield* page.send('Runtime.evaluate', {
    expression: `(() => { window.scrollBy({ left: ${delta.left}, top: ${delta.top}, behavior: "instant" }); return "ok" })()`,
    returnByValue: true,
  })
  const scrolled = yield* decodeScrolled(answer).pipe(failing('scroll'))
  if (scrolled.exceptionDetails !== undefined) return yield* new StepFailed({ step: 'scroll' })
  return undefined
})

/** The tab that is in front, when there is one. */
const showing = (state: BrowserState): Option.Option<Tab> =>
  ShowingTab.match(state.showing, {
    None: () => Option.none(),
    Some: ({ value }) => Option.some(value),
  })

/** Everything one action works with: the app's parts, the last tab listing, and its own end. */
interface Acting extends ControlDependencies {
  /**
   * The tabs as the last answer listed them. `ShowTab` and `CloseTab` count in that order, so a
   * number is resolved against what Vivid was shown, never against an order that moved since.
   */
  readonly listed: Ref.Ref<Option.Option<ReadonlyArray<Tab>>>
  /** Done the moment the Person presses anything on the page being acted on. */
  readonly taken: Deferred.Deferred<void>
}

/** A page operation refused by the Browser, said in the executor's own terms. */
const ask = (acting: Acting, request: PagesRequest) =>
  acting.browser.request(request).pipe(
    Effect.catchTags({
      PageMissing: () => Effect.fail(new PageGone({})),
      PageAddressRefused: () => Effect.fail(new StepNotAllowed({})),
      PageUnavailable: () => Effect.fail(new StepFailed({ step: 'unavailable' })),
      PageLimitReached: () => Effect.fail(new StepFailed({ step: 'limit' })),
      PagePositionInvalid: () => Effect.fail(new StepFailed({ step: 'position' })),
      PageReopenEmpty: () => Effect.fail(new StepFailed({ step: 'reopen' })),
      PageStorageClearFailed: () => Effect.fail(new StepFailed({ step: 'storage' })),
      PageCacheClearFailed: () => Effect.fail(new StepFailed({ step: 'cache' })),
    }),
  )

/**
 * Takes hold of a page for this action: from here a press nobody announced ends the action, and
 * the page says Vivid is using it.
 */
const hold = Effect.fn('DesktopControl.hold')(function* (acting: Acting, tab: Tab) {
  const page = yield* acting.browser.page(tab)
  acting.touch.begin(tab, () => Deferred.doneUnsafe(acting.taken, Effect.void))
  acting.using(Option.some(tab))
  return page
})

/** The page in front, held. With no page open there is nothing to act on. */
const front = (acting: Acting) =>
  Option.match(showing(acting.browser.state()), {
    onNone: () => Effect.fail(new PageGone({})),
    onSome: (tab) => hold(acting, tab),
  })

/** Only a real web address is opened for Vivid. Words are not turned into a search. */
const destination = (address: string) => {
  const decision = decideAddress(address)
  return AddressDecision.guards.Navigate(decision)
    ? Effect.succeed(decision.address)
    : Effect.fail(new StepNotAllowed({}))
}

/** Opens a new page in front, holds it and lets it load. */
const openTab = Effect.fn('DesktopControl.openTab')(function* (acting: Acting, address: string) {
  const to = yield* destination(address)
  const opened = yield* ask(acting, PagesRequest.cases.Open.make({ address: to }))
  if (!PagesResponse.guards.Opened(opened)) return yield* new StepFailed({ step: 'open' })
  const page = yield* hold(acting, opened.tab)
  return yield* page.settle
})

/** Goes to an address in the page in front, or in a first page when none is open. */
const open = Effect.fn('DesktopControl.open')(function* (acting: Acting, address: string) {
  const to = yield* destination(address)
  const current = showing(acting.browser.state())
  if (Option.isNone(current)) return yield* openTab(acting, to)
  const page = yield* hold(acting, current.value)
  yield* ask(acting, PagesRequest.cases.Go.make({ tab: current.value, address: to }))
  return yield* page.settle
})

/** Goes back or forward in the page in front, then lets the page it lands on load. */
const travel = Effect.fn('DesktopControl.travel')(function* (
  acting: Acting,
  direction: 'Back' | 'Forward',
) {
  const page = yield* front(acting)
  yield* ask(acting, PagesRequest.cases[direction].make({ tab: page.tab }))
  return yield* page.settle
})

/** Shows or closes the tab a number names, in the order the last answer listed the tabs. */
const numbered = Effect.fn('DesktopControl.numbered')(function* (
  acting: Acting,
  position: number,
  operation: 'Show' | 'Close',
) {
  const tab = Option.flatMap(yield* Ref.get(acting.listed), (tabs) =>
    Option.fromUndefinedOr(tabs[position - 1]),
  )
  if (Option.isNone(tab)) return yield* new StepFailed({ step: 'tab' })
  yield* ask(acting, PagesRequest.cases[operation].make({ tab: tab.value }))
  return undefined
})

/** One step on the page in front. */
const onFront = <Failure>(
  acting: Acting,
  step: (page: ControlledPage) => Effect.Effect<void, Failure>,
) => Effect.flatMap(front(acting), step)

/** A step that takes no picture. */
const unseen = <Failure>(step: Effect.Effect<unknown, Failure>) =>
  Effect.as(step, Option.none<PagePicture>())

/**
 * One action, carried out. Exhaustive: a new kind of action does not compile until it is here.
 * Only `Screenshot` produces a picture; it is returned so the answer can carry it.
 */
const perform = (acting: Acting, action: BrowserAction) =>
  BrowserAction.match<Effect.Effect<Option.Option<PagePicture>, StepFailure>>(action, {
    Open: ({ address }) => unseen(open(acting, address)),
    Read: () => unseen(front(acting)),
    Click: ({ target }) => unseen(onFront(acting, (page) => click(page, acting.touch, target))),
    Type: ({ target, text }) => unseen(onFront(acting, (page) => type(page, target, text))),
    Press: ({ key }) =>
      unseen(onFront(acting, (page) => press(page, acting.touch, key, acting.mac))),
    Screenshot: () =>
      Effect.map(
        Effect.flatMap(front(acting), (page) => page.capture),
        Option.some,
      ),
    Scroll: ({ direction, notches }) =>
      unseen(onFront(acting, (page) => scroll(page, scrollDelta(direction, notches)))),
    Back: () => unseen(travel(acting, 'Back')),
    Forward: () => unseen(travel(acting, 'Forward')),
    // Held first, so touching the page ends the wait at once.
    Wait: ({ seconds }) => unseen(onFront(acting, () => Effect.sleep(Duration.seconds(seconds)))),
    OpenTab: ({ address }) => unseen(openTab(acting, address)),
    ShowTab: ({ tab }) => unseen(numbered(acting, tab, 'Show')),
    CloseTab: ({ tab }) => unseen(numbered(acting, tab, 'Close')),
  })

/** The words of the page in front once it has stopped loading, or that there is no page. */
const wordsOf = (page: Option.Option<ControlledPage>) =>
  Option.match(page, {
    // Closing the last page leaves nothing to read. The contract has no "no page" answer, so the
    // outline says so in words and the empty tab list is the proof.
    onNone: () => Effect.succeed({ text: 'No page is open.', truncated: false }),
    onSome: (held) => Effect.andThen(held.settle, read(held)),
  })

/**
 * The page in front after the action: where it is, what it is called, its outline and the tabs.
 * The same answer Vivid's own Computer gives (apps/server/src/computers/boat/browser.ts,
 * `browse`), read after the step so it describes what the step left behind.
 */
const describe = Effect.fn('DesktopControl.describe')(function* (
  acting: Acting,
  // The contract's `BrowseResult` has no field for a picture yet. The picture is taken, so a
  // page that cannot be captured still fails the step, and it arrives here ready to be attached:
  // when the field exists, it is set from this value in the `BrowseResult.make` below.
  _picture: Option.Option<PagePicture>,
) {
  const current = showing(acting.browser.state())
  const page = Option.isNone(current)
    ? Option.none<ControlledPage>()
    : Option.some(yield* hold(acting, current.value))
  const words = yield* wordsOf(page)
  // Read after settling: the address and title are the loaded page's, not the one it replaced.
  const state = acting.browser.state()
  yield* Ref.set(acting.listed, Option.some(state.tabs.map((tab) => tab.tab)))
  const shown = Option.flatMap(page, (held) =>
    Option.fromUndefinedOr(state.tabs.find((tab) => tab.tab === held.tab)),
  )
  return BrowseResult.make({
    address: Option.match(shown, { onNone: () => '', onSome: (tab) => tab.address }),
    title: Option.match(shown, { onNone: () => '', onSome: (tab) => tab.title }),
    outline: words.text,
    truncated: words.truncated,
    tabs: state.tabs.map((tab) => ({
      title: tab.title,
      address: tab.address,
      showing: Option.exists(shown, (inFront) => inFront.tab === tab.tab),
    })),
  })
})

/**
 * One action to its answer. Every way an action can end is one of the contract's answers: done
 * with the page as it now is, refused for a named reason, or failed. Input is never sent a second
 * time: a step that fails is answered as failed and Vivid decides what to do next.
 */
const act = Effect.fn('DesktopControl.act')(function* (acting: Acting, action: BrowserAction) {
  const done = perform(acting, action).pipe(Effect.flatMap((picture) => describe(acting, picture)))
  const stopped = Deferred.await(acting.taken).pipe(Effect.andThen(Effect.fail(new TakenOver({}))))
  return yield* Effect.raceFirst(done, stopped).pipe(
    Effect.map((result) => DeviceAnswer.cases.Done.make({ result })),
    Effect.catchTags({
      TakenOver: () => Effect.succeed(DeviceAnswer.cases.Refused.make({ reason: 'Stopped' })),
      PageGone: () => Effect.succeed(DeviceAnswer.cases.Refused.make({ reason: 'PageGone' })),
      StepNotAllowed: () =>
        Effect.succeed(DeviceAnswer.cases.Refused.make({ reason: 'NotAllowed' })),
      StepUnsupported: () =>
        Effect.succeed(DeviceAnswer.cases.Refused.make({ reason: 'Unsupported' })),
      StepFailed: () => Effect.succeed(DeviceAnswer.cases.Failed.make({})),
    }),
    Effect.ensuring(
      Effect.sync(() => {
        acting.touch.end()
        acting.using(Option.none())
      }),
    ),
  )
})

/**
 * Carries out the actions Vivid sends to this computer, one at a time, in the app's own Browser.
 *
 * The control session is the reference desktop's (`preview/Manager.ts`, `withControlSession` and
 * the automation functions it runs): attach the debugger, act through it, and stop the moment the
 * person touches the page. What Vivid changes is stated beside each step; the two that shape this
 * function are:
 * - One action at a time for the whole Browser, not per tab: a Person has one computer and Vivid
 *   one Run acting on it, and the server sends the next action only after this one is answered.
 * - Taking over ends the action at once through a race, where the reference compares a counter
 *   before and after each debugger command. A race also ends a wait, which has no command in it,
 *   and the release steps still run because they are finalizers.
 */
export const executor = Effect.fn('DesktopControl.make')(function* (
  dependencies: ControlDependencies,
) {
  const turn = yield* Semaphore.make(1)
  const listed = yield* Ref.make(Option.none<ReadonlyArray<Tab>>())

  /**
   * Carries out one request and returns its answer, or nothing when there is no longer anyone to
   * answer: the deadline had passed before its turn came, or passed while it was being carried
   * out. The server has already recorded such a request as unknown and ignores a late answer, so
   * an expired action is never started and a slow one is stopped rather than finished unseen.
   */
  const inTurn = Effect.fn('DesktopControl.inTurn')(function* (request: DeviceRequest) {
    const now = yield* Clock.currentTimeMillis
    if (now >= request.expiresAt) return Option.none<DeviceAnswer>()
    const taken = yield* Deferred.make<void>()
    return yield* act({ ...dependencies, listed, taken }, request.action).pipe(
      Effect.timeoutOption(Duration.millis(request.expiresAt - now)),
    )
  })

  return {
    execute: (request: DeviceRequest) => inTurn(request).pipe(Semaphore.withPermit(turn)),
  }
})
