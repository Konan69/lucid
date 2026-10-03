import * as NodeBuffer from 'node:buffer'
import { DesktopAction, DesktopView } from '@vivid/contracts'
import { Effect, Schema } from 'effect'
import {
  MachineInputInvalid,
  MachineResponseInvalid,
  type MachineFailure,
  type MachineKey,
} from '../machine.ts'
import type { Driver } from './driver.ts'
import type { ProviderId } from './protocol.ts'
import type { Transport } from './transport.ts'
import { ActionReceipt } from './receipt.ts'

export const Cursor = Schema.Struct({ source: Schema.String, x: Schema.Int, y: Schema.Int })
const Focus = Schema.Struct({ window: Schema.NullOr(Schema.String) })
const decodeFocus = Schema.decodeUnknownEffect(Schema.fromJsonString(Focus))

/** Cua's list_windows does not identify focus (stacking order is not focus).
 * Query X11's actual active-window property using the guest's existing Xlib; install nothing.
 * Only this fixed program reaches argv; titles are response data. */
export const focusCommand = `python3 - <<'VIVID_FOCUS'
import ctypes as c, json
x=c.CDLL('libX11.so.6')
x.XOpenDisplay.argtypes=[c.c_char_p]; x.XOpenDisplay.restype=c.c_void_p
x.XDefaultRootWindow.argtypes=[c.c_void_p]; x.XDefaultRootWindow.restype=c.c_ulong
x.XInternAtom.argtypes=[c.c_void_p,c.c_char_p,c.c_int]; x.XInternAtom.restype=c.c_ulong
x.XGetWindowProperty.argtypes=[c.c_void_p,c.c_ulong,c.c_ulong,c.c_long,c.c_long,c.c_int,c.c_ulong,c.POINTER(c.c_ulong),c.POINTER(c.c_int),c.POINTER(c.c_ulong),c.POINTER(c.c_ulong),c.POINTER(c.POINTER(c.c_ubyte))]
x.XFree.argtypes=[c.c_void_p]; x.XCloseDisplay.argtypes=[c.c_void_p]
d=x.XOpenDisplay(b':0')
if not d: raise RuntimeError('display unavailable')
def prop(w,name):
 a=x.XInternAtom(d,name.encode(),0); t=c.c_ulong(); fmt=c.c_int(); n=c.c_ulong(); left=c.c_ulong(); p=c.POINTER(c.c_ubyte)()
 if x.XGetWindowProperty(d,w,a,0,65536,0,0,c.byref(t),c.byref(fmt),c.byref(n),c.byref(left),c.byref(p)) != 0: raise RuntimeError('property unavailable')
 if not p: return None
 try:
  if fmt.value==32: return int(c.cast(p,c.POINTER(c.c_ulong))[0]) if n.value else None
  if fmt.value==8: return c.string_at(p,n.value).decode('utf-8')
  return None
 finally: x.XFree(p)
try:
 w=prop(x.XDefaultRootWindow(d),'_NET_ACTIVE_WINDOW')
 title=prop(w,'_NET_WM_NAME') if w else None
 if title is None and w: title=prop(w,'WM_NAME')
 print(json.dumps({'window':title}))
finally: x.XCloseDisplay(d)
VIVID_FOCUS`

/** Desktop target is explicit: tools act on the same primary display Boat streams. */
export const desktopStep = Effect.fn('Machine.boat.desktop.step')(function* (
  native: Driver,
  action: DesktopAction,
) {
  const common = { scope: 'desktop', delivery_mode: 'foreground' }
  yield* DesktopAction.match<Effect.Effect<void, MachineFailure>>(action, {
    Look: () => Effect.void,
    Move: ({ to }) =>
      native
        .call('move_cursor', { scope: 'desktop', x: to.x, y: to.y }, ActionReceipt)
        .pipe(Effect.asVoid),
    Click: ({ at, button, times }) =>
      native
        .call('click', { ...common, x: at.x, y: at.y, button, count: times }, ActionReceipt)
        .pipe(Effect.asVoid),
    Drag: ({ from, to }) =>
      native
        .call(
          'drag',
          { ...common, from_x: from.x, from_y: from.y, to_x: to.x, to_y: to.y },
          ActionReceipt,
        )
        .pipe(Effect.asVoid),
    Scroll: ({ at, direction, notches }) =>
      native
        .call(
          'scroll',
          { ...common, x: at.x, y: at.y, direction, amount: notches, by: 'line' },
          ActionReceipt,
        )
        .pipe(Effect.asVoid),
    Type: ({ text }) =>
      native.call('type_text', { ...common, text }, ActionReceipt).pipe(Effect.asVoid),
    Press: Effect.fn('Machine.boat.desktop.press')(function* ({ keys }) {
      const parts = keys.split('+')
      const key = parts.pop()
      if (key === undefined || key === '') return yield* Effect.fail(new MachineInputInvalid())
      yield* native.call('press_key', { ...common, key, modifiers: parts }, ActionReceipt)
      return undefined
    }),
    Wait: ({ seconds }) => Effect.sleep(`${seconds} seconds`),
  })
})

/** Validate PNG header and dimensions before transporting a picture to the model.
 * A lost desktop action is never retried to obtain a nicer screenshot. */
export const look = Effect.fn('Machine.boat.desktop.look')(function* (
  native: Driver,
  api: Transport,
  identity: { readonly id: ProviderId; readonly key: MachineKey },
) {
  const picture = yield* native.capture()
  const pointer = yield* native.call('get_cursor_position', {}, Cursor)
  const focused = yield* api.command(identity.id, identity.key, focusCommand, 30)
  if (focused.exitCode !== 0 || focused.stdoutTruncated === true)
    return yield* Effect.fail(new MachineResponseInvalid({ operation: 'focused-window' }))
  const focus = yield* decodeFocus(focused.stdout).pipe(
    Effect.mapError(() => new MachineResponseInvalid({ operation: 'focused-window' })),
  )
  const bytes = NodeBuffer.Buffer.from(picture.screenshot_png_b64, 'base64')
  if (
    bytes.length < 24 ||
    bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' ||
    bytes.readUInt32BE(16) !== picture.screen_width ||
    bytes.readUInt32BE(20) !== picture.screen_height ||
    picture.screenshot_width !== picture.screen_width ||
    picture.screenshot_height !== picture.screen_height
  )
    return yield* Effect.fail(new MachineResponseInvalid({ operation: 'desktop-picture' }))
  return DesktopView.make({
    picture: picture.screenshot_png_b64,
    width: picture.screen_width,
    height: picture.screen_height,
    pointer: { x: pointer.x, y: pointer.y },
    window: focus.window,
  })
})
