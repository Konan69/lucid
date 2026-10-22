import * as NodeAssert from 'node:assert/strict'
import * as NodeFS from 'node:fs'
import * as NodePath from 'node:path'
import * as NodeTest from 'node:test'
import { verifyImage } from './images.mjs'

const inputs = [
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  '.pnpmfile.cjs',
  '.npmrc',
  'patches',
]

function fixture(context) {
  NodeFS.mkdirSync('.cache', { recursive: true })
  const root = NodeFS.mkdtempSync(NodePath.resolve('.cache/image-inputs-'))
  context.after(() => NodeFS.rmSync(root, { recursive: true, force: true }))
  NodeFS.writeFileSync(NodePath.join(root, 'package.json'), '{"name":"@vivid/workspace"}')
  NodeFS.writeFileSync(NodePath.join(root, 'pnpm-workspace.yaml'), 'packages: []\n')
  for (const file of ['pnpm-lock.yaml', '.pnpmfile.cjs', '.npmrc', '.dockerignore'])
    NodeFS.writeFileSync(NodePath.join(root, file), '')
  NodeFS.mkdirSync(NodePath.join(root, 'patches'))
  NodeFS.writeFileSync(NodePath.join(root, 'patches/fix.patch'), 'patch')
  return root
}

function verify(root, before, after = '') {
  return verifyImage({
    root,
    dockerfile: `FROM node AS build\n${before}\nRUN pnpm install --filter @vivid/workspace\n${after}\nCOPY . .`,
    stages: { build: ['@vivid/workspace'] },
  })
}

const copies = (files) =>
  files.map((file) => `COPY ${file} ${file === 'patches' ? 'patches' : './'}`).join('\n')

for (const missing of inputs) {
  NodeTest.test(
    `image install requires ${missing} in the same stage before installation`,
    (context) => {
      const root = fixture(context)
      const before = copies(inputs.filter((file) => file !== missing))
      for (const after of ['', copies([missing])])
        NodeAssert.throws(() => verify(root, before, after), {
          message: `build: COPY ${missing} before pnpm install reads root configuration`,
        })
    },
  )
}

NodeTest.test('image install accepts inherited root inputs', (context) => {
  const root = fixture(context)
  NodeAssert.deepEqual(
    verifyImage({
      root,
      dockerfile: `FROM node AS base\n${copies(inputs)}\nFROM base AS build\nRUN pnpm install --filter @vivid/workspace\nCOPY . .`,
      stages: { build: ['@vivid/workspace'] },
    }),
    [],
  )
})

NodeTest.test(
  'image install rejects root inputs copied only into an unrelated stage',
  (context) => {
    const root = fixture(context)
    NodeAssert.throws(
      () =>
        verify(
          root,
          `COPY package.json ./\nFROM node AS other\n${copies(inputs)}\nFROM node AS build\n${copies(inputs.slice(1))}`,
        ),
      /COPY package\.json before pnpm install/u,
    )
  },
)

NodeTest.test('image install rejects ignored root configuration', (context) => {
  const root = fixture(context)
  NodeFS.writeFileSync(NodePath.join(root, '.dockerignore'), '.npmrc\n')
  NodeAssert.throws(() => verify(root, copies(inputs)), /\.dockerignore excludes \.npmrc/u)
})

NodeTest.test('optional root inputs are required only when present', (context) => {
  const root = fixture(context)
  for (const file of ['.pnpmfile.cjs', '.npmrc', 'patches'])
    NodeFS.rmSync(NodePath.join(root, file), { recursive: true })
  NodeAssert.deepEqual(verify(root, copies(inputs.slice(0, 3))), [])
})
