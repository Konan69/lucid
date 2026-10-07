import { BrowseResult, BrowserAction, DeviceAnswer, type BrowserPicture } from '@vivid/contracts'
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
/** The Person pressed Stop on the page Vivid was using, or the link to Vivid ended. */
class Stopped extends Schema.TaggedError<Stopped>()(
  'Stopped',
  {},
  { title: 'The Person stopped the action' },
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

/** A picture of a page: a PNG in base64 as the contract carries it, and its size in pixels. */
export interface PagePicture {
  readonly png: BrowserPicture
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
  /**
   * Gives the page the keyboard, which needs the page drawn on the window; a page that is not
   * drawn in time is a failed step. The effect it returns gives the keyboard back.
   */
  readonly focus: Effect.Effect<Effect.Effect<void>, PageGone | StepFailed>
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
  /**
   * Goes to an address for Vivid, in this page or in a new one, and answers with the page. Unlike
   * the Person's own navigation, every hop of it is checked against `mayOpen`.
   */
  readonly visit: (tab: Option.Option<Tab>, address: string) => Effect.Effect<Tab, PagesFailure>
  /** Whether a navigation on this page was refused since this was last asked. Asking clears it. */
  readonly refused: (tab: Tab) => boolean
}

export interface ControlDependencies {
  readonly browser: ControlledBrowser
  readonly mac: boolean
  /** Says which page Vivid is acting on, so the page can show it; nothing when it is not. */
  readonly using: (tab: Option.Option<Tab>) => void
  /** Whether Vivid may open this address from the Person's computer (`reach.ts`). */
  readonly mayOpen: (address: string) => Effect.Effect<boolean>
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
      Schema.Finite,
      Schema.Finite,
      Schema.Finite,
      Schema.Finite,
      Schema.Finite,
      Schema.Finite,
      Schema.Finite,
      Schema.Finite,
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
  evaluated(Schema.Struct({ width: Schema.Finite, height: Schema.Finite })),
)
const decodeTyped = Schema.decodeUnknownEffect(
  evaluated(Schema.Literals(['ok', 'notEditable', 'different'] as const)),
)
const decodeScrolled = Schema.decodeUnknownEffect(evaluated(Schema.Literal('ok')))
const decodeWitness = Schema.decodeUnknownEffect(
  evaluated(Schema.Literals(['seen', 'unseen'] as const)),
)
const decodeDocument = Schema.decodeUnknownEffect(
  Schema.Struct({ root: Schema.Struct({ nodeId: Schema.Int }) }),
)
const decodeFound = Schema.decodeUnknownEffect(Schema.Struct({ nodeIds: Schema.Array(Schema.Int) }))
const decodeDescribed = Schema.decodeUnknownEffect(
  Schema.Struct({ node: Schema.Struct({ backendNodeId: Schema.Int }) }),
)

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

/**
 * The password fields of the page, by Chromium's handle. The accessibility tree does not say
 * that a field is a password, so the document is asked directly. If it cannot be asked, the page
 * is not read at all: an outline is never returned without this.
 *
 * It finds `input type=password` in the main document. A password field inside a frame or a
 * shadow root is not found by this query; Chromium already masks what such a field holds in the
 * accessibility tree, and that masking is the only protection there.
 */
const secretFields = Effect.fn('DesktopControl.secretFields')(function* (page: ControlledPage) {
  const document = yield* page.send('DOM.getDocument', { depth: 0 })
  const { root } = yield* decodeDocument(document).pipe(failing('document'))
  const found = yield* page.send('DOM.querySelectorAll', {
    nodeId: root.nodeId,
    selector: 'input[type="password" i]',
  })
  const { nodeIds } = yield* decodeFound(found).pipe(failing('secrets'))
  const fields = yield* Effect.forEach(nodeIds, (nodeId) =>
    page
      .send('DOM.describeNode', { nodeId })
      .pipe(Effect.flatMap((described) => decodeDescribed(described).pipe(failing('secret')))),
  )
  return new Set(fields.map((field) => field.node.backendNodeId))
})

/**
 * Reads the page's accessibility tree into its outline and named controls. What a password field
 * holds is never in it: the outline says "(hidden)" in its place.
 */
const read = Effect.fn('DesktopControl.read')(function* (page: ControlledPage) {
  const secrets = yield* secretFields(page)
  const answer = yield* page.send('Accessibility.getFullAXTree', {})
  return outline(yield* decodeTree(answer).pipe(failing('outline')), secrets)
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

/**
 * Resolves in the page once its document has focus, or after two seconds without it. Turning
 * focus emulation on is answered before the page has it; a key sent in between is dropped.
 * Found by running against real pages, where the first key after a page loaded never arrived.
 */
const HAS_FOCUS = `new Promise((resolve) => {
  if (document.hasFocus()) return resolve("focused")
  window.addEventListener("focus", () => resolve("focused"), { once: true })
  setTimeout(() => resolve("late"), 2000)
})`

/** How long a press that has not been seen is waited for before it is called undelivered. */
const LATE_MILLIS = 500

/** Where the page keeps its note of having seen Vivid's press; a symbol, so no page script meets it. */
const noteOf = (event: 'keydown' | 'mousedown') => `window[Symbol.for("vivid.saw.${event}")]`

/**
 * Asks the page to note the next key or button it sees go down. Sent before the press, and the
 * answer awaited: that round trip is also what lets the focus given to the page arrive before
 * the key does. Found by running against real pages: without it the key-down was dropped and
 * only the key-up arrived.
 */
const arm = Effect.fn('DesktopControl.arm')(function* (
  page: ControlledPage,
  event: 'keydown' | 'mousedown',
) {
  const answer = yield* page.send('Runtime.evaluate', {
    expression: `(() => { ${noteOf(event)} = false; window.addEventListener("${event}", () => { ${noteOf(event)} = true }, { capture: true, once: true }); return "ok" })()`,
    returnByValue: true,
  })
  yield* decodeScrolled(answer).pipe(failing('arm'))
})

/**
 * Whether the press reached the page. Chromium accepts input for a page and can still drop it
 * (a page that is not drawn takes no keys, for one), and the command succeeds either way; found
 * by running against real pages, where a press was answered as done and the page had seen
 * nothing. So the page is asked. It saw the press, or its note is gone because the press took it
 * to another document: both mean delivered. The note still there and unset means the press never
 * arrived, and that is a failed step, said as one, never a second press.
 *
 * A press can reach the page after the command that sent it has been answered; found the same
 * way, when a key was called undelivered and the page had it a moment later. Saying "failed" for
 * a press that arrived invites a second one, so an unseen press is given `LATE_MILLIS` to turn
 * up before it is called undelivered. A press seen at once costs no wait.
 */
const witnessed = Effect.fn('DesktopControl.witnessed')(function* (
  page: ControlledPage,
  event: 'keydown' | 'mousedown',
) {
  const answer = yield* page
    .send('Runtime.evaluate', {
      expression: `new Promise((resolve) => {
        if (${noteOf(event)} !== false) return resolve("seen")
        window.addEventListener("${event}", () => resolve("seen"), { capture: true, once: true })
        setTimeout(() => resolve(${noteOf(event)} === false ? "unseen" : "seen"), ${LATE_MILLIS})
      })`,
      awaitPromise: true,
      returnByValue: true,
    })
    .pipe(
      Effect.flatMap((given) => decodeWitness(given).pipe(failing('witness'))),
      // A page that is already leaving refuses the question; it left because of the press.
      Effect.catchTag('StepFailed', () => Effect.succeed({ result: { value: 'seen' as const } })),
    )
  if (answer.result.value === 'unseen') return yield* new StepFailed({ step: 'undelivered' })
  return undefined
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
 * viewport, then send the button down and up through the debugger. The press is never sent twice.
 *
 * What Vivid changes:
 * - The element comes from its accessible name, so it is scrolled and measured through its node
 *   handle (`DOM.scrollIntoViewIfNeeded`, `DOM.getContentQuads`) where the reference runs a
 *   selector in the page.
 * - The button is released by a finalizer registered before it goes down, as a key is in `press`.
 *   The reference sends down and up one after the other, so a stop, a deadline or a failed
 *   command between the two leaves the button held; here the release runs however the click ends.
 * - The reference's two pauses that animate its own drawn cursor are left out: the desktop app
 *   draws no cursor.
 * - Focus emulation around the press, confirmed by the page before the button goes down and
 *   turned off again by the same finalizer. The reference's guest is always laid out in its
 *   window; Vivid's page may not be drawn at all.
 */
const click = Effect.fn('DesktopControl.click')(function* (page: ControlledPage, target: string) {
  const control = yield* locate(page, target, 'click')
  yield* page.send('Input.setIgnoreInputEvents', { ignore: false })
  let went = false
  let button = { x: 0, y: 0, button: 'left', clickCount: 1 }
  const release = Effect.fn('DesktopControl.buttonUp')(function* () {
    if (went)
      yield* page
        .send('Input.dispatchMouseEvent', { ...button, type: 'mouseReleased' })
        .pipe(Effect.ignore)
    yield* page.send('Emulation.setFocusEmulationEnabled', { enabled: false }).pipe(Effect.ignore)
  })
  const down = Effect.fn('DesktopControl.buttonDown')(function* () {
    // Found by running against real pages: Chromium drops pointer input to a page that is not
    // being drawn (the panel closed, or showing Vivid's computer), and the click was answered as
    // done while nothing happened. A page takes the press when its view is on the window (the
    // Browser puts every page there, hidden) and focus emulation is on and has reached the
    // page. Nothing is shown and the keyboard is not taken: a click must not move the Person's
    // typing away from where they are.
    yield* page.send('Emulation.setFocusEmulationEnabled', { enabled: true })
    yield* page.send('Runtime.evaluate', { expression: HAS_FOCUS, awaitPromise: true })
    button = { ...button, ...(yield* pointOf(page, control.node)) }
    yield* arm(page, 'mousedown')
    went = true
    yield* page.send('Input.dispatchMouseEvent', { ...button, type: 'mousePressed' })
    yield* witnessed(page, 'mousedown')
  })
  yield* down().pipe(Effect.ensuring(release()))
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
 * its window), turn on focus emulation, send the key down; then, whatever happened, send the key
 * up if the key went down, turn focus emulation off and give the keyboard back to whatever had
 * it. The release runs even when the action is stopped midway, or a key would stay held and the
 * next page would act as focused.
 *
 * What Vivid changes, each found by running against real pages:
 * - A key is pressed only on a page that is drawn on the window (`focus` waits for that, and
 *   fails the step with nothing sent otherwise). Keys to a page that is not drawn were delivered
 *   unreliably, and sometimes after the action had been answered.
 * - No `Page.bringToFront`. With it, the key that followed was dropped.
 * - The page confirms it has focus after emulation is turned on, before the key is sent.
 * - The page is asked whether it saw the key (`witnessed`); a key that never arrived is a failed
 *   step, where the reference reports success.
 */
const press = Effect.fn('DesktopControl.press')(function* (
  page: ControlledPage,
  key: string,
  mac: boolean,
) {
  const sequence = keySequence(key, { mac })
  if (Option.isNone(sequence)) return yield* new StepUnsupported({})
  const { keyDown, keyUp } = sequence.value
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
    yield* page.send('Emulation.setFocusEmulationEnabled', { enabled: true })
    yield* page.send('Runtime.evaluate', { expression: HAS_FOCUS, awaitPromise: true })
    yield* arm(page, 'keydown')
    went = true
    yield* page.send('Input.dispatchKeyEvent', keyDown)
    yield* witnessed(page, 'keydown')
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

/** The action that is running: the page it holds, once it holds one, and how to end it. */
interface Running {
  held: Option.Option<Tab>
  readonly stopped: Deferred.Deferred<void>
}

/** Everything one action works with: the app's parts, the last tab listing, and its own end. */
interface Acting extends ControlDependencies {
  /**
   * The tabs as the last answer listed them. `ShowTab` and `CloseTab` count in that order, so a
   * number is resolved against what Vivid was shown, never against an order that moved since.
   */
  readonly listed: Ref.Ref<Option.Option<ReadonlyArray<Tab>>>
  readonly running: Running
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
 * Takes hold of a page for this action: from here the page says Vivid is using it, and its Stop
 * button ends this action.
 */
const hold = Effect.fn('DesktopControl.hold')(function* (acting: Acting, tab: Tab) {
  const page = yield* acting.browser.page(tab)
  acting.running.held = Option.some(tab)
  acting.using(Option.some(tab))
  return page
})

/** The page in front, held. With no page open there is nothing to act on. */
const front = (acting: Acting) =>
  Option.match(showing(acting.browser.state()), {
    onNone: () => Effect.fail(new PageGone({})),
    onSome: (tab) => hold(acting, tab),
  })

/**
 * Only a real web address on the public internet is opened for Vivid. Words are not turned into
 * a search, and this computer and its network are out of reach (`reach.ts`).
 */
const destination = Effect.fn('DesktopControl.destination')(function* (
  acting: Acting,
  address: string,
) {
  const decision = decideAddress(address)
  if (!AddressDecision.guards.Navigate(decision)) return yield* new StepNotAllowed({})
  if (!(yield* acting.mayOpen(decision.address))) return yield* new StepNotAllowed({})
  return decision.address
})

/** A navigation the Browser refused, said in the executor's own terms. */
const visit = (acting: Acting, tab: Option.Option<Tab>, address: string) =>
  acting.browser.visit(tab, address).pipe(
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

/** Goes to an address in this page or a new one, holds the page and lets it load. */
const go = Effect.fn('DesktopControl.go')(function* (
  acting: Acting,
  tab: Option.Option<Tab>,
  address: string,
) {
  const to = yield* destination(acting, address)
  const page = yield* hold(acting, yield* visit(acting, tab, to))
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
    // In the page in front, or in a first page when none is open.
    Open: ({ address }) => unseen(go(acting, showing(acting.browser.state()), address)),
    Read: () => unseen(front(acting)),
    Click: ({ target }) => unseen(onFront(acting, (page) => click(page, target))),
    Type: ({ target, text }) => unseen(onFront(acting, (page) => type(page, target, text))),
    Press: ({ key }) => unseen(onFront(acting, (page) => press(page, key, acting.mac))),
    Screenshot: () => Effect.flatMap(front(acting), (page) => page.capture).pipe(Effect.asSome),
    Scroll: ({ direction, notches }) =>
      unseen(onFront(acting, (page) => scroll(page, scrollDelta(direction, notches)))),
    Back: () => unseen(travel(acting, 'Back')),
    Forward: () => unseen(travel(acting, 'Forward')),
    // Held first, so the page shows its Stop button for the length of the wait.
    Wait: ({ seconds }) => unseen(onFront(acting, () => Effect.sleep(Duration.seconds(seconds)))),
    OpenTab: ({ address }) => unseen(go(acting, Option.none(), address)),
    ShowTab: ({ tab }) => unseen(numbered(acting, tab, 'Show')),
    CloseTab: ({ tab }) => unseen(numbered(acting, tab, 'Close')),
  })

/** The tabs as an answer lists them, with the one in front marked. */
const tabsOf = (state: BrowserState, inFront: Option.Option<Tab>) =>
  state.tabs.map((tab) => ({
    title: tab.title,
    address: tab.address,
    showing: Option.exists(inFront, (shown) => shown === tab.tab),
  }))

/**
 * The answer when the action left no page open, which only closing the last one does. The
 * contract's `BrowseResult` has no form for "no page": its address and title are required text.
 * They are empty here because there is no address and no title, the outline says so in words,
 * and the empty tab list is the proof. A contract variant for this would remove the empty text.
 */
const nothingOpen = () =>
  BrowseResult.make({
    address: '',
    title: '',
    outline: 'No page is open.',
    truncated: false,
    tabs: [],
  })

/**
 * The page in front after the action: where it is, what it is called, its outline and the tabs.
 * The same answer Vivid's own Computer gives (apps/server/src/computers/boat/browser.ts,
 * `browse`), read after the step so it describes what the step left behind.
 *
 * A navigation the Browser refused during the action (a redirect to this computer or its
 * network) is `StepNotAllowed`, not a description of the page it was refused on. A page that
 * closed while it was being read is `PageGone`: nothing is described from memory.
 */
const describe = Effect.fn('DesktopControl.describe')(function* (
  acting: Acting,
  // The picture a `Screenshot` took. Only that action has one; the contract's `picture` key is
  // absent for every other answer rather than present and empty.
  picture: Option.Option<PagePicture>,
) {
  const current = showing(acting.browser.state())
  if (Option.isNone(current)) {
    yield* Ref.set(acting.listed, Option.some([]))
    return nothingOpen()
  }
  const page = yield* hold(acting, current.value)
  yield* page.settle
  if (acting.browser.refused(page.tab)) return yield* new StepNotAllowed({})
  const words = yield* read(page)
  // Read after settling: the address and title are the loaded page's, not the one it replaced.
  const state = acting.browser.state()
  const shown = state.tabs.find((tab) => tab.tab === page.tab)
  if (shown === undefined) return yield* new PageGone({})
  yield* Ref.set(acting.listed, Option.some(state.tabs.map((tab) => tab.tab)))
  const described = {
    address: shown.address,
    title: shown.title,
    outline: words.text,
    truncated: words.truncated,
    tabs: tabsOf(state, Option.some(shown.tab)),
  }
  return Option.match(picture, {
    onNone: () => BrowseResult.make(described),
    // The contract carries the PNG alone, as base64; its size stays on this computer.
    onSome: (taken) => BrowseResult.make({ ...described, picture: taken.png }),
  })
})

/**
 * One action to its answer. Every way an action can end is one of the contract's answers: done
 * with the page as it now is, refused for a named reason, or failed. Input is never sent a second
 * time: a step that fails is answered as failed and Vivid decides what to do next.
 */
const act = Effect.fn('DesktopControl.act')(function* (acting: Acting, action: BrowserAction) {
  const done = perform(acting, action).pipe(Effect.flatMap((picture) => describe(acting, picture)))
  const stopped = Deferred.await(acting.running.stopped).pipe(
    Effect.andThen(Effect.fail(new Stopped({}))),
  )
  return yield* Effect.raceFirst(done, stopped).pipe(
    Effect.map((result) => DeviceAnswer.cases.Done.make({ result })),
    Effect.catchTags({
      Stopped: () => Effect.succeed(DeviceAnswer.cases.Refused.make({ reason: 'Stopped' })),
      PageGone: () => Effect.succeed(DeviceAnswer.cases.Refused.make({ reason: 'PageGone' })),
      StepNotAllowed: () =>
        Effect.succeed(DeviceAnswer.cases.Refused.make({ reason: 'NotAllowed' })),
      StepUnsupported: () =>
        Effect.succeed(DeviceAnswer.cases.Refused.make({ reason: 'Unsupported' })),
      // The contract's `Failed` says nothing more, on purpose; which step failed is kept in
      // this computer's own log, where the Person or a developer can read it.
      StepFailed: ({ step }) =>
        Effect.logWarning(`desktop: Vivid's ${action._tag} failed at ${step}`).pipe(
          Effect.as(DeviceAnswer.cases.Failed.make({})),
        ),
    }),
  )
})

/** One step in a page, as the link hands it over: the action and when its authority ends. */
export interface PageWork {
  readonly action: BrowserAction
  readonly expiresAt: number
}

/**
 * Carries out the actions Vivid sends to this computer, one at a time, in the app's own Browser.
 *
 * The control session is the reference desktop's (`preview/Manager.ts`, `withControlSession` and
 * the automation functions it runs): attach the debugger and act through it. What Vivid changes
 * is stated beside each step; the ones that shape this function are:
 * - One action at a time for the whole Browser, not per tab: a Person has one computer and Vivid
 *   one Run acting on it, and the server sends the next action only after this one is answered.
 * - The reference's human-control epochs and expected-input matching (`controlEpochRef`,
 *   `expectAgentInput`, `consumeExpectedAgentInput`, `handleHumanInput`) are deliberately not
 *   ported, on the owner's decision of 4 October 2026: the Person touching a page Vivid is using
 *   does not stop Vivid. Vivid stops when the Person says so, with the Stop button the page
 *   shows while an action is running (`stop`), and when the link to Vivid ends (the caller
 *   interrupts `execute`). Both end the action at once through interruption, and the release
 *   steps still run because they are finalizers.
 */
export const executor = Effect.fn('DesktopControl.make')(function* (
  dependencies: ControlDependencies,
) {
  const turn = yield* Semaphore.make(1)
  const listed = yield* Ref.make(Option.none<ReadonlyArray<Tab>>())
  // The action in progress. Plain state, because Stop arrives from the bridge outside any fiber.
  let running = Option.none<Running>()

  /**
   * Carries out one request and returns its answer, or nothing when there is no longer anyone to
   * answer: the deadline had passed before its turn came, or passed while it was being carried
   * out. The server has already recorded such a request as unknown and ignores a late answer, so
   * an expired action is never started and a slow one is stopped rather than finished unseen.
   */
  const inTurn = Effect.fn('DesktopControl.inTurn')(function* (request: PageWork) {
    const now = yield* Clock.currentTimeMillis
    if (now >= request.expiresAt) return Option.none<DeviceAnswer>()
    const current: Running = { held: Option.none(), stopped: yield* Deferred.make<void>() }
    running = Option.some(current)
    return yield* act({ ...dependencies, listed, running: current }, request.action).pipe(
      Effect.timeoutOption(Duration.millis(request.expiresAt - now)),
      // However the action ends, the page stops saying Vivid is using it and Stop has no target.
      Effect.ensuring(
        Effect.sync(() => {
          running = Option.none()
          dependencies.using(Option.none())
        }),
      ),
    )
  })

  return {
    execute: (request: PageWork) => inTurn(request).pipe(Semaphore.withPermit(turn)),
    /**
     * The Person pressed Stop on this page. Ends the action running on it, at once; the answer is
     * `Refused: Stopped`, which tells Vivid the Person stopped it. A page Vivid is not using has
     * nothing to stop, and saying so again changes nothing.
     */
    stop: (tab: Tab): void => {
      Option.map(
        Option.filter(running, (current) => Option.exists(current.held, (held) => held === tab)),
        (current) => Deferred.doneUnsafe(current.stopped, Effect.void),
      )
    },
  }
})
