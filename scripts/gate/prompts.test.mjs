import * as NodeAssert from 'node:assert/strict'
import * as NodeTest from 'node:test'
import { displayRules } from './prompts.mjs'

/**
 * The drawing rules are counted the way the policy stage counts them: each string rule, and not
 * the live-data lines spread in. On 11 November 2026 a commit that answered one noisy card with
 * three rules about it counted 11 against a ceiling of 9 and failed.
 */
NodeTest.test('display rules are counted without the live-data spread', () => {
  const source = `const DISPLAYS = generate({ promptOptions: { additionalRules: [...LIVE_DATA, 'one', 'two', \`three\`] } })`
  NodeAssert.equal(displayRules(source), 3)
})
