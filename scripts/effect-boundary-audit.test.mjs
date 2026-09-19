import * as NodeAssert from 'node:assert/strict'
import * as NodeTest from 'node:test'
import {

  buildReport,
  formatSummary,
  isProductionTypeScript,
  scanSource,
  validateAllowlist,
} from './effect-boundary-audit.mjs'

const assert = NodeAssert
const test = NodeTest.default
const fixtureFile = 'packages/contracts/src/audit-fixture.ts'
const fixtureSource = `
import { Result } from "better-result";

export async function load(): Promise<string> {
  try {
    const first = await fetch("https://example.test");
    await Effect.runPromise(program);
    return await Effect.tryPromise(() => Promise.all([first.text()]));
  } catch (cause) {
    return await new Promise((resolve) => resolve(String(cause)));
  }
}

export const settle = () => Promise.allSettled([]);
export const callback = Effect.async((resume) => resume(Effect.succeed(1)));
export const lazy = Effect.promise(() => Promise.resolve(1));
`

/** The fixture exercises every inventoried syntax family with stable owning symbols. */
void test('inventories requested boundary syntax with enclosing symbols', () => {
  const findings = scanSource(fixtureFile, fixtureSource)
  const kinds = findings.map((finding) => finding.kind).toSorted((left, right) => left.localeCompare(right))

  assert.deepEqual(kinds, [
    'async-function',
    'await',
    'await',
    'await',
    'await',
    'better-result-import',
    'effect-async-adapter',
    'effect-promise-adapter',
    'effect-run-promise',
    'effect-try-promise',
    'promise-all',
    'promise-all-settled',
    'promise-constructor',
    'promise-return',
    'raw-fetch',
    'try-catch',
  ])
  const asyncFunction = findings.find((finding) => finding.kind === 'async-function')
  const settled = findings.find((finding) => finding.kind === 'promise-all-settled')
  assert.ok(asyncFunction)
  assert.ok(settled)
  assert.equal(asyncFunction.symbol, 'load')
  assert.equal(settled.symbol, 'settle')
})

/** Exclusions protect the production signal without hiding similarly named domain modules. */
void test('selects tracked production TypeScript paths narrowly', () => {
  assert.equal(isProductionTypeScript('apps/server/src/config.ts'), true)
  assert.equal(isProductionTypeScript('packages/contracts/src/schema.ts'), true)
  assert.equal(isProductionTypeScript('apps/web/src/App.tsx'), false)
  assert.equal(isProductionTypeScript('packages/contracts/src/example.test.ts'), false)
  assert.equal(isProductionTypeScript('packages/contracts/src/route.gen.ts'), false)
  assert.equal(isProductionTypeScript('packages/contracts/src/types.d.ts'), false)
})

/** Grouping symbols by file remains exact while duplicates, wildcards, and stale entries fail loudly. */
void test('validates exact allowlist entries', () => {
  const findings = scanSource(fixtureFile, fixtureSource)
  const exact = [{ file: fixtureFile, symbols: ['load'], classification: 'legacy-runtime-boundary' }]
  assert.equal(validateAllowlist(exact, findings).size, 1)
  assert.throws(() => validateAllowlist([...exact, ...exact], findings), /Duplicate allowlist entry/u)
  assert.throws(
    () =>
      validateAllowlist(
        [{ file: 'packages/**', symbols: ['load'], classification: 'legacy' }],
        findings,
      ),
    /wildcard/u,
  )
  assert.throws(
    () =>
      validateAllowlist(
        [{ file: fixtureFile, symbols: ['removed'], classification: 'legacy' }],
        findings,
      ),
    /Stale allowlist entry/u,
  )
})

/** JSON-facing reports remain ordered and enforce mode still exposes migration debt. */
void test('builds deterministic reports and readable summaries', () => {
  const findings = scanSource(fixtureFile, fixtureSource)
  const allowed = validateAllowlist(
    [{ file: fixtureFile, symbols: ['load'], classification: 'legacy-runtime-boundary' }],
    findings,
  )
  const report = buildReport('report', [fixtureFile], findings.toReversed(), allowed)

  assert.equal(report.filesScanned, 1)
  assert.equal(report.totalFindings, 16)
  assert.equal(report.unallowlistedFindings, 4)
  assert.equal(report.counts['promise-all'], 1)
  assert.match(formatSummary(report), /16 findings; 4 unallowlisted/u)
  assert.deepEqual(report.findings, buildReport('report', [fixtureFile], findings, allowed).findings)
})
