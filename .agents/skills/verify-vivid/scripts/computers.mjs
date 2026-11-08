import * as NodeFSP from 'node:fs/promises'
import * as NodeAssert from 'node:assert/strict'
import { command, json } from './process.mjs'
import { hosts } from './hosts.mjs'
import { boatKey } from './settings.mjs'
import { Schema } from 'effect'
import { decodeText } from './receipts.mjs'

/** A binding row as machines.json keeps it: the creation intent, and Boat's id once known. */
const Machines = Schema.Array(
  Schema.Struct({ intent: Schema.String, id: Schema.NullOr(Schema.String) }),
)
/** The parts of Boat's v1 answers this module reads (apps/server/src/computers/boat/protocol.ts). */
const Described = Schema.Struct({ sandbox: Schema.Struct({ createdAt: Schema.String }) })
const FileRead = Schema.Struct({ content: Schema.String })
const Deletion = Schema.Struct({
  operation: Schema.Struct({ id: Schema.String, status: Schema.String }),
})
const Limits = Schema.Struct({
  canStart: Schema.Boolean,
  startBlockedReason: Schema.optional(Schema.NullOr(Schema.String)),
})
const Passes = Schema.Array(Schema.Json)

/** The prepared image production Computers start from (apps/server/src/computers/README.md). */
export const template = 'vivid-computer-20261004'
/** The production Vivid Computer. It is never this run's, whatever a record says. */
const production = 'bx_yjj2hakd'
/** Boat's v1 API. The override exists only for recovery.test.mjs's local Boat endpoint. */
const api = process.env.VIVID_VERIFY_BOAT_URL ?? 'https://boat.dev/api/v1'
/** Clocks on the devbox and at Boat differ; apps/server/src/computers/boat/created.ts uses the same. */
const CLOCKS_APART = 120_000

/** Boat machines carry no labels, so a run's machines are exactly the ones its disposable
 * database bound. They live in their own file, written by whichever process captures them, so the
 * supervisor's state.json writes never race them away. */
const file = (state) => state.evidence + '/machines.json'

/** Recorded machines, keyed by the product's creation intent. A row with no id is a creation the
 * server sent or was about to send; it is kept so cleanup can say that it is unresolved. */
export async function machines(state) {
  const text = await NodeFSP.readFile(file(state), 'utf8').catch((error) => {
    if (error.code === 'ENOENT') return '[]'
    throw error
  })
  return decodeText(Machines, text)
}

/** Copy every binding row of this run's disposable database into machines.json. Runs after each
 * driven feature and again before cleanup stops the database, so a drive that fails midway still
 * leaves its machine id where cleanup reads it. A database that no longer runs adds nothing. */
export async function capture(state) {
  if (state.computer !== 'disposable') return
  const running = await command([
    'docker',
    'ps',
    '--filter',
    'name=^' + state.container + '$',
    '--format',
    '{{.Names}}',
  ])
  if (running !== state.container) return
  const rows = decodeText(
    Machines,
    await command([
      'docker',
      'exec',
      state.container,
      'psql',
      '-U',
      'verify',
      '-d',
      'verify',
      '-At',
      '-c',
      "SELECT coalesce(json_agg(json_build_object('intent', intent, 'id', provider_id)), '[]'::json) FROM vivid_machine_bindings;",
    ]),
  )
  const known = new Map((await machines(state)).map((machine) => [machine.intent, machine]))
  for (const row of rows) if (row.id !== null || !known.has(row.intent)) known.set(row.intent, row)
  await json(file(state), [...known.values()])
}

/** One authenticated Boat request; the key never reaches evidence. */
async function boat(key, method, path, headers = {}) {
  const response = await fetch(api + path, {
    method,
    headers: { authorization: 'Bearer ' + key, connection: 'close', ...headers },
    signal: AbortSignal.timeout(30_000),
  })
  return { status: response.status, text: await response.text() }
}

/** What Doctor says about the Computer authority without starting a machine: whether Launch
 * configured it, and whether Boat would accept a start now (`/limits`, read-only). */
export async function authority(state) {
  if (state.computer !== 'disposable') return { authority: state.computer ?? 'unconfigured' }
  const key = await boatKey()
  if (!key) return { authority: 'disposable', limits: 'not read: no VIVID_BOAT_API_KEY here' }
  const limits = decodeText(Limits, (await boat(key, 'GET', '/limits')).text)
  return { authority: 'disposable', template, ...limits }
}

/** The text of a file on this run's Computer, read through Boat and not through Vivid, so what a
 * program wrote is evidence from outside the thing being proved (code/thread.live.test.ts). */
export async function computerFile(state, path) {
  const machine = (await machines(state)).find((recorded) => recorded.id !== null)
  NodeAssert.ok(machine, 'No Computer was bound in the disposable database')
  const key = await boatKey()
  NodeAssert.ok(key, 'VIVID_BOAT_API_KEY is required to read the Computer')
  const read = await boat(
    key,
    'GET',
    `/sandboxes/${machine.id}/files?path=${encodeURIComponent(path)}&encoding=base64`,
  )
  NodeAssert.equal(read.status, 200, 'The file the program wrote must be on the Computer')
  const { content } = decodeText(FileRead, read.text)
  return { machine: machine.id, text: Buffer.from(content, 'base64').toString('utf8') }
}

/** Delete exactly the machines this run recorded. Each must not be production or a devbox and
 * must have been created after Launch began; a machine already gone is a no-op, so a second
 * cleanup converges. Every pass is appended to computer-cleanup.json. */
export async function release(state) {
  const recorded = await machines(state)
  if (recorded.length === 0) return []
  const key = await boatKey()
  if (!key)
    throw new Error(
      'This run recorded Boat machines; set VIVID_VERIFY_KEY_FILE with VIVID_BOAT_API_KEY to delete them',
    )
  const receipts = []
  try {
    for (const machine of recorded) receipts.push(await remove(key, state, machine))
  } finally {
    const passes = decodeText(
      Passes,
      await NodeFSP.readFile(state.evidence + '/computer-cleanup.json', 'utf8').catch((error) => {
        if (error.code === 'ENOENT') return '[]'
        throw error
      }),
    )
    await json(state.evidence + '/computer-cleanup.json', [
      ...passes,
      { at: new Date().toISOString(), receipts },
    ])
  }
  for (const receipt of receipts)
    if (receipt.outcome === 'deleted')
      NodeAssert.equal(receipt.get, 404, `Machine ${receipt.id} is still described after deletion`)
  return receipts
}

/** One recorded machine's deletion receipt, or a refusal that leaves it untouched. */
async function remove(key, state, { intent, id }) {
  if (id === null)
    return { intent, outcome: 'unresolved: creation sent with no machine id recorded' }
  if (id === production || Object.values(hosts).includes(id))
    throw new Error('Refused to delete production or devbox machine ' + id)
  const before = await boat(key, 'GET', '/sandboxes/' + id)
  if (before.status === 404) return { id, outcome: 'absent', get: 404 }
  NodeAssert.equal(before.status, 200, 'Boat did not describe machine ' + id)
  const created = decodeText(Described, before.text).sandbox.createdAt
  if (!(Date.parse(created) >= Date.parse(state.started) - CLOCKS_APART))
    throw new Error(`Machine ${id} was created ${created}, before this run; left untouched`)
  const deleted = await boat(key, 'DELETE', '/sandboxes/' + id, { 'x-ascii-confirm-delete': id })
  NodeAssert.equal(deleted.status, 202, 'Boat refused to delete ' + id)
  const after = await boat(key, 'GET', '/sandboxes/' + id)
  return {
    id,
    outcome: 'deleted',
    createdAt: created,
    delete: { status: deleted.status, operation: decodeText(Deletion, deleted.text).operation },
    get: after.status,
  }
}
