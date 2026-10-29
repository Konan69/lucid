import * as NodeProcess from 'node:process'

/** Strip inherited product credentials before importing a case. Fixtures provide explicit
 * authority, a scripted provider, and first-party SQLite files of their own. */
for (const name of [
  'DATABASE_URL',
  'VIVID_SERVER_URL',
  'VIVID_RUNTIME_TOKEN',
  'VIVID_MEMORY_DIR',
  'VIVID_MODEL',
  'OPENCODE_API_KEY',
])
  delete NodeProcess.env[name]
