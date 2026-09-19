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
const { mkdtempSync, rmSync, writeFileSync } = NodeFS
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
  ['no-promise-constructor', 'const value = new Promise(() => {})', 'const value = Effect.async(() => {})'],
  [
    'no-runpromise-nested',
    'const value = Effect.gen(function* () { Effect.runPromise(program); yield* program })',
    'const value = Effect.gen(function* () { return yield* program })',
  ],
  ['no-runpromise-in-library', 'Effect.runPromise(program)', 'const programValue = program'],
  ['no-platform-runtime-runmain-in-library', 'NodeRuntime.runMain(program)', 'const programValue = program'],
  ['no-effect-runtime-api', 'Runtime.runPromise(runtime)(program)', 'const programValue = program'],
  ['no-unnecessary-die', 'Effect.orDie(program)', 'Effect.catchTag(program, "Expected", recover)'],
  [
    'no-effect-catch-raw-error',
    "Effect.catchAll(program, () => Effect.fail(new Error('bad')))",
    'Effect.catchAll(program, () => Effect.fail(new DomainError({})))',
  ],
  ['no-effect-option-constructors', 'Effect.some(value)', 'Option.some(value)'],
  ['no-direct-schema-safeparse', 'UserSchema.safeParse(value)', 'Schema.decodeUnknownEither(UserSchema)(value)'],
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
  ['require-schema-decode-in-boundary', "JSON.parse('{}')", 'Schema.decodeUnknownSync(Payload)({})'],
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
  ['no-async-callback-api', 'items.map(async (item) => item)', 'Effect.forEach(items, (item) => Effect.succeed(item))'],
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
  ['no-config-provider-from-env-in-library', 'ConfigProvider.fromEnv()', 'const provider = AppConfigProvider'],
  ['better-auth-secure-options', 'const options = { migrate: true }', 'const options = { migrate: false }', 'auth.ts'],
  [
    'require-drizzle-config-paths',
    "defineConfig({ dialect: 'postgresql' })",
    "defineConfig({ dialect: 'postgresql', schema: './src/schema.ts', out: './drizzle' })",
    'drizzle.config.ts',
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
  ['react-no-useless-memo', 'useMemo(() => input, [input])', 'useMemo(() => derive(input), [input])', 'component.tsx'],
]

/** Lint one isolated snippet with exactly one Vivid rule enabled. */
function lint(ruleName, source, filename = 'module.ts') {
  const directory = mkdtempSync(path.join(tmpdir(), 'vivid-oxlint-'))
  try {
    const sourcePath = path.join(directory, filename)
    const configPath = path.join(directory, 'oxlint.json')
    writeFileSync(sourcePath, source)
    writeFileSync(
      configPath,
      JSON.stringify({
        jsPlugins: [{ name: 'vivid', specifier: plugin }],
        rules: { [`vivid/${ruleName}`]: 'error' },
      }),
    )
    try {
      const output = execFileSync(oxlint, ['--config', configPath, '--format', 'json', sourcePath], {
        cwd: repositoryRoot,
        encoding: 'utf8',
      })
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

    if (ruleName === 'effect-require-effect-fn') {
      const callback = 'const options = { catch: () => Effect.fail(new DomainError({})) }'
      assert.equal(ruleDiagnostics(ruleName, lint(ruleName, callback)).length, 0)
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
    }
  })
}
