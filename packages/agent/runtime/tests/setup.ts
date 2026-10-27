import * as NodeProcess from 'node:process'

/**
 * Vitest runs setupFiles in each worker before it imports a test module, and a worker inherits
 * the shell's environment. Nothing in this package needs a product server, a real database or a
 * credential to be tested: the route suite supplies its settings, its models, its server and a
 * disposable copy of the migrated database through Layers (`tests/process.ts`,
 * `tests/database.ts`, which reads only `VIVID_TEST_DATABASE_URL`). So the settings a developer's
 * shell may carry are removed here, once, before any `Config` read can copy them: a suite that
 * forgot to supply one fails on the missing name instead of calling a real server or writing to
 * a real database.
 */
for (const name of [
  'DATABASE_URL',
  'VIVID_SERVER_URL',
  'VIVID_RUNTIME_TOKEN',
  'VIVID_MEMORY_DIR',
  'VIVID_MODEL',
  'OPENCODE_API_KEY',
  'EXPLABS_API_KEY',
])
  delete NodeProcess.env[name]
