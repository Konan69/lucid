import * as Arr from 'effect/Array'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'

/** A value as the debugger's accessibility domain wraps it; what is inside depends on the field. */
const AccessibilityValue = Schema.Struct({ value: Schema.optionalKey(Schema.Unknown) })

/**
 * One node of the page's accessibility tree, as `Accessibility.getFullAXTree` returns it. Only the
 * fields the outline reads are named; Chromium sends more, and they are left alone.
 */
const AccessibilityNode = Schema.Struct({
  nodeId: Schema.String,
  ignored: Schema.optionalKey(Schema.Boolean),
  role: Schema.optionalKey(AccessibilityValue),
  name: Schema.optionalKey(AccessibilityValue),
  value: Schema.optionalKey(AccessibilityValue),
  properties: Schema.optionalKey(
    Schema.Array(Schema.Struct({ name: Schema.String, value: AccessibilityValue })),
  ),
  parentId: Schema.optionalKey(Schema.String),
  childIds: Schema.optionalKey(Schema.Array(Schema.String)),
  backendDOMNodeId: Schema.optionalKey(Schema.Int),
})
type AccessibilityNode = typeof AccessibilityNode.Type

/** The whole tree, decoded once where the debugger's answer arrives. */
export const AccessibilityTree = Schema.Struct({ nodes: Schema.Array(AccessibilityNode) })
export type AccessibilityTree = typeof AccessibilityTree.Type

/** What a named thing on the page can be used for. */
export type ControlUse = 'click' | 'type'

/**
 * Something on the page that has a name. `node` is Chromium's own handle for the element and stays
 * inside the desktop app: Vivid names a control by its words, never by a handle or a selector.
 */
export interface OutlineControl {
  readonly name: string
  readonly role: string
  readonly node: number
  readonly uses: ReadonlyArray<ControlUse>
}

/** The page as words, whether the words were cut, and the named things in it. */
export interface PageOutline {
  readonly text: string
  readonly truncated: boolean
  readonly controls: ReadonlyArray<OutlineControl>
}

/**
 * The most outline text one answer carries, in characters. The same limit Vivid's own Computer
 * applies to its outline (apps/server/src/computers/boat/browser.ts, `browse`), so a page reads
 * the same length on either machine.
 */
export const OUTLINE_LIMIT = 32_768

/** Roles that carry no words of their own; their children are read in their place. */
const SILENT_ROLES = new Set(['none', 'generic', 'InlineTextBox', 'LineBreak', 'RootWebArea'])
/** Roles a Person clicks. */
const CLICK_ROLES = new Set([
  'button',
  'link',
  'checkbox',
  'radio',
  'switch',
  'tab',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'option',
  'treeitem',
  'combobox',
  'textbox',
  'searchbox',
  'spinbutton',
  'slider',
  'DisclosureTriangle',
])
/** Roles a Person types into. */
const TYPE_ROLES = new Set(['textbox', 'searchbox', 'spinbutton', 'combobox'])
/** States worth saying in the outline, in the order they are said. */
const STATES = ['disabled', 'checked', 'expanded', 'selected', 'focused'] as const
/** Indentation stops growing here; a deeply nested page still reads as a list. */
const DEEPEST = 10

/** The kinds of value that are words. Lists of related nodes and the like are not. */
const sayable = Schema.decodeUnknownOption(
  Schema.Union([Schema.String, Schema.Number, Schema.Boolean]),
)

/** Words from a wrapped value: text as it is, numbers and booleans as written, nothing else. */
function words(value: Option.Option<typeof AccessibilityValue.Type>): string {
  return value.pipe(
    Option.flatMap((wrapped) => sayable(wrapped.value)),
    Option.match({ onNone: () => '', onSome: (found) => String(found).trim() }),
  )
}

const roleOf = (node: AccessibilityNode) => words(Option.fromUndefinedOr(node.role))
const nameOf = (node: AccessibilityNode) => words(Option.fromUndefinedOr(node.name))

/** A property's words, or nothing when the node does not have it. */
function property(node: AccessibilityNode, name: string): string {
  const properties = node.properties === undefined ? [] : node.properties
  return words(
    Option.map(Option.fromUndefinedOr(properties.find((p) => p.name === name)), (p) => p.value),
  )
}

/** The states that are on, in brackets: ` (checked, focused)`. Off and absent say nothing. */
function states(node: AccessibilityNode): string {
  const on = STATES.filter((state) => !['', 'false'].includes(property(node, state)))
  return on.length === 0 ? '' : ` (${on.join(', ')})`
}

/** What this node can be used for. Focusable things are clickable even with an unusual role. */
function uses(node: AccessibilityNode): ReadonlyArray<ControlUse> {
  const role = roleOf(node)
  const disabled = property(node, 'disabled') === 'true'
  if (disabled) return []
  const click = CLICK_ROLES.has(role) || property(node, 'focusable') === 'true'
  const type = TYPE_ROLES.has(role) && property(node, 'readonly') !== 'true'
  return [...(click ? (['click'] as const) : []), ...(type ? (['type'] as const) : [])]
}

/**
 * Whether the node gets a line. Ignored and wordless nodes do not, and a run of text that only
 * repeats its parent's name does not either: a button named "Sign in" is one line, not two.
 */
function spoken(node: AccessibilityNode, parentName: string): boolean {
  if (node.ignored === true) return false
  const role = roleOf(node)
  if (SILENT_ROLES.has(role)) return false
  const name = nameOf(node)
  if (role === 'StaticText') return name !== '' && name !== parentName
  return name !== '' || TYPE_ROLES.has(role)
}

/** One line of the outline: role, name in quotes, current value, states. */
function line(node: AccessibilityNode, depth: number): string {
  const value = words(Option.fromUndefinedOr(node.value))
  const role = roleOf(node) === 'StaticText' ? 'text' : roleOf(node)
  return `${'  '.repeat(Math.min(depth, DEEPEST))}${role} "${nameOf(node)}"${value === '' ? '' : ` = "${value}"`}${states(node)}`
}

/** A node waiting to be read, with how deep it sits and the name of the node above it. */
interface Pending {
  readonly node: AccessibilityNode
  readonly depth: number
  readonly parentName: string
}

/**
 * Turns the accessibility tree into the page's outline and its named controls.
 *
 * The reference returns the raw tree, a list of selectors and the page's visible text
 * (`preview/Manager.ts`, `captureAutomationSnapshot`). Vivid's contract is different: one readable
 * outline, and controls named by their accessible name, the way Vivid's own Computer answers. So
 * the same tree is read in document order into lines of role, name, value and state, and each
 * named element keeps Chromium's handle beside it, privately, for the click or the typing that
 * follows.
 */
export function outline(tree: AccessibilityTree): PageOutline {
  const byId = new Map(tree.nodes.map((node) => [node.nodeId, node]))
  const roots = tree.nodes.filter((node) => node.parentId === undefined || !byId.has(node.parentId))
  const lines: Array<string> = []
  const controls: Array<OutlineControl> = []
  // Depth first, in document order: children are pushed reversed so the first is read first.
  const stack: Array<Pending> = Arr.reverse(roots).map((node) => ({
    node,
    depth: 0,
    parentName: '',
  }))
  for (let next = stack.pop(); next !== undefined; next = stack.pop()) {
    const { node, depth, parentName } = next
    const said = spoken(node, parentName)
    if (said) lines.push(line(node, depth))
    const name = nameOf(node)
    if (said && name !== '' && node.backendDOMNodeId !== undefined)
      controls.push({ name, role: roleOf(node), node: node.backendDOMNodeId, uses: uses(node) })
    const children = (node.childIds === undefined ? [] : node.childIds).flatMap((id) =>
      Option.toArray(Option.fromUndefinedOr(byId.get(id))),
    )
    for (const child of Arr.reverse(children))
      stack.push({ node: child, depth: said ? depth + 1 : depth, parentName: name })
  }
  const text = lines.join('\n')
  return { text: text.slice(0, OUTLINE_LIMIT), truncated: text.length > OUTLINE_LIMIT, controls }
}

/**
 * Finds the one control with this name that can be used this way. Names are compared without
 * regard to case, and anything but exactly one match is no match: Vivid never guesses between two
 * buttons with the same words. The same rule as Vivid's own Computer
 * (apps/server/src/computers/boat/browser.ts, `targetRef`).
 */
export function findControl(
  controls: ReadonlyArray<OutlineControl>,
  target: string,
  use: ControlUse,
): Option.Option<OutlineControl> {
  const wanted = target.toLocaleLowerCase()
  const matches = controls.filter(
    (control) => control.name.toLocaleLowerCase() === wanted && control.uses.includes(use),
  )
  // The accessibility tree can list one element twice (a link and the text inside it share a
  // handle); that is one control, not an ambiguity.
  const distinct = new Set(matches.map((control) => control.node))
  return distinct.size === 1 ? Option.fromUndefinedOr(matches[0]) : Option.none()
}
