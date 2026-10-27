import * as NodeChildProcess from 'node:child_process'
import * as NodeHttp from 'node:http'
import * as NodeFSP from 'node:fs/promises'
import * as NodeOS from 'node:os'
import * as NodePath from 'node:path'
import { AgentFS } from 'agentfs-sdk'
import { Pool } from 'pg'
import { expect, it } from '@effect/vitest'
import { Config, Effect, Schema } from 'effect'
import { NoteFile, NoteSearch, RuntimeHistoryMap } from '../../packages/contracts/src/index.ts'
import { scenario, admit, delivery } from '../../packages/agent/runtime/tests/requests.ts'
import { SOURCE_TABLES, BIRTH, REPLY_BATCHES, PICTURE, ROOT, ada } from './fixture.ts'

const thread = 'earlier-thread'
const run = 'product-run'
const decodeMap = Schema.decodeUnknownEffect(Schema.fromJsonString(RuntimeHistoryMap))

/** Exercise the shipped reader process over TCP, real legacy PG tables, AgentFS and native Pi SQLite. */
it.effect(
  'reads an old source and notes without modifying them, then adopts Run receipts idempotently',
  () =>
    scenario((_given, runtime) =>
      Effect.gen(function* () {
        const url = yield* Config.String('VIVID_TEST_DATABASE_URL')
        const pool = yield* Effect.acquireRelease(
          Effect.sync(() => new Pool({ connectionString: url, max: 1 })),
          (opened) => Effect.promise(() => opened.end()),
        )
        const query = (sql: string, values: unknown[] = []) =>
          Effect.tryPromise(() => pool.query(sql, values))
        yield* Effect.addFinalizer(() =>
          Effect.promise(() =>
            pool
              .query(
                'DROP TABLE IF EXISTS flue_attachments, flue_conversation_stream_batches, flue_conversation_streams',
              )
              .then(() =>
                pool.query('DELETE FROM vivid_conversations WHERE id IN ($1,$2)', [
                  thread,
                  'refused-thread',
                ]),
              )
              .then(() => pool.query('DELETE FROM "user" WHERE id=$1', [ada])),
          ).pipe(Effect.asVoid),
        )
        for (const sql of SOURCE_TABLES) yield* query(sql)
        yield* query('INSERT INTO "user" (id,name,email) VALUES ($1,$2,$3)', [
          ada,
          'Ada',
          'earlier@example.test',
        ])
        yield* query(
          'INSERT INTO vivid_conversations (id,person_id,title,title_source,updated_at) VALUES ($1,$2,$3,$4,$5)',
          [thread, ada, 'Earlier', 'Person', 1],
        )
        yield* query(
          'INSERT INTO vivid_runs (id,thread_id,person_id,turn,origin,state,started_at,finished_at,receipt) VALUES ($1,$2,$3,1,$4,$5,1,2,$6)',
          [
            run,
            thread,
            ada,
            JSON.stringify({ _tag: 'Message' }),
            'completed',
            JSON.stringify({ runId: 'sub_1', offset: '0', incarnation: 'inc' }),
          ],
        )
        const path = `agents/vivid/${thread}`
        yield* query(
          'INSERT INTO flue_conversation_streams (path,identity_json,incarnation) VALUES ($1,$2,$3)',
          [path, JSON.stringify({ agentName: 'vivid', instanceId: thread }), 'inc'],
        )
        for (const [seq, batch] of [[BIRTH], ...REPLY_BATCHES].entries())
          yield* query(
            'INSERT INTO flue_conversation_stream_batches (path,seq,producer_id,producer_epoch,producer_sequence,data) VALUES ($1,$2,$3,1,$2,$4)',
            [path, seq, 'writer', JSON.stringify(batch)],
          )
        yield* query(
          'INSERT INTO flue_attachments (stream_path,attachment_id,mime_type,byte_size,digest,conversation_id,bytes,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,1)',
          [
            path,
            PICTURE.id,
            PICTURE.mimeType,
            PICTURE.size,
            PICTURE.digest,
            ROOT,
            Buffer.from([1, 2, 3]),
          ],
        )
        const directory = yield* Effect.acquireRelease(
          Effect.tryPromise(() =>
            NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), 'vivid-reader-proof-')),
          ),
          (owned) => Effect.promise(() => NodeFSP.rm(owned, { recursive: true, force: true })),
        )
        const notes = NodePath.join(directory, 'notes')
        yield* Effect.tryPromise(() => NodeFSP.mkdir(notes))
        const notePath = NodePath.join(notes, `${ada}.db`)
        const noteTime = yield* Effect.acquireUseRelease(
          Effect.tryPromise(() => AgentFS.open({ path: notePath })),
          (store) =>
            Effect.tryPromise(() =>
              store.fs
                .writeFile(
                  '/kettle.md',
                  '---\nkind: preference\ndescription: Copper kettle\n---\n\nUse the copper kettle.\n',
                )
                .then(() => store.fs.stat('/kettle.md'))
                .then((stat) => stat.mtime * 1000),
            ),
          (store) => Effect.promise(() => store.close()),
        )
        const original = yield* Effect.tryPromise(() => NodeFSP.readFile(notePath))
        const originalRows = (yield* query(
          'SELECT data FROM flue_conversation_stream_batches ORDER BY seq',
        )).rows
        const token = NodePath.join(directory, 'token')
        const map = NodePath.join(directory, 'map.json')
        yield* Effect.tryPromise(() =>
          NodeFSP.writeFile(token, 'fixture-runtime-token', { mode: 0o600 }),
        )
        const context = yield* Effect.context()
        const server = NodeHttp.createServer((request, response) => {
          const chunks: Buffer[] = []
          request.on('data', (chunk: Buffer) => chunks.push(chunk))
          request.on('end', () => {
            const body = Schema.decodeSync(Schema.fromJsonString(Schema.Json))(
              Buffer.concat(chunks).toString('utf8'),
            )
            // Native HTTP callback adapts only the real fixture router, never its persistence boundary.
            void Effect.runPromiseWith(context)(
              runtime.send(request.url === undefined ? '/' : request.url, { method: 'POST', body }),
            ).then(
              (sent) => {
                response.writeHead(sent.status, { 'content-type': 'application/json' })
                response.end(JSON.stringify(sent.body))
              },
              () => {
                response.writeHead(500)
                response.end()
              },
            )
          })
        })
        yield* Effect.addFinalizer(() =>
          Effect.callback<void>((resume) => {
            server.close(() => resume(Effect.void))
          }),
        )
        yield* Effect.callback<void>((resume) => {
          server.listen(0, '127.0.0.1', () => resume(Effect.void))
        })
        const address = server.address()
        if (address === null || typeof address === 'string')
          return yield* Effect.die('No test port')
        const bundle = NodePath.join(directory, 'reader.cjs')
        yield* Effect.callback<void>((resume) => {
          const child = NodeChildProcess.spawn(
            process.execPath,
            ['scripts/oneoff/bundle.mjs', bundle],
            { stdio: 'inherit' },
          )
          child.once('error', (error) => resume(Effect.die(error)))
          child.once('close', (code) =>
            resume(code === 0 ? Effect.void : Effect.die('Bundle failed')),
          )
          return Effect.sync(() => {
            if (child.exitCode === null) child.kill('SIGTERM')
          })
        })
        const invoke = Effect.callback<{ code: number | null; output: string }>((resume) => {
          const child = NodeChildProcess.spawn(
            process.execPath,
            [
              bundle,
              '--source',
              url,
              '--notes',
              notes,
              '--cells',
              `http://127.0.0.1:${address.port}`,
              '--token',
              token,
              '--map',
              map,
            ],
            { env: { ...process.env, DATABASE_URL: url }, stdio: ['ignore', 'pipe', 'pipe'] },
          )
          let output = ''
          child.stdout.on('data', (chunk: Buffer) => {
            output += chunk.toString()
          })
          child.stderr.on('data', (chunk: Buffer) => {
            output += chunk.toString()
          })
          child.once('error', (error) => resume(Effect.die(error)))
          child.once('close', (code) => resume(Effect.succeed({ code, output })))
          return Effect.sync(() => {
            if (child.exitCode === null) child.kill('SIGTERM')
          })
        })
        const first = yield* invoke
        expect(first.output).toContain('History and receipts migrated')
        expect(first.output).toContain('Run receipts adopted')
        expect(first.code).toBe(0)
        const firstMap = yield* Effect.tryPromise(() => NodeFSP.readFile(map, 'utf8'))
        const rows = yield* decodeMap(firstMap)
        expect(rows).toHaveLength(1)
        expect(rows[0]?.deliveries.map((item) => item.requestId)).toEqual(['sub_1'])
        const adopted = (yield* query('SELECT receipt FROM vivid_runs WHERE id=$1', [run])).rows[0]
        expect(adopted.receipt).toEqual({
          runId: run,
          submissionId: String(rows[0]?.deliveries[0]?.submissionId),
        })
        const state = yield* runtime.send(`/persons/${ada}/threads/${thread}/state`, {
          method: 'GET',
        })
        expect(JSON.stringify(state.body)).toContain('A cat.')
        const hits = yield* runtime.notes.search(
          ada,
          NoteSearch.make({ query: 'copper', layer: null, limit: 10, offset: 0 }),
        )
        expect(hits.entries.map((hit) => hit.file)).toEqual([NoteFile.make('kettle.md')])
        expect((yield* invoke).code).toBe(0)
        expect(yield* Effect.tryPromise(() => NodeFSP.readFile(map, 'utf8'))).toBe(firstMap)
        expect((yield* query('SELECT receipt FROM vivid_runs WHERE id=$1', [run])).rows[0]).toEqual(
          adopted,
        )
        expect(
          yield* runtime.notes.read(ada, { layer: 'memory', file: NoteFile.make('kettle.md') }),
        ).toMatchObject({ revision: 1, updatedAt: noteTime, basis: 'said' })
        const refused = 'refused-thread'
        yield* query(
          'INSERT INTO vivid_conversations (id,person_id,title,title_source,updated_at) VALUES ($1,$2,$3,$4,$5)',
          [refused, ada, 'Already used', 'Person', 1],
        )
        yield* query(
          'INSERT INTO flue_conversation_streams (path,identity_json,incarnation) VALUES ($1,$2,$3)',
          [
            `agents/vivid/${refused}`,
            JSON.stringify({ agentName: 'vivid', instanceId: refused }),
            'inc',
          ],
        )
        yield* query(
          'INSERT INTO flue_conversation_stream_batches (path,seq,producer_id,producer_epoch,producer_sequence,data) SELECT $1,seq,producer_id,producer_epoch,producer_sequence,data FROM flue_conversation_stream_batches WHERE path=$2',
          [`agents/vivid/${refused}`, path],
        )
        yield* query(
          'INSERT INTO flue_attachments SELECT $1, attachment_id, mime_type, byte_size, digest, conversation_id, bytes, created_at FROM flue_attachments WHERE stream_path=$2',
          [`agents/vivid/${refused}`, path],
        )
        yield* admit(runtime, ada, delivery(refused, 'already-native', { creator: ada }))
        yield* query('UPDATE vivid_runs SET receipt=$1 WHERE id=$2', [
          JSON.stringify({ runId: 'sub_1', offset: '0', incarnation: 'inc' }),
          run,
        ])
        const partial = yield* invoke
        expect(partial.code).not.toBe(0)
        expect(partial.output).toContain('Run receipts adopted')
        expect(partial.output).toContain(refused)
        expect((yield* query('SELECT receipt FROM vivid_runs WHERE id=$1', [run])).rows[0]).toEqual(
          adopted,
        )
        yield* query('DELETE FROM flue_conversation_stream_batches WHERE path=$1', [
          `agents/vivid/${refused}`,
        ])
        yield* query('DELETE FROM vivid_conversations WHERE id=$1', [refused])
        expect(yield* Effect.tryPromise(() => NodeFSP.readFile(notePath))).toEqual(original)
        expect(
          (yield* query('SELECT data FROM flue_conversation_stream_batches ORDER BY seq')).rows,
        ).toEqual(originalRows)
      }),
    ),
)
