#!/usr/bin/env node
import * as NodeAssert from 'node:assert/strict'
import * as NodeFS from 'node:fs'
import * as Result from 'effect/Result'
import * as Schema from 'effect/Schema'
import { stages } from './gate/stages.mjs'

const assert = NodeAssert
const Task = Schema.Struct({
  inputs: Schema.optionalKey(Schema.Array(Schema.String)),
  outputs: Schema.optionalKey(Schema.Array(Schema.String)),
  env: Schema.optionalKey(Schema.Array(Schema.String)),
  passThroughEnv: Schema.optionalKey(Schema.Array(Schema.String)),
  dependsOn: Schema.optionalKey(Schema.Array(Schema.String)),
})
const Turbo = Schema.Struct({ tasks: Schema.Record(Schema.String, Task) })
const Manifest = Schema.Struct({ scripts: Schema.Record(Schema.String, Schema.String) })

/** Invalid task declarations must stop the gate before Turbo can replay an incomplete hash. */
function read(schema, path) {
  return Result.getOrThrow(
    Schema.decodeUnknownResult(Schema.fromJsonString(schema))(
      NodeFS.readFileSync(new URL(path, import.meta.url), 'utf8'),
    ),
  )
}

/** A named stage must resolve to a declared task and every root task needs an executable script. */
function checkStages(tasks, scripts) {
  for (const stage of stages.filter((entry) => entry.tasks !== undefined)) {
    for (const task of stage.tasks) {
      assert.ok(
        tasks[task] !== undefined ||
          tasks[task.slice(task.indexOf('#') + 1)] !== undefined ||
          tasks[`//#${task}`] !== undefined,
        `${stage.name}: declare ${task} in turbo.json`,
      )
      if (tasks[`//#${task}`] !== undefined)
        assert.notEqual(scripts[task], undefined, `package.json: add the ${task} script`)
    }
  }
}

/** Turbo replaces generic tasks with package overrides, so omitted hash fields silently lose checks. */
function checkOverrides(tasks) {
  for (const [name, task] of Object.entries(tasks)) {
    if (!/^@vivid\/[\w-]+#(lint|typecheck|test|build)$/u.test(name)) continue
    const generic = tasks[name.slice(name.indexOf('#') + 1)]
    assert.notEqual(generic, undefined, `turbo.json: declare the generic task for ${name}`)
    for (const field of ['inputs', 'outputs', 'env', 'passThroughEnv'])
      if (generic[field] !== undefined)
        assert.deepEqual(task[field], generic[field], `turbo.json: ${name} must repeat ${field}`)
    for (const dependency of generic.dependsOn ?? [])
      assert.ok(
        task.dependsOn !== undefined && task.dependsOn.includes(dependency),
        `turbo.json: ${name} must keep dependency ${dependency}`,
      )
  }
}

/** Each run's disposable address passes through; the cache hashes opt-ins and credentials instead. */
function checkTestEnvironment(tasks) {
  for (const [name, task] of Object.entries(tasks).filter(([key]) => /(^|#)test$/u.test(key))) {
    assert.deepEqual(
      task.env,
      [
        'VIVID_TEST_*',
        'VIVID_LIVE_*',
        'OPENROUTER_API_KEY',
        'OPENCODE_API_KEY',
        '!VIVID_TEST_DATABASE_URL',
      ],
      `turbo.json: ${name} must hash every test setting except the disposable database address`,
    )
    assert.deepEqual(
      task.passThroughEnv,
      ['VIVID_TEST_DATABASE_URL', 'VIVID_GATE_CACHE'],
      `turbo.json: ${name} must pass the gate's database and cache authority`,
    )
  }
}

/** Shipping overrides keep the production hash while excluding source-map upload authority. */
function checkBuild(tasks) {
  const web = read(Turbo, '../apps/web/turbo.json').tasks.build
  for (const task of [web]) {
    for (const field of ['inputs', 'outputs', 'passThroughEnv'])
      assert.deepEqual(
        task[field],
        tasks.build[field],
        `build override must repeat ${field} in turbo.json`,
      )
    assert.notEqual(tasks.build.env, undefined, 'turbo.json: declare build.env')
    assert.deepEqual(
      task.env,
      [...tasks.build.env, '!SENTRY_AUTH_TOKEN'],
      'build override must exclude SENTRY_AUTH_TOKEN in turbo.json',
    )
  }
}

const { tasks } = read(Turbo, '../turbo.json')
const { scripts } = read(Manifest, '../package.json')
checkStages(tasks, scripts)
checkOverrides(tasks)
checkTestEnvironment(tasks)
checkBuild(tasks)
// The runtime library and its native cell entry both participate in the generic checks.
const runtime = read(Manifest, '../packages/agent/runtime/package.json')
for (const task of ['types', 'typecheck', 'lint', 'test'])
  assert.notEqual(runtime.scripts[task], undefined, `runtime: missing gate task ${task}`)
const cells = read(Manifest, '../apps/cells/package.json')
for (const task of ['build', 'typecheck', 'lint'])
  assert.notEqual(cells.scripts[task], undefined, `cells: missing gate task ${task}`)
console.log('Task policy passed')
