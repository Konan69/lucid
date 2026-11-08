import * as NodeFSP from 'node:fs/promises'
import * as NodeAssert from 'node:assert/strict'
import * as NodeSqlite from 'node:sqlite'
import { apply } from '@earendil-works/chord/delta'
import { Schema } from 'effect'
import { decode, json } from './wire.mjs'

const LearnedRun = Schema.Struct({ taskId: Schema.NullOr(Schema.Number) })
const JsonText = Schema.fromJsonString(Schema.Json)
const Task = Schema.Struct({
  id: Schema.Number,
  state: Schema.Union([
    Schema.Struct({
      status: Schema.Literals(['pending', 'running', 'waiting', 'sleeping', 'completing']),
    }),
    Schema.Struct({
      status: Schema.Literal('terminal'),
      outcome: Schema.Struct({ status: Schema.Literals(['completed', 'failed', 'aborted']) }),
    }),
  ]),
})
const TaskText = Schema.fromJsonString(Task)

/**
 * LearnedRun names the native task, not its completion. Read both in one read-only snapshot of
 * this launch's SQLite. Pi 1.4 stores JSON-indexed keys and base/delta document revisions in
 * storage/sqlite/storage.js; the shipped Person cell uses the pi_ table prefix.
 */
function receipt(path, submission) {
  const db = new NodeSqlite.DatabaseSync(path, { readOnly: true })
  try {
    db.exec('BEGIN')
    const document = db
      .prepare(`SELECT id FROM pi_documents
      WHERE kind = ? AND key_value = ? AND scope_kind = 'conversation'
      AND owner_id = (SELECT conversation_id FROM pi_submissions WHERE id = ?)
      AND retired_at IS NULL`)
      .get(JSON.stringify('vivid.learning'), JSON.stringify(submission), Number(submission))
    if (!document) return null
    const base = db
      .prepare(`SELECT seq, content FROM pi_document_revisions
      WHERE document_id = ? AND kind = 'base' ORDER BY seq DESC LIMIT 1`)
      .get(document.id)
    NodeAssert.ok(base, 'LearnedRun has no base revision')
    let value = decode(JsonText, base.content)
    for (const delta of db
      .prepare(`SELECT content FROM pi_document_revisions
      WHERE document_id = ? AND seq > ? ORDER BY seq`)
      .all(document.id, base.seq))
      value = apply(value, decode(JsonText, delta.content))
    const saved = decode(LearnedRun, value)
    if (saved.taskId === null) return null
    const row = db.prepare('SELECT record FROM pi_tasks WHERE id = ?').get(saved.taskId)
    NodeAssert.ok(row, 'LearnedRun names a missing task')
    const task = decode(TaskText, row.record)
    if (task.state.status !== 'terminal') return null
    NodeAssert.equal(task.state.outcome.status, 'completed', 'Native learning task failed')
    return { path, submission, learned: saved, task }
  } finally {
    db.close()
  }
}

/** Watch native file commits before reading, so a fast learner and a delayed learner both count.
 * No product route exposes LearnedRun. Only this launch's disposable cell files are observed. */
export async function learned(state, submission, directory) {
  const abort = new AbortController()
  const changes = NodeFSP.watch(state.scratch, {
    recursive: true,
    signal: AbortSignal.any([abort.signal, AbortSignal.timeout(300_000)]),
  })
  try {
    for (;;) {
      const changed = changes.next()
      // Teardown closes an outstanding read when the initial snapshot already proves completion.
      changed.catch(() => {})
      const paths = await Array.fromAsync(
        NodeFSP.glob(state.scratch + '/runtime*/Person:*/ltx/*/db.sqlite'),
      )
      const done = paths.map((path) => receipt(path, submission)).find(Boolean)
      if (done) {
        await json(directory + '/learning-completed.json', done)
        return done
      }
      const event = await changed
      NodeAssert.equal(event.done, false, 'Native learning observation closed before completion')
    }
  } finally {
    abort.abort()
    await changes.return()
  }
}
