import * as NodeAssert from 'node:assert/strict'
import * as NodeChildProcess from 'node:child_process'
import * as NodeFS from 'node:fs'
import * as NodeOS from 'node:os'
import * as NodePath from 'node:path'
import * as NodeTest from 'node:test'
import * as NodeURL from 'node:url'
import * as Result from 'effect/Result'
import * as Schema from 'effect/Schema'

const assert = NodeAssert
const { execFileSync } = NodeChildProcess
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = NodeFS
const { tmpdir } = NodeOS
const path = NodePath
const test = NodeTest.default
const { fileURLToPath } = NodeURL
const OxlintOutputSchema = Schema.Struct({
  diagnostics: Schema.Array(Schema.Struct({ code: Schema.String, message: Schema.String })),
})
const ProcessFailureSchema = Schema.Struct({ stdout: Schema.String })
const decodeProcessFailure = Schema.decodeUnknownResult(ProcessFailureSchema)
const decodeOxlintOutput = Schema.decodeUnknownSync(Schema.fromJsonString(OxlintOutputSchema))

const scriptsDirectory = path.dirname(fileURLToPath(import.meta.url))
const repositoryRoot = path.resolve(scriptsDirectory, '..')
const oxlint = path.join(repositoryRoot, 'node_modules', '.bin', 'oxlint')
const plugin = path.join(scriptsDirectory, 'oxlint-plugin-vivid.mjs')

const cases = [
  ['no-try-catch', 'try { work() } catch {}', 'work()'],
  ['no-non-null-assertion', 'const value = input!', 'const value = input'],
  ['no-optional-chaining', 'const value = input?.value', 'const value = input.value'],
  ['no-undefined-in-union', 'type Value = string | undefined', 'type Value = string | null'],
  ['no-direct-process-env', 'const value = process.env.KEY', 'const value = config.KEY'],
  ['no-global-process-runtime', 'const value = process.platform', 'const value = runtime.platform'],
  ['no-runtime-env-mutation', "process.env.KEY = 'x'", 'config.setKey()'],
  [
    'no-promise-constructor',
    'const value = new Promise(() => {})',
    'const value = Effect.async(() => {})',
  ],
  [
    'no-runpromise-nested',
    'const value = Effect.gen(function* () { Effect.runPromise(program); yield* program })',
    'const value = Effect.gen(function* () { return yield* program })',
  ],
  ['no-runpromise-in-library', 'Effect.runPromise(program)', 'const programValue = program'],
  [
    'no-runpromise-in-library',
    'Effect.runPromiseWith(context)(program)',
    'const programValue = program',
  ],
  [
    'no-runpromise-nested',
    'const value = Effect.gen(function* () { Effect.runForkWith(context)(program); yield* program })',
    'const value = Effect.gen(function* () { return yield* program })',
  ],
  [
    'no-platform-runtime-runmain-in-library',
    'NodeRuntime.runMain(program)',
    'const programValue = program',
  ],
  ['no-effect-runtime-api', 'Runtime.runPromise(runtime)(program)', 'const programValue = program'],
  ['no-unnecessary-die', 'Effect.orDie(program)', 'Effect.catchTag(program, "Expected", recover)'],
  [
    'no-effect-catch-raw-error',
    "Effect.catchAll(program, () => Effect.fail(new Error('bad')))",
    'Effect.catchAll(program, () => Effect.fail(new DomainError({})))',
  ],
  ['no-effect-option-constructors', 'Effect.some(value)', 'Option.some(value)'],
  [
    'no-direct-schema-safeparse',
    'UserSchema.safeParse(value)',
    'Schema.decodeUnknownEither(UserSchema)(value)',
  ],
  [
    'no-inline-schema-compile',
    'const parse = (input) => Schema.decodeUnknownEffect(UserSchema)(input)',
    'const decodeUser = Schema.decodeUnknownEffect(UserSchema); const parse = (input) => decodeUser(input)',
  ],
  [
    'no-manual-effect-runtime-in-tests',
    "import { it } from '@effect/vitest'; it('x', () => Effect.runPromise(program))",
    "import test from 'node:test'; test('x', () => Effect.runPromise(program))",
    'module.test.ts',
  ],
  [
    'namespace-node-imports',
    "import path from 'node:path'",
    "import * as NodePath from 'node:path'",
  ],
  ['no-parse-method-alias', 'const { parse } = UserSchema', 'const schema = UserSchema'],
  [
    'require-schema-class-identifier',
    'class User extends Schema.Class<User>()({ name: Schema.String }) {}',
    "class User extends Schema.Class<User>('User')({ name: Schema.String }) {}",
  ],
  [
    'require-schema-class-title',
    "class User extends Schema.Class<User>('User')({ name: Schema.String }) {}",
    "class User extends Schema.Class<User>('User')({ name: Schema.String }, { title: 'User' }) {}",
  ],
  [
    'require-schema-decode-in-boundary',
    "JSON.parse('{}')",
    'Schema.decodeUnknownSync(Payload)({})',
  ],
  [
    'require-named-effect-fn',
    'const load = Effect.gen(function* () { yield* task })',
    "const load = Effect.fn('load')(function* () { yield* task })",
  ],
  [
    'effect-prefer-match-effect',
    "Effect.match(program, { onFailure: () => Effect.fail('x'), onSuccess: Effect.succeed })",
    "Effect.matchEffect(program, { onFailure: () => Effect.fail('x'), onSuccess: Effect.succeed })",
  ],
  [
    'no-async-callback-api',
    'items.map(async (item) => item)',
    'Effect.forEach(items, (item) => Effect.succeed(item))',
  ],
  [
    'no-effect-wrapper-for-sync-callback-api',
    'Effect.promise(() => items.map((item) => item))',
    'Effect.sync(() => items.map((item) => item))',
  ],
  ['no-host-transform-validation', 'request.json()', 'Schema.decodeUnknownEffect(Payload)(body)'],
  [
    'effect-no-service-inside-method',
    'const service = Store.of({ run: () => Effect.gen(function* () { const clock = yield* Clock; return clock }) })',
    'const service = Store.of({ run: () => Effect.succeed(clock) })',
  ],
  ['effect-no-context-generic-service', "Context.GenericTag('Store')", "Context.Service('Store')"],
  [
    'effect-no-service-accessor',
    "class Store extends Context.Service<Store, Shape>()('Store') { static run() {} }",
    "class Store extends Context.Service<Store, Shape>()('Store') {}",
  ],
  [
    'effect-no-service-object-syntax',
    "class Store extends Context.Service<Store, { run: () => void }>()('Store') {}",
    "class Store extends Context.Service<Store, StoreShape>()('Store') {}",
  ],
  [
    'effect-require-effect-fn',
    'const service = { run: (): Effect.Effect<string> => Effect.succeed("ok") }',
    "const service = { run: Effect.fn('Store.run')(function* () { return 'ok' }) }",
  ],
  [
    'no-config-provider-from-env-in-library',
    'ConfigProvider.fromEnv()',
    'const provider = AppConfigProvider',
  ],
  [
    'better-auth-secure-options',
    'const options = { migrate: true }',
    'const options = { migrate: false }',
    'apps/server/src/auth/provider.ts',
  ],
  [
    'require-drizzle-config-paths',
    "defineConfig({ dialect: 'postgresql' })",
    "defineConfig({ dialect: 'postgresql', schema: './src/schema.ts', out: './drizzle' })",
    'drizzle.config.ts',
  ],
  [
    'prefer-state-match',
    "if (run.status === 'queued') { start() } else if (run.status === 'working') { wait() }",
    "if (run.status === 'queued') { start() }",
  ],
  [
    'react-no-derived-state-effect',
    'useEffect(() => { setValue(input) }, [input])',
    'const value = derive(input)',
    'component.tsx',
  ],
  [
    'react-no-inline-context-value',
    '<Context.Provider value={{ item }} />',
    '<Context.Provider value={contextValue} />',
    'component.tsx',
  ],
  [
    'react-no-state-after-wait',
    'const [busy, setBusy] = useState(false); async function save() { setBusy(true); await send(); setBusy(false) }',
    'const [busy, setBusy] = useState(false); async function save() { setBusy(true); await send() }',
    'component.tsx',
  ],
  [
    'react-no-useless-memo',
    'useMemo(() => input, [input])',
    'useMemo(() => derive(input), [input])',
    'component.tsx',
  ],
]

/** Lint one isolated snippet with exactly one Vivid rule enabled. */
function lint(ruleName, source, filename = 'module.ts') {
  const directory = mkdtempSync(path.join(tmpdir(), 'vivid-oxlint-'))
  try {
    const sourcePath = path.join(directory, filename)
    const configPath = path.join(directory, 'oxlint.json')
    NodeFS.mkdirSync(path.dirname(sourcePath), { recursive: true })
    writeFileSync(sourcePath, source)
    writeFileSync(
      configPath,
      JSON.stringify({
        jsPlugins: [{ name: 'vivid', specifier: plugin }],
        rules: { [`vivid/${ruleName}`]: 'error' },
      }),
    )
    try {
      const output = execFileSync(
        oxlint,
        ['--config', configPath, '--format', 'json', sourcePath],
        {
          cwd: repositoryRoot,
          encoding: 'utf8',
        },
      )
      return decodeOxlintOutput(output).diagnostics
    } catch (cause) {
      const failure = decodeProcessFailure(cause)
      if (Result.isFailure(failure)) throw cause
      return decodeOxlintOutput(failure.success.stdout).diagnostics
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

const ruleDiagnostics = (ruleName, diagnostics) =>
  diagnostics.filter((diagnostic) => diagnostic.code === `vivid(${ruleName})`)

for (const [ruleName, invalid, valid, filename] of cases) {
  void test(`${ruleName} reports the forbidden form and accepts the owned alternative`, () => {
    assert.equal(ruleDiagnostics(ruleName, lint(ruleName, invalid, filename)).length, 1)
    assert.equal(ruleDiagnostics(ruleName, lint(ruleName, valid, filename)).length, 0)

    if (ruleName === 'no-inline-schema-compile') {
      const medium = lint(
        ruleName,
        'const parse = (input) => Schema.decodeUnknownEffect(UserSchema)(input)',
      )
      const high = lint(
        ruleName,
        'const parse = (input) => Schema.decodeUnknownEffect(Schema.Struct({ value: Schema.String }))(input)',
      )
      const mediumFindings = ruleDiagnostics(ruleName, medium)
      const highFindings = ruleDiagnostics(ruleName, high)
      const mediumFinding = mediumFindings[0]
      const highFinding = highFindings[0]
      assert.ok(mediumFinding)
      assert.ok(highFinding)
      assert.match(mediumFinding.message, /compiled function is rebuilt/u)
      assert.doesNotMatch(mediumFinding.message, /inline schema literal/u)
      assert.match(highFinding.message, /inline schema literal and the compiled function/u)
    }

    if (ruleName === 'no-manual-effect-runtime-in-tests') {
      const vitestSource = [
        "import { it } from '@effect/vitest'",
        "it('runs', () => Effect.runPromise(program))",
        "it('syncs', () => Effect.runSync(program))",
        "it('forks', () => Effect.runFork(program))",
      ].join('\n')
      assert.equal(
        ruleDiagnostics(ruleName, lint(ruleName, vitestSource, 'runtime.test.ts')).length,
        3,
      )
      const nodeTestSource =
        "import test from 'node:test'; test('runs', () => Effect.runSync(program))"
      assert.equal(
        ruleDiagnostics(ruleName, lint(ruleName, nodeTestSource, 'adapter.test.ts')).length,
        0,
      )
    }

    if (ruleName === 'no-runpromise-in-library') {
      assert.equal(
        ruleDiagnostics(ruleName, lint(ruleName, 'Effect.runFork(program)', 'app.ts')).length,
        0,
      )
      assert.equal(
        ruleDiagnostics(ruleName, lint(ruleName, 'Effect.runSync(config)', 'drizzle.config.ts'))
          .length,
        0,
      )
      assert.equal(
        ruleDiagnostics(ruleName, lint(ruleName, 'Effect.runSync(config)', 'alchemy.run.ts'))
          .length,
        0,
      )
      const flueBoundary = 'defineTool({ async run() { return Effect.runPromise(program) } })'
      assert.equal(ruleDiagnostics(ruleName, lint(ruleName, flueBoundary)).length, 0)
    }

    if (ruleName === 'no-platform-runtime-runmain-in-library') {
      assert.equal(
        ruleDiagnostics(ruleName, lint(ruleName, 'NodeRuntime.runMain(program)', 'main.ts')).length,
        0,
      )
    }

    if (ruleName === 'effect-require-effect-fn') {
      const callback = 'const options = { catch: () => Effect.fail(new DomainError({})) }'
      assert.equal(ruleDiagnostics(ruleName, lint(ruleName, callback)).length, 0)
    }

    if (ruleName === 'react-no-state-after-wait') {
      const count = (source) =>
        ruleDiagnostics(ruleName, lint(ruleName, source, 'component.tsx')).length
      const state = 'const [said, setSaid] = useState(null); '
      const late = [
        // An Effect.gen body waits at each `yield*`.
        'const save = Effect.gen(function* () { const answer = yield* send(); setSaid(answer) })',
        // A callback given to then, catch or finally runs when the wait is over.
        'function save() { send().then((answer) => setSaid(answer)) }',
        'function save() { send().catch(() => setSaid(null)) }',
        'function save() { send().finally(() => setSaid(null)) }',
        // `React.useState` is the same hook.
        'const [busy, setBusy] = React.useState(false); async function go() { await send(); setBusy(false) }',
      ]
      for (const source of late) {
        assert.equal(count(source.startsWith('const [busy') ? source : state + source), 1, source)
      }
      const owned = [
        // Before the wait, and inside what is awaited, nothing has been waited for yet.
        'async function save() { setSaid(null); await send() }',
        'async function save() { await send(setSaid(null)) }',
        // A plain `yield` hands a value out; only `yield*` waits on other work.
        'function* steps() { yield 1; setSaid(null) }',
        // A function that never waits, and a setter that is not one of this file's.
        'function clear() { setSaid(null) }',
        'async function save() { await send(); setOther(null) }',
      ]
      for (const source of owned) assert.equal(count(state + source), 0, source)
      // What the rule does not follow, stated so nobody takes its silence for proof: a helper
      // that sets state and is called after the wait, and a branch that waited and returned
      // (the second is reported although its path never waited).
      assert.equal(
        count(
          state + 'async function save() { const end = () => setSaid(null); await send(); end() }',
        ),
        0,
      )
      assert.equal(
        count(state + 'async function save(x) { if (x) { await send(); return } setSaid(null) }'),
        1,
      )
    }

    if (ruleName === 'prefer-state-match') {
      const count = (source) => ruleDiagnostics(ruleName, lint(ruleName, source)).length
      const dispatches = [
        // Generated Schema.TaggedUnion guards on one union and value.
        'if (RunState.guards.Queued(run)) { start() } else if (RunState.guards.Working(run)) { wait() }',
        // A braced else whose first statement is the next check; `;` and later work change nothing.
        "if (phase === 'draft') { edit() } else { ; if (phase === 'sent') { archive() } log() }",
        // Contiguous return guards, with a harmless empty statement between them.
        "function label(state) { if (state === 'a') return 1;; if (state === 'b') return 2; return 3 }",
        // A subset predicate is one branch; a second branch makes it a dispatch.
        "if (RunState.isAnyOf(['Queued', 'Working'])(run)) { wait() } else if (RunState.guards.Failed(run)) { retry() }",
        // Sequential return guards.
        "function label(run) { if (run.status === 'queued') return 'Queued'; if (run.status === 'working') return 'Working'; return 'Done' }",
        // One finding per dispatch, however many branches it has.
        "if (item.kind === 'file' || item.kind === 'folder') { open() } else if (item.kind === 'link') { visit() } else if (item.kind === 'note') { read() }",
      ]
      for (const source of dispatches) assert.equal(count(source), 1, source)

      const legitimate = [
        // A single refinement, positive or negative.
        'if (RunState.guards.Failed(run)) { retry() }',
        "if (run.status !== 'working') return; if (run.status !== 'queued') return",
        // Unrelated predicates in the same chain.
        "if (run.status === 'queued') { start() } else if (run.attempts > 3) { stop() }",
        "if (run.status === 'queued' && run.ready) { start() } else if (run.status === 'working' && run.stale) { stop() }",
        // Different subjects, and the same case asked twice.
        "if (run.status === 'queued') { start() } else if (other.status === 'working') { wait() }",
        'if (RunState.guards.Queued(run)) { start() } else if (RunState.guards.Working(other)) { wait() }',
        "if (run.status === 'queued') return 1; if (run.status === 'queued') return 2",
        // Sequential checks that fall through are independent steps, not a dispatch.
        "if (run.status === 'queued') { start() } if (run.status === 'working') { wait() }",
        // Open vocabularies and unstable subjects.
        "if (node.type === 'A') { a() } else if (node.type === 'B') { b() }",
        "if (read().status === 'queued') { start() } else if (read().status === 'working') { wait() }",
        // The subject is reassigned or mutated between the checks: two observations, not one.
        "function f(state) { if (state === 'a') return 1; state = 'b'; if (state === 'b') return 2 }",
        "function f(run) { if (run.status === 'queued') return 1; run.status = 'working'; if (run.status === 'working') return 2 }",
        'function f(run) { if (RunState.guards.Queued(run)) return 1; run = advance(run); if (RunState.guards.Working(run)) return 2 }',
        // An intervening call may change the subject, in a guard run and in a braced else.
        "function f(run) { if (run.status === 'queued') return 1; refresh(run); if (run.status === 'working') return 2 }",
        "function f(run) { if (run.status === 'queued') return 1; const next = load(); if (run.status === 'working') return next }",
        "if (phase === 'draft') { edit() } else { log(); if (phase === 'sent') { archive() } }",
        "if (phase === 'draft') { edit() } else { phase = next(); if (phase === 'sent') { archive() } }",
        // A declaration before the inner check runs code, so the braced else is not one dispatch.
        "if (phase === 'draft') { edit() } else { const next = load(); if (phase === 'sent') { archive(next) } }",
        // A first branch that mutates and falls through is followed by a fresh observation.
        "function f(run) { if (run.status === 'queued') { advance(run) } if (run.status === 'working') return 2 }",
        // A branch that only sometimes ends control flow lets its own work reach the next check.
        "function f(run) { if (run.status === 'queued') { if (retry(run)) return 1 } if (run.status === 'working') return 2 }",
        // A loop or a nested block between two guards may run anything.
        "function f(run) { if (run.status === 'queued') return 1; while (step(run)) {} if (run.status === 'working') return 2 }",
        "function f(run) { if (run.status === 'queued') return 1; { refresh(run) } if (run.status === 'working') return 2 }",
        // A guard with an else is its own statement, not the next guard of a run.
        "function f(run) { if (run.status === 'queued') return 1; if (run.status === 'working') { wait() } else { refresh(run) } }",
        // The scan stops at an unrelated guard; it never skips ahead to a later check.
        "function f(run) { if (run.status === 'queued') return 1; if (stale()) return 0; if (run.status === 'working') return 2 }",
        // An alias is a different binding, and may hold an older value.
        "function f(run) { const status = run.status; if (run.status === 'queued') return 1; if (status === 'working') return 2 }",
        // The same parameter name in two functions is two values.
        "function a(state) { if (state === 'a') return 1; return 0 } function b(state) { if (state === 'b') return 2; return 0 }",
        "function f(kind, items) { if (kind === 'a') return items.map((kind) => { if (kind === 'b') return 1; return 0 }); return [] }",
        // A nested function starts its own scope.
        "if (run.status === 'queued') { start() } else { later(() => { if (run.status === 'working') { wait() } }) }",
      ]
      for (const source of legitimate) assert.equal(count(source), 0, source)

      const nested =
        "const outer = () => { const inner = () => { if (kind === 'a') return 1; if (kind === 'b') return 2; return 3 }; if (kind === 'a') return inner(); return 0 }"
      assert.equal(count(nested), 1)
      // A callback's own dispatch is still reported, once, and never merged with the outer check.
      const callback =
        "function f(kind, items) { if (kind === 'a') return items.map((kind) => { if (kind === 'b') return 1; if (kind === 'c') return 2; return 0 }); if (kind === 'd') return [] }"
      const callbackFindings = ruleDiagnostics(ruleName, lint(ruleName, callback))
      assert.equal(callbackFindings.length, 2)
      assert.ok(callbackFindings.some((entry) => /\(a, d\)/u.test(entry.message)))
      assert.ok(callbackFindings.some((entry) => /\(b, c\)/u.test(entry.message)))
      const [finding] = ruleDiagnostics(ruleName, lint(ruleName, dispatches[0]))
      assert.ok(finding)
      assert.match(finding.message, /Queued, Working/u)
      assert.match(finding.message, /Union\.match\(value/u)
      assert.doesNotMatch(finding.message, /\$match/u)
    }

    if (ruleName === 'no-direct-process-env') {
      const agentBoundary = "'use agent'; const model = process.env.VIVID_MODEL"
      assert.equal(ruleDiagnostics(ruleName, lint(ruleName, agentBoundary, 'agent.ts')).length, 0)
    }
    if (ruleName === 'no-global-process-runtime') {
      const source = [
        "import * as NodeOS from 'node:os'",
        "import { arch as hostArch } from 'node:os'",
        'const architecture = process.arch',
        'const platform = globalThis.process.platform',
        'const osPlatform = NodeOS.platform()',
        'const osArchitecture = hostArch()',
      ].join('\n')
      assert.equal(ruleDiagnostics(ruleName, lint(ruleName, source)).length, 4)
    }

    if (ruleName === 'namespace-node-imports') {
      const source = [
        "import * as NodeAssert from 'node:assert/strict'",
        "import * as NodeFSP from 'node:fs/promises'",
        "import * as NodeOS from 'node:os'",
        "import * as NodeURL from 'node:url'",
      ].join('\n')
      assert.equal(ruleDiagnostics(ruleName, lint(ruleName, source)).length, 0)
      const processObject =
        "import NodeProcess from 'node:process'; NodeProcess.once('disconnect', onDisconnect); NodeProcess.off('disconnect', onDisconnect); const parent = NodeProcess.ppid"
      assert.equal(ruleDiagnostics(ruleName, lint(ruleName, processObject)).length, 0)
      const namespaceMethods =
        "import * as NodeProcess from 'node:process'; NodeProcess.once('disconnect', onDisconnect); const parent = NodeProcess['ppid']; function own(NodeProcess) { NodeProcess.emit('local') }"
      const processFindings = ruleDiagnostics(ruleName, lint(ruleName, namespaceMethods))
      assert.deepEqual(
        processFindings
          .map((finding) => {
            const matched = /import for (\w+);/u.exec(finding.message)
            assert.ok(matched, 'Expected a process-object member diagnostic')
            return matched[1]
          })
          .toSorted(),
        ['once', 'ppid'],
      )
      const additionalMethods =
        "import * as NodeProcess from 'node:process'; NodeProcess.prependListener('ready', callback); NodeProcess.listenerCount('ready'); const title = NodeProcess.title; const port = NodeProcess.debugPort"
      assert.deepEqual(
        ruleDiagnostics(ruleName, lint(ruleName, additionalMethods))
          .map((finding) => {
            const matched = /import for (\w+);/u.exec(finding.message)
            assert.ok(matched, 'Expected a process-object member diagnostic')
            return matched[1]
          })
          .toSorted(),
        ['debugPort', 'listenerCount', 'prependListener', 'title'],
      )
      const namespaceValues =
        "import * as NodeProcess from 'node:process'; const args = NodeProcess.execArgv; const env = NodeProcess.env"
      assert.equal(ruleDiagnostics(ruleName, lint(ruleName, namespaceValues)).length, 0)
      assert.equal(
        ruleDiagnostics(ruleName, lint(ruleName, "import runtime from 'node:process'")).length,
        1,
      )
    }
  })
}

const exhaustiveRule = 'typescript/switch-exhaustiveness-check'
const exhaustiveFixtures = path.join(scriptsDirectory, '__fixtures__', 'exhaustive')
const RootConfigSchema = Schema.Struct({
  rules: Schema.Struct({
    [exhaustiveRule]: Schema.Tuple([
      Schema.Literal('error'),
      Schema.Struct({ considerDefaultExhaustiveForUnions: Schema.Boolean }),
    ]),
    'vivid/prefer-state-match': Schema.Literal('error'),
  }),
})
const decodeRootConfig = Schema.decodeUnknownSync(Schema.fromJsonString(RootConfigSchema))
const ExhaustiveOutputSchema = Schema.Struct({
  diagnostics: Schema.Array(
    Schema.Struct({ code: Schema.String, message: Schema.String, filename: Schema.String }),
  ),
})
const decodeExhaustiveOutput = Schema.decodeUnknownSync(
  Schema.fromJsonString(ExhaustiveOutputSchema),
)

/**
 * Runs the native type-aware rule over the checked-in fixtures and returns the fixture file names
 * it reports. The rule needs real types, so this is the one test that starts tsgolint; the fixture
 * project is four files with no imports outside its directory. `--no-ignore` is required because
 * the root config ignores `scripts/__fixtures__`, which holds deliberately wrong code.
 */
function exhaustiveFindings(setting) {
  const directory = mkdtempSync(path.join(tmpdir(), 'vivid-exhaustive-'))
  try {
    const configPath = path.join(directory, 'oxlint.json')
    writeFileSync(
      configPath,
      JSON.stringify({
        plugins: ['typescript'],
        categories: { correctness: 'off' },
        rules: { [exhaustiveRule]: setting },
      }),
    )
    const run = () => {
      try {
        return execFileSync(
          oxlint,
          [
            '--type-aware',
            '--tsconfig',
            path.join(exhaustiveFixtures, 'tsconfig.json'),
            '--config',
            configPath,
            '--format',
            'json',
            '--no-ignore',
            exhaustiveFixtures,
          ],
          { cwd: repositoryRoot, encoding: 'utf8' },
        )
      } catch (cause) {
        const failure = decodeProcessFailure(cause)
        if (Result.isFailure(failure)) throw cause
        return failure.success.stdout
      }
    }
    return decodeExhaustiveOutput(run())
      .diagnostics.filter((entry) => entry.code === 'typescript(switch-exhaustiveness-check)')
      .map((entry) => `${path.basename(entry.filename)}: ${entry.message}`)
      .toSorted()
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

void test('the root config makes a switch name every union member, default or not', () => {
  // The setting under test is the one the repository ships, read from the root config, so this
  // fails if someone relaxes the option or turns either state rule down from `error`.
  const root = decodeRootConfig(readFileSync(path.join(repositoryRoot, '.oxlintrc.json'), 'utf8'))
  const setting = root.rules[exhaustiveRule]
  assert.equal(setting[1].considerDefaultExhaustiveForUnions, false)

  // `complete.ts` names all three members and is clean. `missing.ts` omits `done`. `defaulted.ts`
  // hides `done` behind a `default`, the shape a later-added member would also fall into.
  assert.deepEqual(exhaustiveFindings(setting), [
    'defaulted.ts: Switch is not exhaustive. Cases not matched: "done"',
    'missing.ts: Switch is not exhaustive. Cases not matched: "done"',
  ])

  // Control: with the rule's own default option a `default` excuses the missing member, so the
  // `defaulted.ts` finding above comes from the repository's option and not from the rule alone.
  assert.deepEqual(exhaustiveFindings(['error', { considerDefaultExhaustiveForUnions: true }]), [
    'missing.ts: Switch is not exhaustive. Cases not matched: "done"',
  ])
})
