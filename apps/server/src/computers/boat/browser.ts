import { BrowseResult, BrowserAction } from '@vivid/contracts'
import { Effect, Schema, Option } from 'effect'
import {
  BrowserStepFailed,
  MachineInputInvalid,
  MachineCapabilityUnavailable,
  type MachineFailure,
} from '../machine.ts'
import { validateAddress, validateKey } from '../browser.ts'
import type { Driver } from './driver.ts'
import { ActionReceipt, NavigationReceipt } from './receipt.ts'
import { click } from './pointer.ts'

/** Exact browser bindings and semantic state, from Cua core/src/browser/tools.rs.
 * References remain inside this adapter; the model names controls from their accessible labels. */
export const Windows = Schema.Struct({
  windows: Schema.Array(
    Schema.Struct({
      pid: Schema.NullOr(Schema.Int),
      window_id: Schema.Int,
      app_name: Schema.String,
      title: Schema.String,
      bounds: Schema.Struct({
        x: Schema.Int,
        y: Schema.Int,
        width: Schema.Int,
        height: Schema.Int,
      }),
      height: Schema.Int,
      width: Schema.Int,
      x: Schema.Int,
      y: Schema.Int,
      is_on_screen: Schema.Boolean,
      z_index: Schema.Int,
    }),
  ),
})
export const BrowserBinding = Schema.Struct({
  status: Schema.Literal('ok'),
  mode: Schema.Literal('bind'),
  target_id: Schema.String,
  binding_quality: Schema.Literal('exact'),
  tabs: Schema.Array(
    Schema.Struct({
      tab_id: Schema.String,
      title: Schema.String,
      url: Schema.String,
      active: Schema.NullOr(Schema.Boolean),
    }),
  ),
})
type BrowserBinding = typeof BrowserBinding.Type
export const Page = Schema.Struct({
  status: Schema.Literal('ok'),
  mode: Schema.Literal('snapshot'),
  page: Schema.Struct({ url: Schema.String, title: Schema.String }),
  outline: Schema.String,
  snapshot: Schema.Struct({ complete: Schema.Boolean }),
  refs: Schema.Array(
    Schema.Struct({
      ref: Schema.String,
      name: Schema.NullOr(Schema.String),
      value: Schema.NullOr(Schema.String),
      actions: Schema.Array(Schema.String),
    }),
  ),
})
const Elements = Schema.Struct({
  elements: Schema.Array(
    Schema.Struct({
      role: Schema.String,
      label: Schema.optionalKey(Schema.String),
      element_token: Schema.optionalKey(Schema.String),
    }),
  ),
})
type Window = { readonly pid: number; readonly window_id: number }

/**
 * Discovery refuses ambiguous Chrome windows rather than controlling a different profile.
 *
 * `proxy` is asked only when this step starts the browser, and its answer is the one thing that
 * decides whether that browser is given `--proxy-server`: a browser's way out is fixed when it
 * starts, so one that is already running is found and left as it is.
 */
export const chrome = Effect.fn('Machine.boat.browser.chrome')(function* (
  native: Pick<Driver, 'call'>,
  mayLaunch: boolean,
  proxy: Effect.Effect<Option.Option<string>>,
) {
  let list = yield* native.call('list_windows', {}, Windows)
  let matches = list.windows.filter((window) => /chrome|chromium/i.test(window.app_name))
  if (matches.length === 0 && mayLaunch) {
    // Asked only here: a browser's way out is decided when it starts and kept until it ends.
    const through = yield* proxy
    yield* native.call(
      'launch_app',
      {
        name: 'google-chrome-stable',
        additional_arguments: [
          '--force-renderer-accessibility',
          ...Option.match(through, {
            onNone: () => [],
            onSome: (address) => [`--proxy-server=${address}`],
          }),
        ],
      },
      Launched,
    )
    // Launch is dispatched once; only discovery is retried while the native window appears.
    for (let attempt = 0; attempt < 10; attempt++) {
      list = yield* native.call('list_windows', {}, Windows)
      matches = list.windows.filter((window) => /chrome|chromium/i.test(window.app_name))
      if (matches.length > 0) break
      yield* Effect.sleep('250 millis')
    }
  }
  const window = matches[0]
  if (matches.length !== 1 || window === undefined || window.pid === null)
    return yield* new BrowserStepFailed()
  return { pid: window.pid, window_id: window.window_id }
})
const Launched = Schema.Struct({
  running: Schema.Boolean,
  pid: Schema.Int,
  windows: Windows.fields.windows,
})
const Prepared = Schema.Struct({ status: Schema.Literal('ok'), prepared: Schema.Boolean })

/** Opening a page authorizes attaching the existing guest profile through the driver's own
 * permission gate. Never relaunch an isolated profile or change the daemon's launch grants. */
const prepare = Effect.fn('Machine.boat.browser.prepare')(function* (
  native: Driver,
  window: Window,
) {
  const receipt = yield* native.call(
    'browser_prepare',
    {
      ...window,
      strategy: { kind: 'existing_profile' },
      allow_launch: false,
    },
    Prepared,
  )
  if (!receipt.prepared) return yield* new MachineCapabilityUnavailable({ capability: 'browser' })
  return undefined
})

const binding = Effect.fn('Machine.boat.browser.bind')((native: Driver, window: Window) =>
  native.call('get_browser_state', window, BrowserBinding),
)

/** Tabs are restricted to the exactly-bound native window (Cua engine.rs). Its sole tab is
 * necessarily current even while navigation changes the title before X11 catches up. Multiple
 * tabs still require one explicit selection proof; ambiguous native titles stay refused. */
const currentTab = Effect.fn('Machine.boat.browser.active')(function* (bound: BrowserBinding) {
  const sole = bound.tabs[0]
  if (bound.tabs.length === 1 && sole !== undefined && sole.active !== false) return sole
  const showing = bound.tabs.filter((tab) => tab.active === true)
  const current = showing[0]
  if (showing.length !== 1 || current === undefined) return yield* new BrowserStepFailed()
  return current
})
const snapshot = Effect.fn('Machine.boat.browser.snapshot')(function* (
  native: Driver,
  bound: BrowserBinding,
) {
  const current = yield* currentTab(bound)
  return yield* native.call(
    'get_browser_state',
    {
      target_id: bound.target_id,
      tab_id: current.tab_id,
      snapshot_format: 'semantic_v2',
    },
    Page,
  )
})

/** Match one fresh accessible label; opaque refs and permissive selectors are never model input. */
const targetRef = Effect.fn('Machine.boat.browser.target')(function* (
  native: Driver,
  bound: BrowserBinding,
  target: string,
  action: 'click' | 'type',
) {
  const page = yield* snapshot(native, bound)
  const matches = page.refs.filter(
    (ref) =>
      ref.name !== null &&
      ref.name.toLocaleLowerCase() === target.toLocaleLowerCase() &&
      ref.actions.includes(action),
  )
  const match = matches[0]
  if (matches.length !== 1 || match === undefined) return yield* new BrowserStepFailed()
  const current = yield* currentTab(bound)
  return { target_id: bound.target_id, tab_id: current.tab_id, ref: match.ref }
})

/** Native tab controls use the position of the last tab result, mapped to its exact title.
 * Duplicate titles are refused: a tab number never becomes a guessed Chromium shortcut. */
const selectTab = Effect.fn('Machine.boat.browser.select')(function* (
  native: Driver,
  window: Window,
  bound: BrowserBinding,
  index: number,
) {
  const chosen = bound.tabs[index - 1]
  if (chosen === undefined) return yield* new MachineInputInvalid()
  const controls = yield* native.call(
    'get_window_state',
    { ...window, include_screenshot: false },
    Elements,
  )
  const candidates = controls.elements.filter(
    (item) =>
      /^(page tab|tab)$/i.test(item.role) &&
      item.label === chosen.title &&
      item.element_token !== undefined,
  )
  const item = candidates[0]
  if (candidates.length !== 1 || item === undefined || item.element_token === undefined)
    return yield* new BrowserStepFailed()
  yield* native.call(
    'click',
    { ...window, element_token: item.element_token, delivery_mode: 'foreground' },
    ActionReceipt,
  )
  return undefined
})

/** All mutations use Cua, with explicit foreground delivery on this Person's dedicated desktop. */
const step = Effect.fn('Machine.boat.browser.step')(function* (
  native: Driver,
  window: Window,
  bound: BrowserBinding,
  action: BrowserAction,
) {
  const keys = Effect.fn('Machine.boat.browser.keys')(function* (pressed: ReadonlyArray<string>) {
    const key = pressed[pressed.length - 1]
    if (key === undefined) return yield* new MachineInputInvalid()
    yield* native.call(
      'press_key',
      { ...window, key, modifiers: pressed.slice(0, -1), delivery_mode: 'foreground' },
      ActionReceipt,
    )
    return undefined
  })
  yield* BrowserAction.match<Effect.Effect<void, MachineFailure>>(action, {
    Open: Effect.fn('Machine.boat.browser.open')(function* ({ address }) {
      yield* validateAddress(address)
      const tab = yield* currentTab(bound)
      yield* native.call(
        'browser_navigate',
        { target_id: bound.target_id, tab_id: tab.tab_id, url: address },
        NavigationReceipt,
      )
    }),
    Read: () => Effect.void,
    Screenshot: () => native.capture().pipe(Effect.asVoid),
    Click: Effect.fn('Machine.boat.browser.click')(function* ({ target }) {
      yield* targetRef(native, bound, target, 'click')
      yield* click(native, window, target)
    }),
    Type: Effect.fn('Machine.boat.browser.type')(function* ({ target, text }) {
      const ref = yield* targetRef(native, bound, target, 'type')
      yield* native.call('browser_type', { ...ref, text, replace: true }, ActionReceipt)
    }),
    Press: Effect.fn('Machine.boat.browser.press')(function* ({ key }) {
      yield* validateKey(key)
      yield* keys(key.split('+'))
    }),
    Scroll: ({ direction, notches }) =>
      native
        .call(
          'scroll',
          { ...window, direction, amount: notches, by: 'line', delivery_mode: 'foreground' },
          ActionReceipt,
        )
        .pipe(Effect.asVoid),
    Back: () => keys(['alt', 'Left']),
    Forward: () => keys(['alt', 'Right']),
    Wait: ({ seconds }) => Effect.sleep(`${seconds} seconds`),
    OpenTab: Effect.fn('Machine.boat.browser.openTab')(function* ({ address }) {
      yield* validateAddress(address)
      yield* keys(['ctrl', 't'])
      yield* native.call(
        'type_text',
        { ...window, text: address, delivery_mode: 'foreground' },
        ActionReceipt,
      )
      yield* keys(['Return'])
    }),
    ShowTab: ({ tab }) => selectTab(native, window, bound, tab),
    CloseTab: Effect.fn('Machine.boat.browser.closeTab')(function* ({ tab }) {
      yield* selectTab(native, window, bound, tab)
      yield* keys(['ctrl', 'w'])
    }),
  })
})

/** Native binding tab order is not stable. Resolve positions from the last view to one fresh identity.
 * Restart loses positions intentionally: Read must precede selecting a tab after restart. */
const resolveTab = Effect.fn('Machine.boat.browser.resolveTab')(function* (
  bound: BrowserBinding,
  action: BrowserAction,
  previous: Option.Option<BrowseResult['tabs']>,
) {
  if (!BrowserAction.isAnyOf(['ShowTab', 'CloseTab'])(action)) return action
  if (Option.isNone(previous)) return yield* new MachineInputInvalid()
  const selected = previous.value[action.tab - 1]
  if (selected === undefined) return yield* new MachineInputInvalid()
  const matches = bound.tabs.filter(
    (tab) => tab.url === selected.address && tab.title === selected.title,
  )
  if (matches.length !== 1) return yield* new BrowserStepFailed()
  const tab =
    bound.tabs.findIndex((item) => item.url === selected.address && item.title === selected.title) +
    1
  return BrowserAction.guards.ShowTab(action)
    ? BrowserAction.cases.ShowTab.make({ tab })
    : BrowserAction.cases.CloseTab.make({ tab })
})

/** Refresh native binding after each step so URLs, current tab and outline describe post-action state.
 * Refused browser setup is surfaced; we never start a second profile or alter the guest daemon.
 *
 * `proxy` answers the address of the proxy a browser started by this step is given, or nothing
 * for the machine's own way out (`egress/guest.ts`). It is run only when the browser is started. */
export const browse = Effect.fn('Machine.boat.browser')(function* (
  native: Driver,
  action: BrowserAction,
  previous: Option.Option<BrowseResult['tabs']>,
  proxy: Effect.Effect<Option.Option<string>>,
) {
  if (BrowserAction.guards.Open(action) || BrowserAction.guards.OpenTab(action))
    yield* validateAddress(action.address)
  const window = yield* chrome(native, BrowserAction.isAnyOf(['Open', 'OpenTab'])(action), proxy)
  if (BrowserAction.isAnyOf(['Open', 'OpenTab'])(action)) yield* prepare(native, window)
  const before = yield* binding(native, window)
  yield* step(native, window, before, yield* resolveTab(before, action, previous))
  const after = yield* binding(native, window)
  const showing = yield* currentTab(after)
  const page = yield* snapshot(native, after)
  // Cua input receipts attest delivery only. A replacement must independently read back the
  // same uniquely named editable control and exact value, including clearing with empty text.
  if (BrowserAction.guards.Type(action)) {
    const fields = page.refs.filter(
      (ref) =>
        ref.name !== null &&
        ref.name.toLocaleLowerCase() === action.target.toLocaleLowerCase() &&
        ref.actions.includes('type'),
    )
    const field = fields[0]
    if (
      fields.length !== 1 ||
      field === undefined ||
      (field.value !== action.text && !(action.text === '' && field.value === null))
    )
      return yield* new BrowserStepFailed()
  }
  // semantic.rs render_outline contains roles, words and states; refs remain separate and private.
  const outline = page.outline.slice(0, 32768)
  return BrowseResult.make({
    address: page.page.url,
    title: page.page.title,
    outline,
    truncated: !page.snapshot.complete || page.outline.length > 32768,
    tabs: after.tabs.map((tab) => ({
      title: tab.title,
      address: tab.url,
      showing: tab.tab_id === showing.tab_id,
    })),
  })
})
