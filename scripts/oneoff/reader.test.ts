import * as NodeChildProcess from 'node:child_process'
import * as NodeHttp from 'node:http'
import * as NodeFSP from 'node:fs/promises'
import * as NodeOS from 'node:os'
import * as NodePath from 'node:path'
import { AgentFS } from 'agentfs-sdk'
import { Client, g, Order, readBatch, writeBatch } from '@helix-db/helix-db'
import { Pool } from 'pg'
import { expect, it } from '@effect/vitest'
import { Config, Effect, Schema } from 'effect'
import {
  MemoryFile,
  MemorySearch,
  PersonId,
  RuntimeHistoryMap,
} from '../../packages/contracts/src/index.ts'
import { HistoryBodies } from './reader.ts'
import { scenario, admit, delivery } from '../../packages/agent/runtime/tests/requests.ts'
import { SOURCE_TABLES, BIRTH, REPLY_BATCHES, PICTURE, ROOT, ada } from './fixture.ts'

const thread = 'earlier-thread'
const run = 'product-run'
const decodeMap = Schema.decodeUnknownEffect(Schema.fromJsonString(RuntimeHistoryMap))
const decodeBodies = Schema.decodeUnknownEffect(Schema.fromJsonString(HistoryBodies))

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
        const helixUrl = yield* Config.String('VIVID_TEST_HELIX_URL')
        const helix = new Client(helixUrl)
        const memoryOnly = PersonId.make('memory-only-person')
        const fixtures = [
          {
            id: 'personal',
            kind: 'preference',
            content: 'Ada prefers jasmine tea.',
            scope: { _tag: 'Person' },
            partition: `p-${ada}`,
            key: `person:${ada}`,
            person: ada,
            state: 'current',
          },
          {
            id: 'company',
            kind: 'decision',
            content:
              'The Company uses a silver teapot. ' +
              'Everyone shares the tea after lunch. '.repeat(7),
            scope: { _tag: 'Company' },
            partition: 'c-earlier-company',
            key: 'company',
            person: ada,
            state: 'current',
          },
          {
            id: 'thread',
            kind: 'fact',
            content: 'The jasmine tea order arrives on Friday.',
            scope: { _tag: 'Thread', threadId: thread, title: 'Earlier' },
            partition: 'c-earlier-company',
            key: `thread:${thread}`,
            person: ada,
            state: 'current',
          },
          {
            id: 'only',
            kind: 'fact',
            content: 'Grace keeps an ivory teapot.',
            scope: { _tag: 'Person' },
            partition: `p-${memoryOnly}`,
            key: `person:${memoryOnly}`,
            person: memoryOnly,
            state: 'current',
          },
          {
            id: 'superseded',
            kind: 'preference',
            content: 'Ada preferred coffee.',
            scope: { _tag: 'Person' },
            partition: `p-${ada}`,
            key: `person:${ada}`,
            person: ada,
            state: 'superseded',
          },
          {
            id: 'forgotten',
            kind: 'fact',
            content: 'The forgotten tea order.',
            scope: { _tag: 'Person' },
            partition: `p-${ada}`,
            key: `person:${ada}`,
            person: ada,
            state: 'forgotten',
          },
        ] as const
        let seed = writeBatch()
        for (const item of fixtures) {
          const payload = {
            memory: {
              id: item.id,
              kind: item.kind,
              content: item.content,
              scope: item.scope,
              learnedIn: thread,
              learnedFrom: { id: item.person, name: 'Ada' },
              createdAt: 100,
              updatedAt: 200,
            },
            aliases: [],
            scope: item.key,
          }
          seed = seed.varAs(
            item.id,
            g().addN('Memory', {
              tenant_id: item.partition,
              memoryId: item.id,
              scope: item.key,
              payload: JSON.stringify(payload),
              createdAt: 100,
              updatedAt: 200,
              isLatest: item.state !== 'superseded',
              validTo: item.state === 'superseded' ? 200 : null,
              deletedAt: item.state === 'forgotten' ? 200 : null,
            }),
          )
        }
        yield* Effect.tryPromise(() => helix.query(seed.returning([]).toQueryRequest()).send())
        const sourceMemory = () =>
          Effect.tryPromise(() =>
            helix
              .query(
                readBatch()
                  .varAs(
                    'records',
                    g().nWithLabel('Memory').orderBy('memoryId', Order.Asc).valueMap(null),
                  )
                  .returning(['records'])
                  .toQueryRequest(),
              )
              .send(),
          )
        const originalMemory = yield* sourceMemory()
        const originalRows = (yield* query(
          'SELECT data FROM flue_conversation_stream_batches ORDER BY seq',
        )).rows
        const token = NodePath.join(directory, 'token')
        const map = NodePath.join(directory, 'map.json')
        yield* Effect.tryPromise(() =>
          NodeFSP.writeFile(token, 'fixture-runtime-token', { mode: 0o600 }),
        )
        const context = yield* Effect.context()
        let posted = 0
        const server = NodeHttp.createServer((request, response) => {
          posted += 1
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
        const invoke = (extra: string[]) =>
          Effect.callback<{ code: number | null; output: string }>((resume) => {
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
                ...extra,
              ],
              {
                env: { ...process.env, DATABASE_URL: url, VIVID_HELIX_URL: helixUrl },
                stdio: ['ignore', 'pipe', 'pipe'],
              },
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
        const exportFile = NodePath.join(directory, 'bodies.json')
        const dry = yield* invoke(['--dry-run', exportFile])
        expect(dry.code, dry.output).toBe(0)
        expect(dry.output).toContain('History bodies exported')
        expect(dry.output).not.toContain('Run receipts adopted')
        expect(posted).toBe(0)
        expect(
          (yield* query('SELECT receipt FROM vivid_runs WHERE id=$1', [run])).rows[0].receipt,
        ).toEqual({ runId: 'sub_1', offset: '0', incarnation: 'inc' })
        const exported = yield* decodeBodies(
          yield* Effect.tryPromise(() => NodeFSP.readFile(exportFile, 'utf8')),
        )
        const memoryBodies = exported.map(({ personId, body }) => ({
          personId,
          memory: body.memory,
        }))
        process.stdout.write(`Mapped memory entries ${JSON.stringify(memoryBodies)}\n`)
        expect(memoryBodies.flatMap((row) => row.memory)).toHaveLength(5)
        expect(
          exported.filter((row) => row.personId === memoryOnly).map((row) => row.body),
        ).toMatchObject([
          {
            threads: [],
            memory: [
              { body: 'Grace keeps an ivory teapot.', kind: 'fact', basis: 'said', updatedAt: 200 },
            ],
          },
        ])
        const mapped = memoryBodies
          .flatMap((row) => row.memory)
          .filter((entry) => entry.file !== 'kettle.md')
        expect(mapped).toHaveLength(4)
        for (const entry of mapped) {
          expect(entry.file).toMatch(/^[a-z0-9][a-z0-9-]{0,62}\.md$/u)
          expect(entry.description.length).toBeLessThanOrEqual(200)
          expect(entry).toMatchObject({ layer: 'memory', basis: 'said', updatedAt: 200 })
        }
        expect(mapped.find((entry) => entry.kind === 'decision')).toMatchObject({
          description:
            'The Company uses a silver teapot. Everyone shares the tea after lunch. Everyone shares the tea after lunch. Everyone shares the tea after lunch. Everyone shares the tea after lunch. Everyone shares',
          body: fixtures[1].content + '\n\nThis memory was for the whole Company.',
        })
        expect(
          mapped.some((entry) =>
            entry.body.endsWith('This memory was learned in the Thread "Earlier".'),
          ),
        ).toBe(true)
        expect(JSON.stringify(mapped)).not.toContain('preferred coffee')
        expect(JSON.stringify(mapped)).not.toContain('forgotten tea')
        const exportAgain = NodePath.join(directory, 'bodies-again.json')
        expect((yield* invoke(['--helix', helixUrl, '--dry-run', exportAgain])).code).toBe(0)
        expect(yield* Effect.tryPromise(() => NodeFSP.readFile(exportAgain, 'utf8'))).toBe(
          yield* Effect.tryPromise(() => NodeFSP.readFile(exportFile, 'utf8')),
        )
        expect(posted).toBe(0)
        const first = yield* invoke([])
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
        const hits = yield* runtime.memory.search(
          ada,
          MemorySearch.make({ query: 'copper', layer: null, limit: 10, offset: 0 }),
        )
        expect(hits.entries.map((hit) => hit.file)).toEqual([MemoryFile.make('kettle.md')])
        const savedMemory = []
        for (const { personId, memory } of memoryBodies) {
          for (const entry of memory) savedMemory.push(yield* runtime.memory.read(personId, entry))
          const found = yield* runtime.memory.search(
            personId,
            MemorySearch.make({
              query: 'tea OR teapot OR kettle',
              layer: null,
              limit: 20,
              offset: 0,
            }),
          )
          expect(found.entries.map((entry) => entry.file).toSorted()).toEqual(
            memory.map((entry) => entry.file).toSorted(),
          )
        }
        expect((yield* invoke([])).code).toBe(0)
        const reloadedMemory = []
        for (const { personId, memory } of memoryBodies)
          for (const entry of memory)
            reloadedMemory.push(yield* runtime.memory.read(personId, entry))
        expect(reloadedMemory).toEqual(savedMemory)
        expect(yield* Effect.tryPromise(() => NodeFSP.readFile(map, 'utf8'))).toBe(firstMap)
        expect((yield* query('SELECT receipt FROM vivid_runs WHERE id=$1', [run])).rows[0]).toEqual(
          adopted,
        )
        expect(
          yield* runtime.memory.read(ada, { layer: 'memory', file: MemoryFile.make('kettle.md') }),
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
        const partial = yield* invoke([])
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
        expect(yield* sourceMemory()).toEqual(originalMemory)
      }),
    ),
)
