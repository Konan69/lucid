/**
 * Legacy lint warnings are ratcheted per rule. Each ceiling is a limit, not an allowance: lower
 * it whenever a change removes findings, and never raise one to land a change. This table is the
 * one definition; the push hook, the Cloudbox run and GitHub all count against it through
 * `scripts/gate.mjs`.
 */
export const ratchets = [
  {
    label: 'chained assertions',
    plugin: 'anti-slop',
    rule: 'no-chained-type-assertions',
    ceiling: 0,
  },
  {
    label: 'conditional empty spreads',
    plugin: 'anti-slop',
    rule: 'no-conditional-empty-object-spread',
    ceiling: 0,
  },
  { label: 'runtime typeof', plugin: 'anti-slop', rule: 'no-runtime-typeof', ceiling: 0 },
  { label: 'shape names', plugin: 'anti-slop', rule: 'no-shape-in-symbol-names', ceiling: 0 },
  { label: 'unknown parameters', plugin: 'anti-slop', rule: 'no-unknown-parameters', ceiling: 0 },
  // Added with the 20 Sep 2026 anti-slop re-vendor and cleared the same day.
  {
    label: 'manual tag comparisons',
    plugin: 'anti-slop-effect',
    rule: 'no-manual-tag-comparison',
    ceiling: 0,
  },
  {
    label: 'manual tagged construction',
    plugin: 'anti-slop-effect',
    rule: 'no-manual-tagged-construction',
    ceiling: 0,
  },
  {
    label: 'literal ternary chains',
    plugin: 'anti-slop-effect',
    rule: 'prefer-effect-match',
    ceiling: 0,
  },
  { label: 'map-then-filter passes', plugin: 'anti-slop', rule: 'no-array-filter-map', ceiling: 0 },
  {
    label: 'reduce accumulator copies',
    plugin: 'anti-slop',
    rule: 'no-reduce-accumulator-copy',
    ceiling: 0,
  },
  { label: 'unknown returns', plugin: 'anti-slop', rule: 'no-unknown-returns', ceiling: 0 },
  {
    label: 'unsafe dictionaries',
    plugin: 'anti-slop',
    rule: 'no-unsafe-dictionary-type',
    ceiling: 0,
  },
  {
    label: 'unjustified assertions',
    plugin: 'anti-slop',
    rule: 'require-safety-comment-for-type-assertion',
    ceiling: 0,
  },
  { label: 'explicit any', plugin: 'typescript', rule: 'no-explicit-any', ceiling: 0 },
  {
    label: 'async collection callbacks',
    plugin: 'vivid',
    rule: 'no-async-callback-api',
    ceiling: 0,
  },
  { label: 'direct process env', plugin: 'vivid', rule: 'no-direct-process-env', ceiling: 0 },
  {
    label: 'Effect service methods without Effect.fn',
    plugin: 'vivid',
    rule: 'effect-require-effect-fn',
    ceiling: 0,
  },
  {
    label: 'global process runtime reads',
    plugin: 'vivid',
    rule: 'no-global-process-runtime',
    ceiling: 0,
  },
  // Complexity ceilings match VCOS (classic complexity 12, 120-line functions, depth 3).
  { label: 'cyclomatic complexity', plugin: 'eslint', rule: 'complexity', ceiling: 0 },
  { label: 'long functions', plugin: 'eslint', rule: 'max-lines-per-function', ceiling: 0 },
  { label: 'nested callbacks', plugin: 'eslint', rule: 'max-nested-callbacks', ceiling: 0 },
  { label: 'wide parameter lists', plugin: 'eslint', rule: 'max-params', ceiling: 0 },
  { label: 'deep nesting', plugin: 'eslint', rule: 'max-depth', ceiling: 0 },
  {
    label: 'host transform validation',
    plugin: 'vivid',
    rule: 'no-host-transform-validation',
    ceiling: 0,
  },
  {
    label: 'inline Schema compilers',
    plugin: 'vivid',
    rule: 'no-inline-schema-compile',
    ceiling: 0,
  },
  { label: 'non-null assertions', plugin: 'vivid', rule: 'no-non-null-assertion', ceiling: 0 },
  { label: 'optional chaining', plugin: 'vivid', rule: 'no-optional-chaining', ceiling: 0 },
  {
    label: 'platform runtime terminals',
    plugin: 'vivid',
    rule: 'no-platform-runtime-runmain-in-library',
    ceiling: 0,
  },
  {
    label: 'raw Promise constructors',
    plugin: 'vivid',
    rule: 'no-promise-constructor',
    ceiling: 0,
  },
  {
    label: 'library runtime terminals',
    plugin: 'vivid',
    rule: 'no-runpromise-in-library',
    ceiling: 0,
  },
  {
    label: 'Node built-in import namespaces',
    plugin: 'vivid',
    rule: 'namespace-node-imports',
    ceiling: 0,
  },
  { label: 'try/catch', plugin: 'vivid', rule: 'no-try-catch', ceiling: 0 },
  { label: 'undefined unions', plugin: 'vivid', rule: 'no-undefined-in-union', ceiling: 0 },
  {
    label: 'unnamed Effect programs',
    plugin: 'vivid',
    rule: 'require-named-effect-fn',
    ceiling: 0,
  },
  { label: 'Schema class titles', plugin: 'vivid', rule: 'require-schema-class-title', ceiling: 0 },
  {
    label: 'unvalidated parsed JSON',
    plugin: 'vivid',
    rule: 'require-schema-decode-in-boundary',
    ceiling: 0,
  },
  {
    label: 'derived state Effects',
    plugin: 'vivid',
    rule: 'react-no-derived-state-effect',
    ceiling: 0,
  },
  {
    label: 'inline Context values',
    plugin: 'vivid',
    rule: 'react-no-inline-context-value',
    ceiling: 0,
  },
  { label: 'design-system raw colors', plugin: 'shadcn', rule: 'no-raw-colors', ceiling: 0 },
  {
    label: 'design-system arbitrary values',
    plugin: 'shadcn',
    rule: 'no-arbitrary-values',
    ceiling: 0,
  },
  { label: 'design-system inline styles', plugin: 'shadcn', rule: 'no-inline-styles', ceiling: 0 },
  {
    label: 'design-system unknown classes',
    plugin: 'shadcn',
    rule: 'no-unknown-classes',
    ceiling: 0,
  },
  {
    label: 'Tailwind class conflicts',
    plugin: 'tailwindcss',
    rule: 'no-conflicting-classes',
    ceiling: 0,
  },
  {
    label: 'Tailwind canonical syntax',
    plugin: 'tailwindcss',
    rule: 'enforce-canonical',
    ceiling: 0,
  },
  { label: 'Tailwind class order', plugin: 'tailwindcss', rule: 'enforce-sort-order', ceiling: 0 },
  { label: 'Tailwind shorthand', plugin: 'tailwindcss', rule: 'enforce-shorthand', ceiling: 0 },
]

/**
 * oxlint prints a finding's rule as `plugin(rule)` in its default format and `plugin/rule` in the
 * others. A finding is one output line naming the rule, as the shell hook counted them
 * (`grep -E -c "plugin(\(|/)rule"`). That pattern also matched any longer rule name starting
 * with this one; here the name must end, so a ratchet counts its own rule and no other.
 */
export function countFindings(lintOutput, ratchet) {
  const named = `${ratchet.plugin}(${ratchet.rule})`
  const path = `${ratchet.plugin}/${ratchet.rule}`
  // Every occurrence is tried: a file path earlier in the line may hold the same words
  // followed by more of a name, and must not hide the rule field after it.
  const ends = (line) =>
    line
      .split(path)
      .slice(1)
      .some((after) => !/^[\w-]/u.test(after))
  return lintOutput.split('\n').filter((line) => line.includes(named) || ends(line)).length
}

/** Every ratchet against one lint output: its count, its ceiling and whether it held. */
export function checkRatchets(lintOutput) {
  return ratchets.map((ratchet) => {
    const count = countFindings(lintOutput, ratchet)
    return { label: ratchet.label, ceiling: ratchet.ceiling, count, held: count <= ratchet.ceiling }
  })
}

/**
 * Effect language service findings, ratcheted per rule like the lint warnings above. Until
 * 7 Oct 2026 nothing enforced them: the repository patched the JavaScript `typescript` package
 * (`effect-language-service patch`), but typecheck runs the native TypeScript 7 compiler, which
 * that patch does not reach, so a floating Effect passed the gate. `@effect/tsgo` patches the
 * native compiler; its first run reported what had gathered meanwhile. The compiler prints every
 * finding and still exits 0 (the `ignoreEffect...InTscExitCode` options in tsconfig.base.json);
 * these ceilings are what fail the gate. A rule that is not listed has a ceiling of 0.
 * Lower a ceiling whenever findings go; never raise one.
 */
export const effectCeilings = {
  strictEffectProvide: 741,
  unnecessaryFailYieldableError: 406,
  schemaNumber: 188,
  asyncFunction: 84,
  multipleEffectProvide: 52,
  preferSucceedSomeOrNone: 28,
  effectFnIife: 22,
  lazyEffect: 21,
  missingReturnYieldStar: 20,
  globalErrorInEffectFailure: 15,
  catchToOrElseSucceed: 13,
  unnecessaryTypeofType: 13,
  timeoutCatchTagToTimeoutOrElse: 9,
  TS377030: 9,
  multipleCatchTag: 8,
  runEffectInsideEffect: 8,
  mapSomeToAsSome: 7,
  schemaStructWithTag: 5,
  preferTypedSchemaDecoder: 4,
  optionMatchToFromOption: 3,
  returnEffectInGen: 3,
  unknownInEffectCatch: 3,
  globalErrorInEffectCatch: 2,
  layerMergeAllWithDependencies: 2,
  provideLayerSucceedToProvideService: 2,
  abortControllerInEffect: 1,
  allOfMapToForEach: 1,
  catchConditionalRefailToCatchIf: 1,
  catchToIgnore: 1,
  effectFnImplicitAny: 1,
  flatMapConditionalToFilterOrFail: 1,
  floatingEffect: 1,
  raceFirstWithSleepToTimeout: 1,
  unnecessaryEffectGen: 1,
}

/** Whether any ceiling is above zero, that is, whether a patched compiler must print something. */
export const effectFindingsExpected = Object.values(effectCeilings).some((ceiling) => ceiling > 0)

/**
 * The rule of one compiler output line, when the line is an Effect finding. The patched compiler
 * gives every Effect diagnostic a code in the 377000s and ends a one-line message with
 * `effect(<rule>)`. A message that continues on later lines carries only its code on the first
 * one, and is then counted under that code.
 */
export function effectRule(line) {
  const code = /\): (?:error|warning|suggestion|message) (TS377\d+): /u.exec(line)
  if (code === null) return undefined
  const named = /effect\((\w+)\)\s*$/u.exec(line)
  return named === null ? code[1] : named[1]
}

/** Each rule's count against its ceiling, for the rules found or listed. */
export function checkEffectRatchets(findings) {
  const counts = new Map(Object.keys(effectCeilings).map((rule) => [rule, 0]))
  for (const line of findings) {
    const rule = effectRule(line)
    if (rule !== undefined) counts.set(rule, (counts.get(rule) ?? 0) + 1)
  }
  return [...counts].map(([rule, count]) => {
    const ceiling = effectCeilings[rule] === undefined ? 0 : effectCeilings[rule]
    return { rule, count, ceiling, held: count <= ceiling }
  })
}
