import * as NodeFS from 'node:fs'
import * as NodeOS from 'node:os'
import * as NodePath from 'node:path'
import { hermesConfigErrors } from './hermes.mjs'
import * as NodeAssert from 'node:assert/strict'
import * as NodeTest from 'node:test'
import { scanSource } from './effect-boundary-audit.mjs'
import { parseJsonc } from './jsonc.mjs'
import { needsDatabase } from './proof/database.mjs'
import { parseSource } from './syntax.mjs'
import { testBodies } from './proof/source.mjs'

const cases = [
  {
    source: 'class Svc { run = async () => 1 }',
    findings: [
      {
        file: 'fixture.ts',
        symbol: 'Svc',
        kind: 'async-function',
        line: 1,
        column: 19,
      },
    ],
  },
  {
    source: 'class A { async #go() { return 1 } }',
    findings: [
      {
        file: 'fixture.ts',
        symbol: '#go',
        kind: 'async-function',
        line: 1,
        column: 11,
      },
    ],
  },
  {
    source: 'const o = { [key]: async () => 1 }',
    findings: [
      {
        file: 'fixture.ts',
        symbol: 'o',
        kind: 'async-function',
        line: 1,
        column: 20,
      },
    ],
  },
  {
    source: "const o = { 'a-b'() : Promise<number> { return Promise.resolve(1) } }",
    findings: [
      {
        file: 'fixture.ts',
        symbol: 'o',
        kind: 'promise-return',
        line: 1,
        column: 13,
      },
    ],
  },
  {
    source: "const o = { 'a-b': async () => 1 }",
    findings: [
      {
        file: 'fixture.ts',
        symbol: 'a-b',
        kind: 'async-function',
        line: 1,
        column: 20,
      },
    ],
  },
  {
    source: 'const o = { 1: async () => 1 }',
    findings: [
      {
        file: 'fixture.ts',
        symbol: 'o',
        kind: 'async-function',
        line: 1,
        column: 16,
      },
    ],
  },
  {
    source: 'interface I { [k: string]: Promise<number> }',
    findings: [
      {
        file: 'fixture.ts',
        symbol: '<module>',
        kind: 'promise-return',
        line: 1,
        column: 15,
      },
    ],
  },
  {
    source: 'export default async () => 1',
    findings: [
      {
        file: 'fixture.ts',
        symbol: '<module>',
        kind: 'async-function',
        line: 1,
        column: 16,
      },
    ],
  },
  {
    source: 'const o = { get v(): Promise<number> { return Promise.resolve(1) } }',
    findings: [
      {
        file: 'fixture.ts',
        symbol: 'v',
        kind: 'promise-return',
        line: 1,
        column: 13,
      },
    ],
  },
  {
    source: 'export async function f(): Promise<number> { return 1 }',
    findings: [
      {
        file: 'fixture.ts',
        symbol: 'f',
        kind: 'async-function',
        line: 1,
        column: 1,
      },
      {
        file: 'fixture.ts',
        symbol: 'f',
        kind: 'promise-return',
        line: 1,
        column: 1,
      },
    ],
  },
  {
    source: 'class A { constructor() { fetch("/") } }',
    findings: [
      {
        file: 'fixture.ts',
        symbol: 'constructor',
        kind: 'raw-fetch',
        line: 1,
        column: 27,
      },
    ],
  },
  {
    source: 'const x = "a b c";\nconst f = async () => 1',
    findings: [
      {
        file: 'fixture.ts',
        symbol: 'f',
        kind: 'async-function',
        line: 4,
        column: 11,
      },
    ],
  },
]

for (const { source, findings } of cases) {
  NodeTest.test(`boundary owners and positions: ${source}`, () => {
    NodeAssert.deepEqual(scanSource('fixture.ts', source), findings)
  })
}

NodeTest.test('reporter spans count Unicode line separators', () => {
  NodeAssert.deepEqual(
    testBodies(
      'fixture.test.ts',
      'const s = "a b c";\ntest("works", () => {\n expect(1).toBe(1)\n})',
    ),
    [
      {
        namedTest: true,
        start: 4,
        end: 6,
        startColumn: 1,
        endColumn: 3,
        bodyStart: 4,
        bodyEnd: 6,
        bodyStartColumn: 21,
        bodyEndColumn: 2,
      },
    ],
  )
})

NodeTest.test('invalid JSONC identifies its config file and offset', () => {
  NodeAssert.throws(
    () => parseJsonc('{"value": @}', 'apps/mobile/tsconfig.json'),
    /apps\/mobile\/tsconfig.json: invalid TypeScript config at offset 10: InvalidSymbol/u,
  )
})

NodeTest.test(
  'dependency declaration names do not become platform library declarations',
  (context) => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), 'vivid-library-'))
    context.after(() => NodeFS.rmSync(directory, { recursive: true, force: true }))
    const files = {
      'hermes.d.ts': 'interface HermesFixture {}',
      'node_modules/sample/lib/lib.custom.d.ts': 'interface DependencyDeclaration {}',
      'apps/mobile/package.json': JSON.stringify({ name: '@vivid/mobile' }),
      'apps/mobile/tsconfig.json': JSON.stringify({
        compilerOptions: { lib: ['ES2022'], types: [] },
        files: ['../../hermes.d.ts', 'src/main.ts'],
      }),
      'apps/mobile/src/main.ts':
        '/// <reference path="../../../node_modules/sample/lib/lib.custom.d.ts" />\nexport const value = 1',
    }
    for (const [file, text] of Object.entries(files)) {
      NodeFS.mkdirSync(NodePath.dirname(NodePath.join(directory, file)), { recursive: true })
      NodeFS.writeFileSync(NodePath.join(directory, file), text)
    }
    NodeAssert.deepEqual(hermesConfigErrors(directory, ['apps/mobile/package.json']), [])
  },
)

NodeTest.test('invalid source stops AST consumers with the file and parse error', () => {
  NodeAssert.throws(() => parseSource('broken.ts', 'const value = ;'), /broken\.ts: .+/u)
})

NodeTest.test('database discovery follows source imports past JSON assets', (context) => {
  NodeFS.mkdirSync('.cache', { recursive: true })
  const root = NodeFS.mkdtempSync(NodePath.resolve('.cache/database-json-'))
  context.after(() => NodeFS.rmSync(root, { recursive: true, force: true }))
  NodeFS.writeFileSync(NodePath.join(root, 'asset.json'), '{"label":"VIVID_TEST_DATABASE_URL"}')
  NodeFS.writeFileSync(
    NodePath.join(root, 'plain.ts'),
    "import asset from './asset.json'; export const label = asset.label",
  )
  NodeAssert.equal(needsDatabase(root, ['plain.ts']), false)
  NodeFS.writeFileSync(
    NodePath.join(root, 'database.ts'),
    'export const url = process.env.VIVID_TEST_DATABASE_URL',
  )
  NodeFS.writeFileSync(
    NodePath.join(root, 'backed.ts'),
    "import './database.js'; import './asset.json'",
  )
  NodeAssert.equal(needsDatabase(root, ['backed.ts']), true)
})
