import * as NodeFS from 'node:fs'
import { Schema } from 'effect'
import { expect, it, vi } from 'vitest'
import { library } from './library'

/**
 * This contract loads the real component definitions and registry. Only drawing dependencies
 * are stubbed because the Node runner has no native host; no renderer or hook is invoked.
 */
/* oxlint-disable anti-slop/no-module-mocking -- Native drawing dependencies cannot load in Node; the real OpenUI definitions and library remain under test. */
vi.mock('react-native', () => ({
  View: 'View',
  Text: 'Text',
  TextInput: 'TextInput',
  Image: 'Image',
  ScrollView: 'ScrollView',
  Pressable: 'Pressable',
  Linking: {},
  StyleSheet: { create: <T>(styles: T) => styles, hairlineWidth: 1 },
}))
vi.mock('react-native-svg', () => ({
  default: 'Svg',
  Circle: 'Circle',
  Defs: 'Defs',
  G: 'G',
  Line: 'Line',
  LinearGradient: 'LinearGradient',
  Path: 'Path',
  Rect: 'Rect',
  Stop: 'Stop',
  Text: 'Text',
}))
vi.mock('lucide-react-native', () => ({ Image: 'Image' }))
vi.mock('../theme', () => ({ useTheme: vi.fn() }))
vi.mock('../ui/motion/Pressable', () => ({ Press: 'Press' }))
vi.mock('../ui/ui', () => ({ Segmented: 'Segmented', MONO: 'monospace' }))
/* oxlint-enable anti-slop/no-module-mocking */

const PromptSpec = Schema.Struct({
  components: Schema.Record(
    Schema.String,
    Schema.Struct({ signature: Schema.String, description: Schema.String }),
  ),
})

const decodePromptSpec = Schema.decodeUnknownSync(Schema.fromJsonString(PromptSpec))

/** The web-generated prompt spec owns which display names the model can send to the phone. */
it('registers exactly the display names advertised to the model', () => {
  const spec = decodePromptSpec(
    NodeFS.readFileSync(
      new URL('../../../../packages/agent/runtime/src/agents/parts.json', import.meta.url),
      'utf8',
    ),
  )

  expect(Object.keys(library.components).toSorted()).toEqual(
    Object.keys(spec.components).toSorted(),
  )
})
