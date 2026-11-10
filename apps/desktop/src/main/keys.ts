import * as Option from 'effect/Option'

/** One physical key: what it is called, where it sits, and what it types when it types anything. */
interface KeyDefinition {
  readonly code: string
  readonly key: string
  readonly keyCode: number
  readonly text: Option.Option<string>
}

/** The modifiers the key grammar allows. */
type Modifier = 'Shift' | 'Control' | 'Meta'

/**
 * The keys Vivid may press on a page, written the way the browser step is written for Vivid's own
 * Computer: one editing or navigation key, a printable character, `Shift+` a character,
 * `Control+` a, c, v or f, or `Control+Shift+v`. The same expression as the server's `validateKey`
 * (apps/server/src/computers/browser.ts), kept identical so a key means the same thing on either
 * machine. Shortcuts that close tabs or windows, or drive the browser itself, are not in it.
 */
const ALLOWED_KEY =
  /^(Enter|Tab|Escape|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|Backspace|Delete|Home|End|PageUp|PageDown|[^\p{C}\p{Zl}\p{Zp}]|Shift\+[^\p{C}\p{Zl}\p{Zp}]|Control\+[aAcCvVfF]|Control\+Shift\+[vV])$/u

const named = (code: string, keyCode: number, text: Option.Option<string>): KeyDefinition => ({
  code,
  key: code,
  keyCode,
  text,
})

/** The named keys of the grammar, with the reference's codes (`preview/PreviewKeyboard.ts`, `NAMED_KEYS`). */
const NAMED_KEYS = new Map<string, KeyDefinition>(
  Object.entries({
    Escape: named('Escape', 27, Option.none()),
    Backspace: named('Backspace', 8, Option.none()),
    Tab: named('Tab', 9, Option.none()),
    Enter: named('Enter', 13, Option.some('\r')),
    PageUp: named('PageUp', 33, Option.none()),
    PageDown: named('PageDown', 34, Option.none()),
    End: named('End', 35, Option.none()),
    Home: named('Home', 36, Option.none()),
    ArrowLeft: named('ArrowLeft', 37, Option.none()),
    ArrowUp: named('ArrowUp', 38, Option.none()),
    ArrowRight: named('ArrowRight', 39, Option.none()),
    ArrowDown: named('ArrowDown', 40, Option.none()),
    Delete: named('Delete', 46, Option.none()),
  }),
)

/** Punctuation and digits: `[code, plain, shifted, keyCode]`, from the reference's `PRINTABLE_KEYS`. */
const PRINTABLE_KEYS: ReadonlyArray<readonly [string, string, string, number]> = [
  ['Backquote', '`', '~', 192],
  ['Digit1', '1', '!', 49],
  ['Digit2', '2', '@', 50],
  ['Digit3', '3', '#', 51],
  ['Digit4', '4', '$', 52],
  ['Digit5', '5', '%', 53],
  ['Digit6', '6', '^', 54],
  ['Digit7', '7', '&', 55],
  ['Digit8', '8', '*', 56],
  ['Digit9', '9', '(', 57],
  ['Digit0', '0', ')', 48],
  ['Minus', '-', '_', 189],
  ['Equal', '=', '+', 187],
  ['Backslash', '\\', '|', 220],
  ['BracketLeft', '[', '{', 219],
  ['BracketRight', ']', '}', 221],
  ['Semicolon', ';', ':', 186],
  ['Quote', "'", '"', 222],
  ['Comma', ',', '<', 188],
  ['Period', '.', '>', 190],
  ['Slash', '/', '?', 191],
  ['Space', ' ', ' ', 32],
]

/**
 * What Chromium does for a Command chord on a Mac. It does not infer editing commands from
 * synthetic key events, so the reference names them (`MAC_EDITING_COMMANDS`); these are the rows
 * the grammar can reach.
 */
const MAC_EDITING_COMMANDS = new Map([
  ['Meta+KeyA', 'selectAll'],
  ['Meta+KeyC', 'copy'],
  ['Meta+KeyV', 'paste'],
])

/** The debugger's modifier bits (Alt 1, Control 2, Meta 4, Shift 8), as the reference's `modifierMask`. */
const MODIFIER_BITS = { Control: 2, Meta: 4, Shift: 8 } satisfies Record<Modifier, number>

/** Splits `Control+Shift+v` into its modifiers and key. The key itself may be `+`. */
function parts(key: string) {
  if (key.endsWith('+'))
    return { modifiers: key.slice(0, -1).split('+').filter(Boolean), name: '+' }
  const pieces = key.split('+')
  return { modifiers: pieces.slice(0, -1), name: pieces.slice(-1).join('') }
}

/** Finds the physical key for a name. Ported from the reference's `resolveKeyDefinition`. */
function definition(name: string, shifted: boolean): KeyDefinition {
  const known = NAMED_KEYS.get(name)
  if (known !== undefined) return known
  if (/^[a-z]$/iu.test(name)) {
    const upper = name.toUpperCase()
    const key = shifted || name === upper ? upper : name
    return { code: `Key${upper}`, key, keyCode: upper.charCodeAt(0), text: Option.some(key) }
  }
  const printable = PRINTABLE_KEYS.find(([, plain, shift]) => plain === name || shift === name)
  if (printable !== undefined) {
    const [code, plain, shift, keyCode] = printable
    const key = shifted || name === shift ? shift : plain
    return { code, key, keyCode, text: Option.some(key) }
  }
  // A character with no key of its own on this layout: it is typed as text with no physical code,
  // which is what the reference sends for any single character it does not know.
  return { code: '', key: name, keyCode: 0, text: Option.some(name) }
}

/** The fields every key packet carries, as the debugger's `Input.dispatchKeyEvent` names them. */
type KeyFields = {
  readonly key: string
  readonly code: string
  readonly modifiers: number
  readonly windowsVirtualKeyCode: number
  readonly location: number
  readonly isKeypad: boolean
}

/** A key going down: with the text it types, or raw when it types none. */
type KeyDown = KeyFields & { readonly commands: ReadonlyArray<string> } & (
    | { readonly type: 'rawKeyDown' }
    | { readonly type: 'keyDown'; readonly text: string; readonly unmodifiedText: string }
  )

/** The packets for one press. */
export interface KeySequence {
  readonly keyDown: KeyDown
  readonly keyUp: KeyFields & { readonly type: 'keyUp' }
}

/**
 * Builds the debugger's key packets for one key of the grammar, or nothing for a key outside it.
 *
 * Ported from the reference's `makePreviewAutomationKeySequence` (`preview/PreviewKeyboard.ts`):
 * the same fields, the same choice of `keyDown` when the key types text and `rawKeyDown` when it
 * does not, text suppressed under any modifier but Shift, and the same Mac editing commands.
 *
 * What Vivid changes: the key arrives as one string in the Computer's grammar, not as a key with
 * a modifier list, and on a Mac `Control` becomes Command, because the grammar's `Control+a`
 * means "select all" and on a Mac that is Command+A. The reference takes Meta from its caller and
 * so never has to translate.
 */
export function keySequence(
  key: string,
  platform: { readonly mac: boolean },
): Option.Option<KeySequence> {
  if (!ALLOWED_KEY.test(key)) return Option.none()
  const { modifiers: written, name } = parts(key)
  const modifiers = written.map((modifier): Modifier => {
    if (modifier === 'Shift') return 'Shift'
    return platform.mac ? 'Meta' : 'Control'
  })
  const found = definition(name, modifiers.includes('Shift'))
  const chord = modifiers.some((modifier) => modifier !== 'Shift')
  const text = chord ? Option.none<string>() : found.text
  // Shift first, then Meta, as the reference orders a chord's name; a shifted chord has no row.
  const chordName = [
    ...(['Shift', 'Meta'] as const).filter((modifier) => modifiers.includes(modifier)),
    found.code,
  ].join('+')
  // An empty list is what the reference leaves out; the debugger treats the two alike.
  const commands = platform.mac
    ? Option.toArray(Option.fromUndefinedOr(MAC_EDITING_COMMANDS.get(chordName)))
    : []
  const shared = {
    key: found.key,
    code: found.code,
    modifiers: modifiers.reduce((mask, modifier) => mask | MODIFIER_BITS[modifier], 0),
    windowsVirtualKeyCode: found.keyCode,
    location: 0,
    isKeypad: false,
  }
  return Option.some<KeySequence>({
    keyDown: Option.match(text, {
      onNone: (): KeyDown => ({ ...shared, commands, type: 'rawKeyDown' }),
      onSome: (value): KeyDown => ({
        ...shared,
        commands,
        type: 'keyDown',
        text: value,
        unmodifiedText: value,
      }),
    }),
    keyUp: { ...shared, type: 'keyUp' },
  })
}
