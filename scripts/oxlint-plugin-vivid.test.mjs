import * as NodeAssert from 'node:assert/strict'
import * as NodeChildProcess from 'node:child_process'
import * as NodeFS from 'node:fs'
import * as NodeModule from 'node:module'
import * as NodeOS from 'node:os'
import * as NodePath from 'node:path'
import * as NodeTest from 'node:test'
import * as NodeURL from 'node:url'
import * as Result from 'effect/Result'
import * as Schema from 'effect/Schema'
import { scanDefinition, scanDockerfile } from './gate/commands.mjs'
import { scanPredeploy, scanResources } from './gate/readback.mjs'
import { contractImports, unregisteredWireSchemas, wireFinding } from './gate/wire.mjs'

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
      const toolBoundary = 'defineTool({ async run() { return Effect.runPromise(program) } })'
      assert.equal(ruleDiagnostics(ruleName, lint(ruleName, toolBoundary)).length, 0)
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
        // Computer Live's named renewal callback and a completion called after a wait.
        'const renewed = (answer) => setSaid(answer); function renew() { send().then(renewed) }',
        'async function save() { const end = () => setSaid(null); await send(); end() }',
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
      // The syntax-only rule still reports a branch that waited and returned.
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
 * it reports. The rule needs real types, so this is the one test that starts tsrslint; the fixture
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
          {
            cwd: repositoryRoot,
            encoding: 'utf8',
            env: {
              ...process.env,
              OXLINT_TSGOLINT_PATH: NodeModule.createRequire(import.meta.url)(
                '@maschwenk/tsrslint',
              ).binaryPath(),
            },
          },
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

/**
 * The failure rules, each against the code that hid the send outage of 8-10 November 2026, cut
 * from the commit it ran at (bab8c618d), and against the shape that fixes it.
 */
const incidentCases = [
  {
    rule: 'no-silent-failure',
    mistake: 'client recorders and cell telemetry account for recovered Effect failures',
    invalid: `program.pipe(Effect.catch((error) => Effect.void))
program.pipe(Effect.catch((error) => Effect.void))
program.pipe(Effect.catch((error) => Effect.void))
program.pipe(Effect.catch((error) => Effect.void))`,
    valid: `program.pipe(Effect.tapError((error) => recordFailure(recording, SEND, error)), Effect.ignore)
program.pipe(Effect.tapError((error) => recording.record(clientFailure(error))), Effect.ignore)
program.pipe(Effect.tapError((error) => record(Incident.cases.ClientFailed.make({ cause: hop(error) }))), Effect.ignore)
program.pipe(Effect.tapError((error) => reports.record(CellFailure.cases.CellFailed.make({ personId, cause: hop(error) }), parent)), Effect.ignore)`,
    findings: 4,
    fix: /recordFailure.*CellReports\.record/u,
  },
  {
    rule: 'no-ad-hoc-failure-log',
    mistake: 'runtime/app.ts unavailable logs the tag as an ad hoc payload',
    invalid: `const unavailable = (tag) =>
  Effect.logError('Runtime request failed', tag).pipe(Effect.andThen(refuse('Unavailable', 503)))`,
    valid: `const unavailable = (tag) =>
  reports.record(CellFailure.cases.CellFailed.make({ personId, cause: [cellHop(ANSWER, tag)] }), parent).pipe(Effect.andThen(refuse('Unavailable', 503)))`,
    findings: 1,
    fix: /CellReports\.record.*telemetry\.ts/u,
  },
  {
    rule: 'no-silent-failure',
    mistake: 'computers/store.ts MachineNotRunning passes its local handle by name',
    invalid: `const handle = (failure) => Effect.succeed(answer(failure))
program.pipe(Effect.catchTags({ MachineNotRunning: handle }))`,
    valid: `const handle = (failure) => incidents.record(computerFailed(failure)).pipe(Effect.as(answer(failure)))
program.pipe(Effect.catchTags({ MachineNotRunning: handle }))`,
    findings: 1,
    fix: /This `Effect\.catchTags` answers success/u,
  },
  {
    rule: 'keep-incident-cause',
    mistake: 'computers/store.ts named handler replaces the failure in a declaration',
    invalid: `function handle(failure) { return Effect.fail(ComputerStartFailed.make({ person })) }
program.pipe(Effect.catchTags({ MachineNotRunning: handle }))`,
    valid: `function handle(failure) { return Effect.fail(ComputerStartFailed.make({ person, cause: hop(failure) })) }
program.pipe(Effect.catchTags({ MachineNotRunning: handle }))`,
    findings: 1,
    fix: /ComputerStartFailed.*without its cause/u,
  },
  {
    rule: 'keep-incident-cause',
    mistake: 'runtime/client.ts attempt spread only preserves a cause it actually owns',
    invalid: `const attempt = { threadId, runId: deliveryRunId(threadId, input.idempotencyKey) }
const refusal = yield* HttpClientResponse.schemaBodyJson(RuntimeRefusal)(response).pipe(
  Effect.mapError(() => AdmissionUncertain.make({ ...attempt, reason: 'Status' })),
)`,
    valid: `const refusal = yield* HttpClientResponse.schemaBodyJson(RuntimeRefusal)(response).pipe(
  Effect.mapError((error) => {
    const attempt = { threadId, runId: deliveryRunId(threadId, input.idempotencyKey), cause: hop(error) }
    return AdmissionUncertain.make({ ...attempt, reason: 'Status' })
  }),
)`,
    findings: 1,
    fix: /AdmissionUncertain.*without its cause/u,
  },
  {
    rule: 'keep-incident-cause',
    mistake: 'runtime/client.ts Runtime.admit replaces a decoded refusal outside a combinator',
    invalid: `const admit = Effect.fn('Runtime.admit')(function* () {
const refusal = yield* HttpClientResponse.schemaBodyJson(RuntimeRefusal)(response).pipe(
  Effect.mapError((error) => AdmissionUncertain.make({ ...attempt, reason: 'Status', cause: hop(error) })),
)
if (refusal.error === 'Unavailable')
  return yield* AdmissionUncertain.make({ ...attempt, reason: 'Transport' })
return yield* AdmissionRefused.make({ ...attempt, reason: 'Rejected' })
})`,
    valid: `const admit = Effect.fn('Runtime.admit')(function* () {
const refusal = yield* HttpClientResponse.schemaBodyJson(RuntimeRefusal)(response).pipe(
  Effect.mapError((error) => AdmissionUncertain.make({ ...attempt, reason: 'Status', cause: hop(error) })),
)
if (refusal.error === 'Unavailable')
  return yield* AdmissionUncertain.make({ ...attempt, reason: 'Transport', cause: hop(refusal) })
return yield* AdmissionRefused.make({ ...attempt, reason: 'Rejected', cause: hop(refusal) })
})`,
    findings: 2,
    fix: /Admission(?:Uncertain|Refused).*without its cause/u,
  },
  {
    rule: 'keep-incident-cause',
    mistake: 'threads/delivery.ts Conversation.admitRuntime renames a refusal to unavailable',
    invalid: `const admitRuntime = Effect.fn('Conversation.admitRuntime')((runtime, input) =>
  runtime.admit(input).pipe(
    Effect.catchTag(['AdmissionRefused', 'AdmissionUncertain'], () =>
      Effect.fail(RuntimeUnavailable.make({ message: 'Vivid could not be reached' })),
    ),
  ),
)`,
    valid: `const admitRuntime = Effect.fn('Conversation.admitRuntime')((runtime, input) =>
  runtime.admit(input).pipe(
    Effect.catchTag(['AdmissionRefused', 'AdmissionUncertain'], (error) =>
      Effect.fail(AdmissionFailed.make({ cause: [{ service: 'server', operation: 'Conversation.admitRuntime', tag: error._tag }, ...error.cause] })),
    ),
  ),
)`,
    findings: 1,
    fix: /`RuntimeUnavailable` replaces the caught failure without its cause\. Give `RuntimeUnavailable` a `cause: IncidentCause` field/u,
  },
  {
    rule: 'keep-incident-cause',
    mistake: 'runtime/client.ts Runtime.admit reduces an unreadable refusal to a reason word',
    invalid: `const refusal = yield* HttpClientResponse.schemaBodyJson(RuntimeRefusal)(response).pipe(
  Effect.mapError(() => AdmissionUncertain.make({ ...attempt, reason: 'Status' })),
)`,
    valid: `const refusal = yield* HttpClientResponse.schemaBodyJson(RuntimeRefusal)(response).pipe(
  Effect.mapError((error) => AdmissionUncertain.make({ ...attempt, reason: 'Status', cause: hop('Runtime.admit', error) })),
)`,
    findings: 1,
    fix: /`AdmissionUncertain` replaces the caught failure without its cause/u,
  },
  {
    rule: 'keep-incident-cause',
    mistake: 'packages/agent/runtime/src/app.ts answered: every refusal drops what failed',
    invalid: `handler.pipe(
  Effect.catchTags({
    SchemaError: () => refuse('InvalidRequest', 400),
    HttpServerError: () => refuse('InvalidRequest', 400),
    PiRejected: () => unavailable('PiRejected'),
  }),
)`,
    valid: `handler.pipe(
  Effect.catchTags({
    SchemaError: (error) => refuse('InvalidRequest', 400, cellHop('Runtime.answer', error)),
    HttpServerError: (error) => refuse('InvalidRequest', 400, cellHop('Runtime.answer', error)),
    PiRejected: (error) => unavailable(cellHop('Runtime.answer', error)),
  }),
)`,
    findings: 3,
    fix: /never reads the failure it caught.*`cause: IncidentCause`/u,
  },
  {
    rule: 'keep-incident-cause',
    mistake: 'recovery to a value and a re-failed original are not replacements',
    invalid: `program.pipe(Effect.catchTag('Conflict', () => new Busy({})))`,
    valid: `program.pipe(
  Effect.catchTag('NoSuchElementError', () => Effect.succeed(Option.none())),
  Effect.catchTag('Conflict', (error) => Effect.fail(error)),
)`,
    findings: 1,
    fix: /`Busy` replaces the caught failure/u,
  },
  {
    rule: 'no-refusal-as-unavailable',
    mistake:
      'threads/delivery.ts Conversation.admitRuntime: the cell refused, the Person read an outage',
    invalid: `runtime.admit(input).pipe(
  Effect.catchTag(['AdmissionRefused', 'AdmissionUncertain'], () =>
    Effect.fail(RuntimeUnavailable.make({ message: 'Vivid could not be reached' })),
  ),
)`,
    valid: `runtime.admit(input).pipe(
  Effect.catchTag('AdmissionUncertain', (error) =>
    Effect.fail(RuntimeUnavailable.make({ message: 'Vivid could not be reached', cause: hop(error) })),
  ),
)`,
    findings: 1,
    fix: /`AdmissionRefused` is a refusal and `RuntimeUnavailable` says Vivid could not be reached\. A refusal is never renamed to unavailable/u,
  },
  {
    rule: 'no-silent-failure',
    mistake: 'runtime/settlement.ts: a Run whose ending nobody knows becomes Unknown, unrecorded',
    invalid: `const observeRun = Effect.fn('Durable.observe')(function* (read) {
  return yield* read.pipe(
    Effect.retry({ schedule: Schedule.spaced('1 second'), while: transient }),
    Effect.orElseSucceed(() => Settlement.cases.Unknown.make({})),
  )
})`,
    valid: `const observeRun = Effect.fn('Durable.observe')(function* (read) {
  return yield* read.pipe(
    Effect.retry({ schedule: Schedule.spaced('1 second'), while: transient }),
    Effect.tapError((error) => incidents.record(Incident.cases.RunLost.make({ ...run, cause: hop(error) }))),
    Effect.orElseSucceed(() => Settlement.cases.Unknown.make({})),
  )
})`,
    findings: 1,
    fix: /`Effect\.orElseSucceed` turns a failure into a value.*`Incidents\.record\(\.\.\.\)`.*`\/\/ Impact: Recovered, <why>`/u,
  },
  {
    rule: 'no-silent-failure',
    mistake: 'push/delivery.ts Push.attempt: a rejected push becomes a Failed receipt, unrecorded',
    invalid: `services.adapter.send(destination, payload).pipe(
  Effect.catchTags({
    PushRejected: () => Effect.succeed(PushReceipt.cases.Failed.make({ reason: 'Rejected' })),
  }),
)`,
    valid: `services.adapter.send(destination, payload).pipe(
  Effect.catchTags({
    PushRejected: (error) =>
      incidents.record(undelivered(error)).pipe(Effect.as(PushReceipt.cases.Failed.make({ reason: 'Rejected' }))),
  }),
)`,
    findings: 1,
    fix: /This `Effect\.catchTags` answers success/u,
  },
  {
    rule: 'no-silent-failure',
    mistake: 'computers/store.ts: a Computer that did not start is a Result and a warning',
    invalid: `const started = yield* machine.ensure(before.machine).pipe(
  Effect.timeoutOrElse({ duration: START_DEADLINE, orElse: () => Effect.fail(new ComputerWakeTimedOut({ person })) }),
  Effect.result,
)`,
    valid: `const started = yield* machine.ensure(before.machine).pipe(
  Effect.timeoutOrElse({ duration: START_DEADLINE, orElse: () => Effect.fail(new ComputerWakeTimedOut({ person })) }),
  Effect.tapError((error) => incidents.record(computerFailed(person, 'Start', error))),
  Effect.result,
)`,
    findings: 1,
    fix: /`Effect\.result` turns a failure into a value/u,
  },
  {
    rule: 'no-silent-failure',
    mistake: 'a declared Impact needs its reason; a bare label does not count',
    invalid: `// Impact: Routine
const shown = program.pipe(Effect.catchTag('NoDeviceConnected', () => Effect.succeedSome(NotConnected.make({}))))`,
    valid: `// Impact: Routine, no device connected is the Person's own state, shown as NotConnected.
const shown = program.pipe(Effect.catchTag('NoDeviceConnected', () => Effect.succeedSome(NotConnected.make({}))))`,
    findings: 1,
    fix: /This `Effect\.catchTag` answers success/u,
  },
  {
    rule: 'no-ad-hoc-failure-log',
    mistake: 'computers/store.ts: the Computer start failure, exported as [omitted]',
    invalid: `yield* Result.match(started, {
  onFailure: (failure) => Effect.logWarning('Computer start failed', { failure: failure._tag, tookMillis }),
  onSuccess: () => Effect.logInfo('Computer started', { tookMillis }),
})`,
    valid: `yield* Result.match(started, {
  onFailure: () => Effect.logWarning(Message.computerStartFailed),
  onSuccess: () => Effect.logInfo('Computer started', { tookMillis }),
})`,
    findings: 1,
    fix: /`Effect\.logWarning` with a message that is not a `Message` constant reaches the backend as `\[omitted\]`/u,
  },
  {
    rule: 'no-ad-hoc-failure-log',
    mistake: 'watches/lifecycle.ts: the renewal failure logged with the error as its payload',
    invalid: `watching.renew().pipe(Effect.tapError(Effect.logError))`,
    valid: `watching.renew().pipe(Effect.tapError(() => Effect.logError(Message.watchRenewalFailed)))`,
    findings: 1,
    fix: /given the failure itself as its payload/u,
  },
  {
    rule: 'severity-from-impact',
    mistake: 'observability/failure.ts line: every typed failure a warning, every defect an error',
    invalid: `const line = (failure) =>
  FailureOutcome.$match(failure, {
    Expected: () => Effect.logWarning(Message.failure),
    Defect: () => Effect.logError(Message.defect),
  })`,
    valid: `const line = (failure) =>
  Effect.logWithLevel(impactSignal[impactOfFailure(failure)].level)(Message.failure)
const kindOf = FailureOutcome.$match({ Expected: () => 'expected', Defect: () => 'defect' })`,
    findings: 1,
    fix: /`impactSignal\[impactOfFailure\(failure\)\]`/u,
  },
  {
    rule: 'severity-from-impact',
    mistake: 'the same choice written as a conditional',
    invalid: `const log = kind === 'expected' ? Effect.logWarning(Message.failure) : Effect.logError(Message.defect)`,
    valid: `const log = Effect.logWithLevel(impactSignal[impact].level)(Message.failure)`,
    findings: 1,
    fix: /chosen here by whether the failure was declared/u,
  },
]

for (const { rule: ruleName, mistake, invalid, valid, findings, fix } of incidentCases) {
  void test(`${ruleName} fails on ${mistake} and names the fix`, () => {
    const reported = ruleDiagnostics(ruleName, lint(ruleName, invalid))
    assert.equal(reported.length, findings)
    reported.forEach((finding) => assert.match(finding.message, fix))
    assert.deepEqual(ruleDiagnostics(ruleName, lint(ruleName, valid)), [])
  })
}

void test('deploy commands: the pre-deploy chain whose publish half never ran fails, one program passes', () => {
  const chain = `const server = Railway.Service('Server', {
  startCommand: 'env -u SENTRY_AUTH_TOKEN pnpm --filter @vivid/server start',
  preDeploy: {
    command:
      'node scripts/migrate.mjs server && node scripts/sentry-upload.mjs vivid-mobile apps/mobile/updates && node apps/cells/scripts/build.mjs deploy',
  },
})`
  const [finding, ...rest] = scanDefinition('infra/railway.ts', chain)
  assert.deepEqual(rest, [])
  assert.match(
    finding,
    /^infra\/railway\.ts:5: `command` is a shell chain \(`&&`\)\. Make the step one program/u,
  )
  assert.deepEqual(
    scanDefinition(
      'infra/railway.ts',
      `const server = { preDeploy: { command: 'node scripts/predeploy.mjs' }, startCommand: 'pnpm --filter @vivid/cells exec node ../../infra/cli.mjs dev' }`,
    ),
    [],
  )
  for (const shell of [
    "'exec node main.mjs'",
    '\'sh -c "node a.mjs"\'',
    "'node a.mjs; node b.mjs'",
    '`node a.mjs | tee ${log}`',
  ])
    assert.equal(
      scanDefinition('alchemy.run.ts', `Command.Exec('step', { command: ${shell} })`).length,
      1,
      shell,
    )
})

void test('deploy commands: a Dockerfile CMD runs one program, never a shell', () => {
  assert.match(
    scanDockerfile(
      'apps/server/Dockerfile',
      'FROM node\nCMD pnpm --filter @vivid/server start\n',
    ).join(''),
    /^apps\/server\/Dockerfile:2: `CMD` runs a shell \(`shell form`\)/u,
  )
  assert.equal(
    scanDockerfile('Dockerfile', 'ENTRYPOINT ["sh", "-c", "node a && node b"]').length,
    1,
  )
  assert.deepEqual(
    scanDockerfile(
      'apps/server/Dockerfile',
      [
        'RUN corepack enable && corepack install',
        'HEALTHCHECK --interval=30s \\',
        '  CMD node -e "fetch(1).then(() => 0)"',
        'CMD ["env", "-u", "SENTRY_AUTH_TOKEN", "pnpm", "--filter", "@vivid/server", "start"]',
      ].join('\n'),
    ),
    [],
  )
})

void test('wire: only value imports from @vivid/contracts count, with their subpath', () => {
  assert.deepEqual(
    contractImports(
      'apps/server/src/runtime/client.ts',
      [
        "import { RuntimeAdmissionBody, type RuntimeDelivery } from '@vivid/contracts'",
        "import type { ThreadId } from '@vivid/contracts'",
        "import { RuntimeRefusal } from '@vivid/contracts/runtime'",
        "import { Effect } from 'effect'",
      ].join('\n'),
    ).map(({ subpath, name }) => [subpath, name]),
    [
      [undefined, 'RuntimeAdmissionBody'],
      ['runtime', 'RuntimeRefusal'],
    ],
  )
})

void test('wire: the admission body that drifted outside the fingerprint fails, registering it passes', () => {
  // c2481042c replaced the body's `type`/`body`/`attributes` with `delivery`; the cell's Worker
  // kept the old body and refused every send from 8 November 2026. Both sides import the body.
  const ThreadId = Schema.String.pipe(Schema.brand('ThreadId'))
  const RuntimeDelivery = Schema.TaggedStruct('Message', { text: Schema.String, thread: ThreadId })
  const RuntimeAdmissionBody = Schema.Struct({
    delivery: RuntimeDelivery,
    run: Schema.optional(ThreadId),
  })
  const share = (name, value) => ({
    name,
    value,
    server: 'apps/server/src/runtime/client.ts',
    cell: 'packages/agent/runtime/src/app.ts',
  })
  const shared = [
    share('RuntimeAdmissionBody', RuntimeAdmissionBody),
    share('RuntimeDelivery', RuntimeDelivery),
    share('ThreadId', ThreadId),
    // A helper both sides call is not wire; it is told apart by being no Schema.
    share('deliveryText', (delivery) => delivery.text),
  ]
  const unregistered = unregisteredWireSchemas(shared, {})
  assert.deepEqual(
    unregistered.map(({ name }) => name),
    ['RuntimeAdmissionBody', 'RuntimeDelivery', 'ThreadId'],
  )
  assert.match(
    wireFinding(unregistered[0]),
    /^RuntimeAdmissionBody: crosses the server <-> cell wire \(apps\/server\/src\/runtime\/client\.ts, packages\/agent\/runtime\/src\/app\.ts\) and is not in wireSchemas .* Add it to wireSchemas, or register a schema that contains it\.$/u,
  )
  // The delivery and the id are inside the registered body, so its hash already covers them.
  assert.deepEqual(unregisteredWireSchemas(shared, { RuntimeAdmissionBody }), [])
})

void test('readback: the old pre-deploy chain and unobservable resources fail', () => {
  const old =
    "const railwayStack = () => Command.Exec('publish', { command: 'node scripts/migrate.mjs server && node apps/cells/scripts/build.mjs deploy' })"
  assert.equal(scanPredeploy('infra/predeploy.mjs', old).length, 1)
  assert.equal(scanResources('alchemy.run.ts', old).length, 1)
  assert.equal(scanResources('alchemy.run.ts', 'const railwayStack = () => Action(work)').length, 1)
  assert.deepEqual(scanResources('alchemy.run.ts', old.replace('railwayStack', 'localStack')), [])
  assert.equal(
    scanResources('infra/publish.ts', 'Provider.succeed(Publish, { reconcile: publish })').length,
    1,
  )
  assert.deepEqual(
    scanResources(
      'infra/publish.ts',
      'Provider.succeed(Publish, { reconcile: publish, read: pointer })',
    ),
    [],
  )
  assert.equal(
    scanPredeploy(
      'infra/predeploy.mjs',
      "export const predeploySteps = [{ name: 'publish', step: publish }]",
    ).length,
    1,
  )
  assert.deepEqual(
    scanPredeploy(
      'infra/predeploy.mjs',
      "export const predeploySteps = [{ name: 'publish', step: publish, readBack: 'fleet pointer' }]",
    ),
    [],
  )
})

/** The policy CLI must reject infra's historical summary field and either missing loader field. */
void NodeTest.test('skills require name and description in frontmatter', (context) => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), 'vivid-instructions-'))
  context.after(() => NodeFS.rmSync(root, { recursive: true, force: true }))
  const file = '.agents/skills/infra/SKILL.md'
  const historical = NodeChildProcess.execFileSync('git', ['show', `bab8c618d:${file}`], {
    encoding: 'utf8',
  })
  const fixed = historical.replace('\nsummary:', '\ndescription:')
  NodeFS.mkdirSync(NodePath.join(root, '.agents/skills/infra'), { recursive: true })
  NodeFS.writeFileSync(NodePath.join(root, file), historical)
  NodeChildProcess.execFileSync('git', ['init', '-q', root])
  NodeChildProcess.execFileSync('git', ['add', '--', file], { cwd: root })
  for (const [body, field] of [
    [historical, 'description'],
    [fixed.replace('name: infra\n', ''), 'name'],
  ]) {
    NodeFS.writeFileSync(NodePath.join(root, file), body)
    const result = NodeChildProcess.spawnSync(
      process.execPath,
      ['scripts/instructions.mjs', root],
      {
        encoding: 'utf8',
      },
    )
    NodeAssert.equal(result.status, 1)
    NodeAssert.ok(result.stderr.includes(`${file}: add ${field}: <value>`), result.stderr)
  }
  NodeFS.writeFileSync(NodePath.join(root, file), fixed)
  const result = NodeChildProcess.spawnSync(process.execPath, ['scripts/instructions.mjs', root], {
    encoding: 'utf8',
  })
  NodeAssert.equal(result.status, 0, result.stderr)
  NodeAssert.equal(result.stdout, 'instruction files passed\n')
})
