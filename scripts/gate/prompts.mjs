import * as NodeFS from 'node:fs'
import * as NodePath from 'node:path'
import * as NodeURL from 'node:url'
import { parseSource, walk } from '../syntax.mjs'
import { deadCodeRatchets } from './ratchets.mjs'

const root = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), '..', '..')

/** Where Vivid's own drawing rules are written, in the options OpenUI's prompt generator takes. */
const file = 'packages/agent/runtime/src/agents/displays.ts'

/**
 * The fix the message names. On 11 November 2026 a check-in card said "late" four times, and the
 * answer was three new rules about that one card ("a state is said once", "a Title is five words",
 * "a Feed card is a Title, one Caption and its Buttons"); the developer: "this is not a fucking
 * rule". It had happened before: `b6d77570b`, `f3dd6d396`, `2ebf47250` and `72fdc28b3` each added
 * a rule for the last output read. The model copies the examples; a rule list that grows with every
 * bad card contradicts itself and teaches nothing the examples do not.
 */
const fix =
  'A rule written for one bad output is not a rule. Change the example in EXAMPLES that the model copied, or widen an existing rule so it covers the case, and lower the ceiling in scripts/gate/ratchets.mjs when a rule goes.'

/**
 * The string rules in `additionalRules`, the list Vivid adds to OpenUI's generated prompt. Spread
 * entries (`...LIVE_DATA`) are the live-data syntax, taught once, and are not counted.
 */
export function displayRules(source) {
  let rules = 0
  walk(parseSource(file, source), (node) => {
    if (node.type !== 'Property' || node.key.type !== 'Identifier') return
    if (node.key.name !== 'additionalRules' || node.value.type !== 'ArrayExpression') return
    rules = node.value.elements.filter(
      (element) => element !== null && element.type !== 'SpreadElement',
    ).length
  })
  return rules
}

if (
  process.argv[1] !== undefined &&
  NodePath.resolve(process.argv[1]) === NodeURL.fileURLToPath(import.meta.url)
) {
  const path = process.argv[2] ?? NodePath.join(root, file)
  const rules = displayRules(NodeFS.readFileSync(path, 'utf8'))
  const ceiling = deadCodeRatchets.find((entry) => entry.plugin === 'prompt').ceiling
  if (rules !== ceiling) {
    process.stderr.write(
      `prompt/display-rules: ${file} has ${rules} drawing rules; ceiling ${ceiling}. ${fix}\n`,
    )
    process.exitCode = 1
  }
}
