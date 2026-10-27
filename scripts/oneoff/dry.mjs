import * as fs from 'node:fs/promises'
import { Readable } from 'node:stream'
import * as zlib from 'node:zlib'
import * as child from 'node:child_process'
import * as path from 'node:path'
import { createRequire } from 'node:module'
import { pipeline } from 'node:stream/promises'
import assert from 'node:assert/strict'
import { Effect } from 'effect'
import { readNotes } from './notes.ts'
import { proveMemory } from './memory.mjs'
import { proveSettlements } from './settlements.mjs'

const [product, run] = process.argv.slice(2)
const state = JSON.parse(await fs.readFile(`${product}/.cache/verify/${run}/state.json`, 'utf8'))
const directory = `${state.evidence}/migration`
await fs.mkdir(directory, { recursive: true, mode: 0o700 })
const require = createRequire(`${product}/apps/server/package.json`)
const { Pool } = require('pg')
const databaseName = `migration_${crypto.randomUUID().replaceAll('-', '')}`
const port = child.execFileSync('docker', ['port', 'vivid-gate-pg', '5432/tcp'], { encoding: 'utf8' }).trim().split(':').at(-1)
const admin = new Pool({ connectionString: `postgres://vivid:vivid@127.0.0.1:${port}/postgres` })
const sourceUrl = `postgres://vivid:vivid@127.0.0.1:${port}/${databaseName}`
const targetUrl = `postgres://verify:verify@127.0.0.1:${state.ports.database}/verify`
const target = new Pool({ connectionString: targetUrl })
let source
const summary = { head: state.head, dirty: state.dirty, host: state.devbox, model: state.model, run }
const json = (name, value) => fs.writeFile(`${directory}/${name}.json`, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })

/** Wait on subprocess completion; retain output without recording command arguments or credentials. */
const execute = async (name, program, args, options = {}) => {
  const output = await fs.open(`${directory}/${name}.log`, 'w', 0o600)
  try {
    await new Promise((resolve, reject) => {
      const process = child.spawn(program, args, { ...options, stdio: ['ignore', output.fd, output.fd] })
      process.once('error', reject)
      process.once('close', (code) => code === 0 ? resolve() : reject(new Error(`${name} exited ${code}`)))
    })
  } finally { await output.close() }
}
try {
  await admin.query(`CREATE DATABASE "${databaseName}"`)
  const enumSql = (await fs.readFile(`${product}/apps/server/product-drizzle/20261004003653_fat_moon_knight/migration.sql`, 'utf8')).split('--> statement-breakpoint')[0]
  await execute('source-type', 'docker', ['exec', 'vivid-gate-pg', 'psql', '-U', 'vivid', '-d', databaseName, '-v', 'ON_ERROR_STOP=1', '-c', enumSql])
  const restore = child.spawn('docker', ['exec', '-i', 'vivid-gate-pg', 'psql', '-U', 'vivid', '-d', databaseName, '-v', 'ON_ERROR_STOP=1'], { stdio: ['pipe', 'ignore', 'pipe'] })
  const restored = new Promise((resolve, reject) => {
    let errors = ''
    restore.stderr.on('data', (bytes) => { errors += bytes.toString() })
    restore.once('error', reject)
    restore.once('close', (code) => code === 0 ? resolve() : reject(new Error(`Restore exited ${code}: ${errors}`)))
  })
  const dump = zlib.gunzipSync(await fs.readFile(path.join(process.env.HOME, 'migrate-copy/production.sql.gz'))).toString('utf8')
  let omittedForeignKeys = 0
  const restoredSql = dump.replace(/^ALTER TABLE ONLY public\.[^;]+;$/gm, (statement) => {
    if (!statement.includes('FOREIGN KEY')) return statement
    omittedForeignKeys += 1
    return ''
  })
  summary.restore = { omittedForeignKeys, reason: 'The table-filtered dump excludes referenced product tables; source rows remain unchanged' }
  await Promise.all([pipeline(Readable.from([restoredSql]), restore.stdin), restored])
  source = new Pool({ connectionString: sourceUrl, options: '-c default_transaction_read_only=on' })
  const oldRuns = (await source.query('SELECT id, thread_id, receipt FROM vivid_runs WHERE receipt IS NOT NULL ORDER BY id')).rows
  summary.noStreamThreads = (await source.query("SELECT t.id FROM vivid_conversations t WHERE NOT EXISTS (SELECT 1 FROM flue_conversation_streams s WHERE s.path='agents/vivid/' || t.id) ORDER BY t.id")).rows.map((row) => row.id)
  summary.attachmentSources = (await source.query("SELECT a.attachment_id, a.stream_path, t.id AS retained_thread FROM flue_attachments a LEFT JOIN vivid_conversations t ON a.stream_path='agents/vivid/' || t.id ORDER BY a.stream_path")).rows
  summary.attachmentRecords = []
  for (const streamPath of [...new Set(summary.attachmentSources.map((attachment) => attachment.stream_path))]) {
    const batches = (await source.query('SELECT data FROM flue_conversation_stream_batches WHERE path=$1 ORDER BY seq', [streamPath])).rows
    for (const { data } of batches) for (const record of JSON.parse(data)) {
      if (record.type !== 'user_message' && record.type !== 'tool_outcome') continue
      for (const content of record.content) if (content.type === 'attachment') summary.attachmentRecords.push({ recordId: record.id, type: record.type, attachmentId: content.attachment.id })
    }
  }
  summary.receiptedRuns = oldRuns.length
  summary.streams = Number((await source.query('SELECT count(*) FROM flue_conversation_streams')).rows[0].count)
  assert.equal(Number((await source.query("SELECT count(*) FROM vivid_runs WHERE state='working'")).rows[0].count), 0)
  const tables = ['user', 'vivid_conversations', 'vivid_runs']
  summary.productRows = {}
  await target.query('BEGIN')
  for (const table of tables) {
    const rows = (await source.query(`SELECT * FROM "${table}"`)).rows
    if (table === 'vivid_conversations') assert.ok(rows.every((row) => row.company_id === null && row.project_id === null), 'The copy excludes Company and Project dependencies')
    for (const row of rows) {
      const columns = Object.keys(row)
      await target.query(`INSERT INTO "${table}" (${columns.map((column) => `"${column}"`).join(',')}) VALUES (${columns.map((_, index) => `$${index + 1}`).join(',')}) ON CONFLICT DO NOTHING`, columns.map((column) => row[column]))
    }
    summary.productRows[table] = rows.length
  }
  await target.query('COMMIT')
  const notesDirectory = `${state.scratch}/migration-notes`
  await fs.mkdir(notesDirectory, { recursive: true })
  await execute('extract-notes', 'tar', ['-xzf', path.join(process.env.HOME, 'migrate-copy/notes.tar.gz'), '-C', notesDirectory])
  const notes = await Effect.runPromise(Effect.scoped(readNotes(`${notesDirectory}/memory`)))
  summary.notes = [...notes].map(([personId, notes]) => ({ personId, count: notes.length, entries: notes.map(({ file, layer, updatedAt }) => ({ file, layer, updatedAt })) }))
  const map = `${state.scratch}/migration-map.json`
  const token = `${state.scratch}/runtime-token`
  const args = ['/tmp/vivid-migrate-r2-reader.cjs', '--source', sourceUrl, '--notes', `${notesDirectory}/memory`, '--cells', `http://127.0.0.1:${state.ports.runtime},http://127.0.0.1:${state.ports.runtimePeer}`, '--token', token, '--map', map]
  await execute('reader-first', process.execPath, args, { cwd: product, env: { ...process.env, DATABASE_URL: targetUrl, VIVID_TEST_DATABASE_URL: targetUrl } })
  const first = await fs.readFile(map, 'utf8')
  const loaded = JSON.parse(first)
  await json('map-first', loaded)
  summary.loadedThreads = loaded.length
  summary.mappedDeliveries = loaded.reduce((count, thread) => count + thread.deliveries.length, 0)
  const unmapped = oldRuns.filter((run) => !loaded.some((thread) => thread.threadId === run.thread_id && thread.deliveries.some((delivery) => delivery.requestId === run.receipt.runId)))
  summary.unmapped = unmapped.map((run) => ({ runId: run.id, threadId: run.thread_id }))
  const adopted = (await target.query('SELECT id, receipt FROM vivid_runs ORDER BY id')).rows
  await json('receipts-first', adopted)
  const bearer = (await fs.readFile(token, 'utf8')).trim()
  const histories = []
  for (const thread of loaded) {
    const response = await fetch(`http://127.0.0.1:${state.ports.runtime}/persons/${thread.personId}/threads/${thread.threadId}/state`, { headers: { authorization: `Bearer ${bearer}` } })
    assert.equal(response.status, 200)
    const page = await response.json()
    assert.ok(page.messages.length > 0)
    assert.equal(page.working, false)
    assert.equal(page.queued, 0)
    await json(`history-${thread.threadId}`, page)
    histories.push({ personId: thread.personId, threadId: thread.threadId, messages: page.messages.length, pictures: page.messages.flatMap((message) => message.parts).filter((part) => part.type === 'file') })
  }
  summary.histories = histories
  await execute('reader-repeat', process.execPath, args, { cwd: product, env: { ...process.env, DATABASE_URL: targetUrl, VIVID_TEST_DATABASE_URL: targetUrl } })
  assert.equal(await fs.readFile(map, 'utf8'), first)
  assert.deepEqual((await target.query('SELECT id, receipt FROM vivid_runs ORDER BY id')).rows, adopted)
  summary.identicalRerun = true
  assert.equal(summary.streams, 127)
  assert.equal(summary.loadedThreads + summary.noStreamThreads.length, 72)
  assert.equal(summary.unmapped.length, 0)
  summary.failedSettlements = await proveSettlements(state, target, loaded, bearer, json)
  summary.memoryTools = await proveMemory(state, notes, bearer, json)
  assert.equal(summary.receiptedRuns, 183)
  summary.status = 'loaded; memory tools passed; browser pending'
  await json('summary', summary)
  console.log(JSON.stringify({ loaded: summary.loadedThreads, streams: summary.streams, deliveries: summary.mappedDeliveries, receiptedRuns: summary.receiptedRuns, unmapped: summary.unmapped.length, notes: summary.notes.map((person) => ({ personId: person.personId, count: person.count })), identicalRerun: summary.identicalRerun, evidence: directory }))
} catch (error) {
  summary.status = 'failed'
  summary.error = error.message
  await json('summary', summary)
  throw error
} finally {
  await target.end()
  if (source) await source.end()
  await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`)
  await admin.end()
  await json('source-cleanup', { database: databaseName, dropped: true })
}
