import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { describe, expect, it } from '@effect/vitest'
import { ConversationState, ThreadId } from '@vivid/contracts'
import { ConfigProvider, Effect, Exit, Layer, Option, Result, Schema, Scope } from 'effect'
import { databaseConfigured, disposableDatabase } from '../../tests/database.ts'
import { start, world } from '../../tests/process.ts'
import {
  ada,
  grace,
  IDLE,
  scenario,
  threadPath,
  untilResting,
  type Runtime,
} from '../../tests/requests.ts'
import { query } from '../../tests/stores.ts'
import { carry, Landed } from './carry.ts'
import { fold, Item, type Carried } from './fold.ts'
import { decodeRecords } from './records.ts'
import { flueSourceLayer } from './source.ts'
import { sweep, type Report } from './sweep.ts'

const decodeState = Schema.decodeUnknownEffect(ConversationState)

/** The whole state by the runtime's plain read, the one the state link opens with. */
const read = Effect.fn('FlueCarryTest.read')(function* (runtime: Runtime, threadId: string) {
  const response = yield* runtime.send(`${threadPath(ada, threadId)}/state`, { method: 'GET' })
  expect(response.status).toBe(200)
  return yield* decodeState(response.body)
})

const USAGE = {
  input: 10,
  output: 5,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 15,
  cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, total: 3 },
}
const SUMMED = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: 3 }
const MODEL = { api: 'openai-completions', provider: 'example', model: 'example' } as const

/** A reply's text, as a model message the fold would have committed. */
const reply = (text: string, timestamp: number) =>
  Item.Replied({
    message: {
      role: 'assistant',
      content: [{ type: 'text', text }],
      ...MODEL,
      usage: USAGE,
      stopReason: 'stop',
      timestamp,
    },
  })

/** Two old replies: a picture and a tool round, then a shared message from Ada. */
const history = (threadId: ThreadId): Carried => ({
  threadId,
  origin: { creator: ada, creatorName: 'Ada' },
  items: [
    Item.Said({
      message: {
        role: 'user',
        content: [
          { type: 'text', text: 'List my Routines' },
          { type: 'image', data: 'AQID', mimeType: 'image/png' },
        ],
        timestamp: 1792058401000,
      },
      submission: Option.some('sub_1'),
    }),
    Item.Ran({ inputs: ['sub_1'] }),
    Item.Replied({
      message: {
        role: 'assistant',
        content: [
          { type: 'toolCall', id: 'call_1', name: 'list_routines', arguments: { limit: 5 } },
        ],
        ...MODEL,
        usage: USAGE,
        stopReason: 'toolUse',
        timestamp: 1792058402000,
      },
    }),
    Item.Answered({
      message: {
        role: 'toolResult',
        toolCallId: 'call_1',
        toolName: 'list_routines',
        content: [{ type: 'text', text: '{"ok":true}' }],
        isError: false,
        timestamp: 1792058402500,
        details: { output: { ok: true } },
        durationMs: 12,
      },
    }),
    reply('Done', 1792058403000),
    Item.Responded({
      data: {
        outcome: 'completed',
        startedAt: 1792058401000,
        finishedAt: 1792058403300,
        toolCallCount: 1,
        usage: SUMMED,
        model: 'example/example',
      },
      inputs: [{ submission: 'sub_1', outcome: 'completed' }],
    }),
    Item.Signalled({
      data: { type: 'message', attributes: { from: 'Ada', turn: '2' }, body: 'Please check' },
      message: {
        role: 'user',
        content: '<message type="message" from="Ada" turn="2">\nPlease check\n</message>',
        timestamp: 1792058410000,
      },
      submission: Option.some('sub_2'),
    }),
    Item.Ran({ inputs: ['sub_2'] }),
    reply('Checked.', 1792058411000),
    Item.Responded({
      data: {
        outcome: 'completed',
        startedAt: 1792058410000,
        finishedAt: 1792058412000,
        toolCallCount: 0,
        usage: SUMMED,
        model: 'example/example',
      },
      inputs: [{ submission: 'sub_2', outcome: 'completed' }],
    }),
  ],
})

/** Flue 2.2.2's tables as `@flue/postgres` creates them, and the product's Thread table's columns read here. */
const SOURCE_TABLES = [
  `CREATE TABLE flue_conversation_streams (
     path TEXT PRIMARY KEY, identity_json TEXT NOT NULL, next_offset BIGINT NOT NULL DEFAULT 0,
     producer_id TEXT, producer_epoch BIGINT NOT NULL DEFAULT 0,
     next_producer_sequence BIGINT NOT NULL DEFAULT 0, incarnation TEXT NOT NULL)`,
  `CREATE TABLE flue_conversation_stream_batches (
     path TEXT NOT NULL, seq BIGINT NOT NULL, producer_id TEXT NOT NULL,
     producer_epoch BIGINT NOT NULL, producer_sequence BIGINT NOT NULL, data TEXT NOT NULL,
     submission_id TEXT, attempt_id TEXT, PRIMARY KEY (path, seq))`,
  `CREATE TABLE flue_attachments (
     stream_path TEXT NOT NULL, attachment_id TEXT NOT NULL, mime_type TEXT NOT NULL,
     byte_size BIGINT NOT NULL, digest TEXT NOT NULL, conversation_id TEXT NOT NULL,
     bytes BYTEA NOT NULL, created_at BIGINT NOT NULL, PRIMARY KEY (stream_path, attachment_id))`,
  `CREATE TABLE vivid_conversations (
     id TEXT PRIMARY KEY, person_id TEXT NOT NULL, archived BOOLEAN NOT NULL DEFAULT false)`,
]

const KEPT = ThreadId.make('00000000-0000-4000-8000-00000000000a')
const GONE = ThreadId.make('00000000-0000-4000-8000-00000000000b')
const OTHER = ThreadId.make('00000000-0000-4000-8000-00000000000c')
const ROOT = 'conv_DEMO'

const record = (
  id: string,
  type: string,
  second: number,
  fields: Readonly<Record<string, Schema.Json>>,
) => ({
  v: 1,
  id,
  type,
  conversationId: ROOT,
  harness: 'default',
  session: 'default',
  timestamp: `2026-10-15T10:00:${String(second).padStart(2, '0')}.000Z`,
  ...fields,
})
const BIRTH = record('r_birth', 'conversation_created', 0, {
  kind: 'root',
  affinityKey: 'aff',
  createdAt: '2026-10-15T10:00:00.000Z',
  initialData: { creator: ada, creatorName: 'Ada' },
})
const PICTURE = {
  id: 'att_user_sub_1_0',
  mimeType: 'image/png',
  size: 3,
  digest: '039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81',
}
/** A reply split over two batches the way Flue's writer splits them, mid-block. */
const REPLY_BATCHES = [
  [
    record('r_user', 'user_message', 1, {
      submissionId: 'sub_1',
      messageId: 'u',
      parentId: null,
      content: [
        { type: 'text', text: 'Look' },
        { type: 'attachment', attachment: PICTURE },
      ],
    }),
    record('r_start', 'assistant_message_started', 2, {
      submissionId: 'sub_1',
      messageId: 'm',
      parentId: 'u',
      modelInfo: MODEL,
    }),
    record('r_open', 'assistant_text_started', 2, {
      submissionId: 'sub_1',
      messageId: 'm',
      blockId: 'b',
      blockIndex: 0,
    }),
    record('r_d0', 'assistant_text_delta', 2, {
      submissionId: 'sub_1',
      messageId: 'm',
      blockId: 'b',
      sequence: 0,
      delta: 'A ',
    }),
  ],
  [
    record('r_d1', 'assistant_text_delta', 3, {
      submissionId: 'sub_1',
      messageId: 'm',
      blockId: 'b',
      sequence: 1,
      delta: 'cat.',
    }),
    record('r_close', 'assistant_text_completed', 3, {
      submissionId: 'sub_1',
      messageId: 'm',
      blockId: 'b',
      deltaCount: 2,
    }),
    record('r_done', 'assistant_message_completed', 3, {
      submissionId: 'sub_1',
      messageId: 'm',
      stopReason: 'stop',
      usage: USAGE,
    }),
    record('r_settled', 'submission_settled', 4, { submissionId: 'sub_1', outcome: 'completed' }),
  ],
]

/** One stream: its row, its batches in `seq` order, and its product Thread when it has one. */
const insertStream = Effect.fn('FlueCarryTest.insertStream')(function* (
  source: string,
  threadId: ThreadId,
  batches: ReadonlyArray<string>,
) {
  const path = `agents/vivid/${threadId}`
  yield* query(
    source,
    `INSERT INTO flue_conversation_streams (path, identity_json, incarnation) VALUES ($1, $2, 'inc')`,
    [path, JSON.stringify({ agentName: 'vivid', instanceId: threadId })],
  )
  for (const [seq, data] of batches.entries())
    yield* query(
      source,
      `INSERT INTO flue_conversation_stream_batches
         (path, seq, producer_id, producer_epoch, producer_sequence, data) VALUES ($1, $2, 'w', 1, $2, $3)`,
      [path, seq, data],
    )
})

/** A source database shaped like production's: Flue's tables beside the product's Threads. */
const sourceDatabase = Effect.fn('FlueCarryTest.source')(function* () {
  const source = yield* disposableDatabase()
  for (const statement of SOURCE_TABLES) yield* query(source, statement)
  const log = [[BIRTH], ...REPLY_BATCHES].map((batch) => JSON.stringify(batch))
  yield* insertStream(source, KEPT, log)
  // A deleted Thread's log is never read; this one would fail to decode if it were.
  yield* insertStream(source, GONE, ['not json'])
  yield* insertStream(source, OTHER, log)
  for (const threadId of [KEPT, OTHER])
    yield* query(
      source,
      `INSERT INTO flue_attachments VALUES ($1, $2, 'image/png', 3, $3, $4, $5, 0)`,
      [`agents/vivid/${threadId}`, PICTURE.id, PICTURE.digest, ROOT, Buffer.from([1, 2, 3])],
    )
  yield* query(
    source,
    `INSERT INTO vivid_conversations (id, person_id, archived) VALUES ($1, $2, true), ($3, $4, false)`,
    [KEPT, ada, OTHER, grace],
  )
  return source
})

/**
 * Sol's second sequence: a partial reply with `stopReason: error`, Flue's interruption advisory,
 * and the settlement `failed`. Pi ids come from one sequence per store: the user entry is 10 and
 * its submission 11. The partial shows because it is the last thing written, as Flue showed it.
 */
const FAILED_STATE = {
  messages: [
    {
      id: 'entry-10',
      role: 'user',
      purpose: 'user',
      display: 'visible',
      submissionId: '11',
      timestamp: '2026-10-15T10:00:01.000Z',
      parts: [{ type: 'text', text: 'Hi', state: 'done' }],
    },
    {
      id: 'run-10',
      role: 'assistant',
      purpose: 'assistant',
      display: 'visible',
      submissionId: '11',
      timestamp: '2026-10-15T10:00:02.000Z',
      metadata: { startedAt: 1792058401000, finishedAt: 1792058404000 },
      parts: [{ type: 'text', text: 'Half', state: 'done' }],
    },
    {
      id: 'end-10',
      role: 'system',
      purpose: 'advisory',
      display: 'diagnostic',
      submissionId: '11',
      timestamp: '2026-10-15T10:00:04.000Z',
      settlement: { outcome: 'failed' },
      parts: [{ type: 'text', text: 'The reply was not finished.', state: 'done' }],
    },
  ],
  settlements: [{ submissionId: '11', outcome: 'failed' }],
  working: false,
  queued: 0,
}

/**
 * Sol's third sequence: B joined A's response at its tool boundary. One reply holds both model
 * steps with A's times; B is drawn after the reply it joined; both settlements name A (11) as
 * their answerer.
 */
const JOINED_STATE = {
  messages: [
    {
      id: 'entry-10',
      role: 'user',
      purpose: 'user',
      display: 'visible',
      submissionId: '11',
      timestamp: '2026-10-15T10:00:01.000Z',
      parts: [{ type: 'text', text: 'Look it up', state: 'done' }],
    },
    {
      id: 'run-10',
      role: 'assistant',
      purpose: 'assistant',
      display: 'visible',
      submissionId: '11',
      timestamp: '2026-10-15T10:00:02.000Z',
      metadata: { startedAt: 1792058401000, finishedAt: 1792058405500 },
      parts: [
        { type: 'text', text: 'Checking.', state: 'done' },
        {
          type: 'dynamic-tool',
          toolName: 'look',
          toolCallId: 'call_1',
          input: {},
          state: 'output-available',
          output: 'found',
        },
        { type: 'text', text: 'Final answer.', state: 'done' },
      ],
    },
    {
      id: 'entry-16',
      role: 'user',
      purpose: 'user',
      display: 'visible',
      submissionId: '17',
      timestamp: '2026-10-15T10:00:03.000Z',
      parts: [{ type: 'text', text: 'Also this', state: 'done' }],
    },
  ],
  settlements: [
    { submissionId: '11', outcome: 'completed', answeredBy: '11' },
    { submissionId: '17', outcome: 'completed', answeredBy: '11' },
  ],
  working: false,
  queued: 0,
}

/** Records as one batch holds them, decoded and folded as the sweep does. */
const foldedOf = (threadId: ThreadId, records: ReadonlyArray<Schema.JsonObject>) =>
  Result.getOrThrow(
    Result.flatMap(decodeRecords(JSON.stringify([BIRTH, ...records])), (decoded) =>
      fold(threadId, decoded, new Map()),
    ),
  )

/**
 * A model message with one text block, as Flue records it: start, block, words, the `extra`
 * blocks (a tool call), and the completion with the `end` fields (its stop reason).
 */
const said = (
  owner: Readonly<Record<string, Schema.Json>>,
  messageId: string,
  message: {
    readonly second: number
    readonly text: string
    readonly end: Readonly<Record<string, Schema.Json>>
    readonly extra: ReadonlyArray<Schema.JsonObject>
  },
) => {
  const { second, text, end, extra } = message
  return [
    record(`${messageId}_s`, 'assistant_message_started', second, {
      ...owner,
      messageId,
      parentId: null,
      modelInfo: MODEL,
    }),
    record(`${messageId}_t`, 'assistant_text_started', second, {
      ...owner,
      messageId,
      blockId: `${messageId}_b`,
      blockIndex: 0,
    }),
    record(`${messageId}_d`, 'assistant_text_delta', second, {
      ...owner,
      messageId,
      blockId: `${messageId}_b`,
      sequence: 0,
      delta: text,
    }),
    record(`${messageId}_tc`, 'assistant_text_completed', second, {
      ...owner,
      messageId,
      blockId: `${messageId}_b`,
      deltaCount: 1,
    }),
    ...extra,
    record(`${messageId}_c`, 'assistant_message_completed', second, {
      ...owner,
      messageId,
      usage: USAGE,
      ...end,
    }),
  ]
}

/** A Person's words as Flue records them for `owner`'s submission and attempt. */
const delivery = (
  owner: Readonly<Record<string, Schema.Json>>,
  messageId: string,
  second: number,
  text: string,
) =>
  record(`${messageId}_r`, 'user_message', second, {
    ...owner,
    messageId,
    parentId: null,
    content: [{ type: 'text', text }],
  })

const HOST_A = { submissionId: 'sub_A', attemptId: 'att_A1' }
const JOINED_B = { submissionId: 'sub_B', attemptId: 'att_A2' }
const JOINED_C = { submissionId: 'sub_C', attemptId: 'att_A2' }

/**
 * Sol's resumed cut: A ran a tool step under its first attempt and the process stopped. On the
 * resumed attempt B and C joined before any model message started there, so nothing in the log
 * names that attempt's host; the settlements that follow are cut before A's.
 */
const RESUMED_PREFIX = [
  delivery(HOST_A, 'u_A', 1, 'Look it up'),
  record('c_a_run', 'agent_start_run', 1, HOST_A),
  ...said(HOST_A, 'm_1', {
    second: 2,
    text: 'Checking.',
    end: { stopReason: 'toolUse' },
    extra: [
      record('m_1_call', 'assistant_tool_call', 2, {
        ...HOST_A,
        messageId: 'm_1',
        blockId: 'm_1_k',
        blockIndex: 1,
        toolCallId: 'call_1',
        name: 'look',
        arguments: {},
      }),
    ],
  }),
  record('c_out', 'tool_outcome', 2, {
    ...HOST_A,
    assistantMessageId: 'm_1',
    toolCallId: 'call_1',
    toolName: 'look',
    isError: false,
    content: [{ type: 'text', text: 'found' }],
  }),
  record('c_commit', 'tool_results_committed', 2, {
    ...HOST_A,
    assistantMessageId: 'm_1',
    outcomeIds: ['c_out'],
  }),
  delivery(JOINED_B, 'u_B', 3, 'Also this'),
  record('c_b_run', 'agent_start_run', 3, JOINED_B),
  delivery(JOINED_C, 'u_C', 3, 'And this'),
  record('c_c_run', 'agent_start_run', 3, JOINED_C),
]

/**
 * Sol’s first cut, carried: A shows as words with no submission, since it never settled; B stands
 * alone with its own failed settlement and its advisory, answered by nobody.
 */
const CUT_FIRST_STATE = {
  messages: [
    {
      id: 'entry-10',
      role: 'user',
      purpose: 'user',
      display: 'visible',
      timestamp: '2026-10-15T10:00:01.000Z',
      parts: [{ type: 'text', text: 'Look it up', state: 'done' }],
    },
    {
      id: 'entry-11',
      role: 'user',
      purpose: 'user',
      display: 'visible',
      submissionId: '12',
      timestamp: '2026-10-15T10:00:02.000Z',
      parts: [{ type: 'text', text: 'Also this', state: 'done' }],
    },
    {
      id: 'end-11',
      role: 'system',
      purpose: 'advisory',
      display: 'diagnostic',
      submissionId: '12',
      timestamp: '2026-10-15T10:00:03.000Z',
      settlement: { outcome: 'failed' },
      parts: [{ type: 'text', text: 'The reply was not finished.', state: 'done' }],
    },
  ],
  settlements: [{ submissionId: '12', outcome: 'failed' }],
  working: false,
  queued: 0,
}
/**
 * Sol’s second cut, carried: A’s unfinished step shows without a submission; B and C each stand
 * alone with the failed settlement their own records state, and neither names an answerer.
 */
const CUT_BOTH_STATE = {
  messages: [
    {
      id: 'entry-10',
      role: 'user',
      purpose: 'user',
      display: 'visible',
      timestamp: '2026-10-15T10:00:01.000Z',
      parts: [{ type: 'text', text: 'Look it up', state: 'done' }],
    },
    {
      id: 'run-10',
      role: 'assistant',
      purpose: 'assistant',
      display: 'visible',
      timestamp: '2026-10-15T10:00:02.000Z',
      parts: [
        { type: 'text', text: 'Checking.', state: 'done' },
        {
          type: 'dynamic-tool',
          toolName: 'look',
          toolCallId: 'call_1',
          input: {},
          state: 'output-available',
          output: 'found',
        },
      ],
    },
    {
      id: 'entry-13',
      role: 'user',
      purpose: 'user',
      display: 'visible',
      submissionId: '14',
      timestamp: '2026-10-15T10:00:03.000Z',
      parts: [{ type: 'text', text: 'Also this', state: 'done' }],
    },
    {
      id: 'end-13',
      role: 'system',
      purpose: 'advisory',
      display: 'diagnostic',
      submissionId: '14',
      timestamp: '2026-10-15T10:00:04.000Z',
      settlement: { outcome: 'failed' },
      parts: [{ type: 'text', text: 'The reply was not finished.', state: 'done' }],
    },
    {
      id: 'entry-15',
      role: 'user',
      purpose: 'user',
      display: 'visible',
      submissionId: '16',
      timestamp: '2026-10-15T10:00:03.000Z',
      parts: [{ type: 'text', text: 'And this', state: 'done' }],
    },
    {
      id: 'end-15',
      role: 'system',
      purpose: 'advisory',
      display: 'diagnostic',
      submissionId: '16',
      timestamp: '2026-10-15T10:00:04.000Z',
      settlement: { outcome: 'failed' },
      parts: [{ type: 'text', text: 'The reply was not finished.', state: 'done' }],
    },
  ],
  settlements: [
    { submissionId: '14', outcome: 'failed' },
    { submissionId: '16', outcome: 'failed' },
  ],
  working: false,
  queued: 0,
}
/**
 * Sol’s third cut, carried: as the second, but C never settled, so it shows as bare words and only
 * B’s own settlement is listed.
 */
const CUT_ONE_STATE = {
  messages: [
    {
      id: 'entry-10',
      role: 'user',
      purpose: 'user',
      display: 'visible',
      timestamp: '2026-10-15T10:00:01.000Z',
      parts: [{ type: 'text', text: 'Look it up', state: 'done' }],
    },
    {
      id: 'run-10',
      role: 'assistant',
      purpose: 'assistant',
      display: 'visible',
      timestamp: '2026-10-15T10:00:02.000Z',
      parts: [
        { type: 'text', text: 'Checking.', state: 'done' },
        {
          type: 'dynamic-tool',
          toolName: 'look',
          toolCallId: 'call_1',
          input: {},
          state: 'output-available',
          output: 'found',
        },
      ],
    },
    {
      id: 'entry-13',
      role: 'user',
      purpose: 'user',
      display: 'visible',
      submissionId: '14',
      timestamp: '2026-10-15T10:00:03.000Z',
      parts: [{ type: 'text', text: 'Also this', state: 'done' }],
    },
    {
      id: 'end-13',
      role: 'system',
      purpose: 'advisory',
      display: 'diagnostic',
      submissionId: '14',
      timestamp: '2026-10-15T10:00:04.000Z',
      settlement: { outcome: 'failed' },
      parts: [{ type: 'text', text: 'The reply was not finished.', state: 'done' }],
    },
    {
      id: 'entry-15',
      role: 'user',
      purpose: 'user',
      display: 'visible',
      timestamp: '2026-10-15T10:00:03.000Z',
      parts: [{ type: 'text', text: 'And this', state: 'done' }],
    },
  ],
  settlements: [{ submissionId: '14', outcome: 'failed' }],
  working: false,
  queued: 0,
}

const decodeCount = Schema.decodeUnknownEffect(Schema.Tuple([Schema.Struct({ n: Schema.Int })]))

/** The number of transcript entries in the whole runtime database. */
const entryCount = (database: string) =>
  query(database, 'SELECT count(*)::int AS n FROM runtime.entries').pipe(
    Effect.flatMap(decodeCount),
    Effect.map(([row]) => row.n),
  )

describe.skipIf(!databaseConfigured)('carrying Flue history into a Person’s store', () => {
  it.effect('writes the history in one commit and the screens read it as Flue showed it', () =>
    scenario((_given, runtime) =>
      Effect.gen(function* () {
        const threadId = ThreadId.make('thread-old')
        const empty = yield* entryCount(_given.database)
        const landed = yield* runtime.persons.use(ada, (person) =>
          carry(person.harness, history(threadId)),
        )
        expect(landed).toEqual(Landed.Carried({ entries: 10 }))
        // The commit settled its submissions; what a settlement sets off (`settled.ts`) finds the
        // response already written under its request id and writes nothing more.
        yield* untilResting(runtime, ada)
        expect(yield* entryCount(_given.database)).toBe(empty + 10)
        const state = yield* read(runtime, threadId)
        expect(state).toEqual({
          messages: [
            {
              id: 'entry-10',
              role: 'user',
              purpose: 'user',
              display: 'visible',
              submissionId: '11',
              timestamp: '2026-10-15T10:00:01.000Z',
              parts: [
                { type: 'text', text: 'List my Routines', state: 'done' },
                { type: 'file', mediaType: 'image/png', url: 'attachments/10-1' },
              ],
            },
            {
              id: 'run-10',
              role: 'assistant',
              purpose: 'assistant',
              display: 'visible',
              submissionId: '11',
              timestamp: '2026-10-15T10:00:02.000Z',
              metadata: { startedAt: 1792058401000, finishedAt: 1792058403300 },
              parts: [
                {
                  type: 'dynamic-tool',
                  toolName: 'list_routines',
                  toolCallId: 'call_1',
                  input: { limit: 5 },
                  state: 'output-available',
                  output: { ok: true },
                  durationMs: 12,
                },
                { type: 'text', text: 'Done', state: 'done' },
              ],
            },
            {
              id: 'entry-19',
              role: 'system',
              purpose: 'dispatch',
              display: 'diagnostic',
              submissionId: '20',
              timestamp: '2026-10-15T10:00:10.000Z',
              signal: { tagName: 'message', attributes: { from: 'Ada', turn: '2' } },
              parts: [{ type: 'text', text: 'Please check', state: 'done' }],
            },
            {
              id: 'run-19',
              role: 'assistant',
              purpose: 'assistant',
              display: 'visible',
              submissionId: '20',
              timestamp: '2026-10-15T10:00:11.000Z',
              metadata: { startedAt: 1792058410000, finishedAt: 1792058412000 },
              parts: [{ type: 'text', text: 'Checked.', state: 'done' }],
            },
          ],
          settlements: [
            { submissionId: '11', outcome: 'completed', answeredBy: '11' },
            { submissionId: '20', outcome: 'completed', answeredBy: '20' },
          ],
          working: false,
          queued: 0,
        })

        const before = yield* entryCount(_given.database)
        const again = yield* runtime.persons.use(ada, (person) =>
          carry(person.harness, history(threadId)),
        )
        expect(again).toEqual(Landed.AlreadyThere())
        expect(yield* entryCount(_given.database)).toEqual(before)
        expect(yield* read(runtime, threadId)).toEqual(state)
      }),
    ),
  )

  it.effect('shows a failed old reply with its advisory and its settlement', () =>
    scenario((_given, runtime) =>
      Effect.gen(function* () {
        const threadId = ThreadId.make('thread-failed')
        const owner = { submissionId: 'sub_F', attemptId: 'att_F' }
        const carried = foldedOf(threadId, [
          record('f_user', 'user_message', 1, {
            ...owner,
            messageId: 'u_F',
            parentId: null,
            content: [{ type: 'text', text: 'Hi' }],
          }),
          ...said(owner, 'm_F', {
            second: 2,
            text: 'Half',
            end: { stopReason: 'error', error: 'provider down' },
            extra: [],
          }),
          record('f_int', 'signal', 3, {
            ...owner,
            messageId: 's_F',
            parentId: 'm_F',
            signalType: 'submission_interrupted',
            content: 'The reply was not finished.',
            attributes: { submissionId: 'sub_F' },
          }),
          record('f_set', 'submission_settled', 4, { ...owner, outcome: 'failed' }),
        ])
        yield* runtime.persons.use(ada, (person) => carry(person.harness, carried))
        yield* untilResting(runtime, ada)
        expect(yield* read(runtime, threadId)).toEqual(FAILED_STATE)
      }),
    ),
  )

  it.effect('keeps a delivery that joined a reply inside that one reply', () =>
    scenario((_given, runtime) =>
      Effect.gen(function* () {
        const threadId = ThreadId.make('thread-joined')
        // B joins A's response at its tool boundary: B's own submission, A's attempt.
        const a = { submissionId: 'sub_A', attemptId: 'att_A' }
        const b = { submissionId: 'sub_B', attemptId: 'att_A' }
        const carried = foldedOf(threadId, [
          record('j_a', 'user_message', 1, {
            ...a,
            messageId: 'u_A',
            parentId: null,
            content: [{ type: 'text', text: 'Look it up' }],
          }),
          ...said(a, 'm_1', {
            second: 2,
            text: 'Checking.',
            end: { stopReason: 'toolUse' },
            extra: [
              record('m_1_call', 'assistant_tool_call', 2, {
                ...a,
                messageId: 'm_1',
                blockId: 'm_1_k',
                blockIndex: 1,
                toolCallId: 'call_1',
                name: 'look',
                arguments: {},
              }),
            ],
          }),
          record('j_out', 'tool_outcome', 2, {
            ...a,
            assistantMessageId: 'm_1',
            toolCallId: 'call_1',
            toolName: 'look',
            isError: false,
            content: [{ type: 'text', text: 'found' }],
          }),
          record('j_commit', 'tool_results_committed', 2, {
            ...a,
            assistantMessageId: 'm_1',
            outcomeIds: ['j_out'],
          }),
          record('j_b', 'user_message', 3, {
            ...b,
            messageId: 'u_B',
            parentId: 'tool',
            content: [{ type: 'text', text: 'Also this' }],
          }),
          ...said(a, 'm_2', {
            second: 4,
            text: 'Final answer.',
            end: { stopReason: 'stop' },
            extra: [],
          }),
          record('j_meta', 'message_metadata', 5, {
            ...a,
            metadata: { finishedAt: 1792058405500, toolCallCount: 1 },
          }),
          // Flue settles the joined delivery first, under the host's attempt.
          record('j_set_b', 'submission_settled', 6, { ...b, outcome: 'completed' }),
          record('j_set_a', 'submission_settled', 6, { ...a, outcome: 'completed' }),
        ])
        yield* runtime.persons.use(ada, (person) => carry(person.harness, carried))
        yield* untilResting(runtime, ada)
        expect(yield* read(runtime, threadId)).toEqual(JOINED_STATE)
      }),
    ),
  )

  it.effect('keeps a delivery that joined a resumed reply inside that one reply', () =>
    scenario((_given, runtime) =>
      Effect.gen(function* () {
        const threadId = ThreadId.make('thread-resumed')
        // A ran its tool step under its first attempt and the process stopped there. On the resumed
        // attempt B joins first: B's delivery and start marker are that attempt's first records,
        // and only the next model message names A, the attempt's host.
        const a = { submissionId: 'sub_A', attemptId: 'att_A1' }
        const resumed = { submissionId: 'sub_A', attemptId: 'att_A2' }
        const b = { submissionId: 'sub_B', attemptId: 'att_A2' }
        const carried = foldedOf(threadId, [
          record('r_a', 'user_message', 1, {
            ...a,
            messageId: 'u_A',
            parentId: null,
            content: [{ type: 'text', text: 'Look it up' }],
          }),
          record('r_a_run', 'agent_start_run', 1, a),
          ...said(a, 'm_1', {
            second: 2,
            text: 'Checking.',
            end: { stopReason: 'toolUse' },
            extra: [
              record('m_1_call', 'assistant_tool_call', 2, {
                ...a,
                messageId: 'm_1',
                blockId: 'm_1_k',
                blockIndex: 1,
                toolCallId: 'call_1',
                name: 'look',
                arguments: {},
              }),
            ],
          }),
          record('r_out', 'tool_outcome', 2, {
            ...a,
            assistantMessageId: 'm_1',
            toolCallId: 'call_1',
            toolName: 'look',
            isError: false,
            content: [{ type: 'text', text: 'found' }],
          }),
          record('r_commit', 'tool_results_committed', 2, {
            ...a,
            assistantMessageId: 'm_1',
            outcomeIds: ['r_out'],
          }),
          record('r_b', 'user_message', 3, {
            ...b,
            messageId: 'u_B',
            parentId: 'tool',
            content: [{ type: 'text', text: 'Also this' }],
          }),
          record('r_b_run', 'agent_start_run', 3, b),
          ...said(resumed, 'm_2', {
            second: 4,
            text: 'Final answer.',
            end: { stopReason: 'stop' },
            extra: [],
          }),
          record('r_meta', 'message_metadata', 5, {
            ...resumed,
            metadata: { finishedAt: 1792058405500, toolCallCount: 1 },
          }),
          record('r_set_b', 'submission_settled', 6, { ...b, outcome: 'completed' }),
          record('r_set_a', 'submission_settled', 6, { ...resumed, outcome: 'completed' }),
        ])
        yield* runtime.persons.use(ada, (person) => carry(person.harness, carried))
        yield* untilResting(runtime, ada)
        // One reply with A's times holding both steps, both deliveries, B answered by A.
        expect(yield* read(runtime, threadId)).toEqual(JOINED_STATE)
      }),
    ),
  )

  it.effect('carries a first attempt cut between a joined and the host settlement', () =>
    scenario((_given, runtime) =>
      Effect.gen(function* () {
        const threadId = ThreadId.make('thread-cut-first')
        // A and B were placed under A's first attempt, which failed before a model message
        // started; the log ends after B's settlement, before A's. No record names the host.
        const a = { submissionId: 'sub_A', attemptId: 'att_A1' }
        const b = { submissionId: 'sub_B', attemptId: 'att_A1' }
        const carried = foldedOf(threadId, [
          delivery(a, 'u_A', 1, 'Look it up'),
          record('c_a_run', 'agent_start_run', 1, a),
          delivery(b, 'u_B', 2, 'Also this'),
          record('c_b_run', 'agent_start_run', 2, b),
          record('c_set_b', 'submission_settled', 3, { ...b, outcome: 'failed' }),
        ])
        yield* runtime.persons.use(ada, (person) => carry(person.harness, carried))
        yield* untilResting(runtime, ada)
        expect(yield* read(runtime, threadId)).toEqual(CUT_FIRST_STATE)
      }),
    ),
  )

  it.effect('carries a resumed attempt cut after both joined settlements', () =>
    scenario((_given, runtime) =>
      Effect.gen(function* () {
        const threadId = ThreadId.make('thread-cut-both')
        const carried = foldedOf(threadId, [
          ...RESUMED_PREFIX,
          record('c_set_b', 'submission_settled', 4, { ...JOINED_B, outcome: 'failed' }),
          record('c_set_c', 'submission_settled', 4, { ...JOINED_C, outcome: 'failed' }),
        ])
        yield* runtime.persons.use(ada, (person) => carry(person.harness, carried))
        yield* untilResting(runtime, ada)
        expect(yield* read(runtime, threadId)).toEqual(CUT_BOTH_STATE)
      }),
    ),
  )

  it.effect('carries a resumed attempt cut after one joined settlement', () =>
    scenario((_given, runtime) =>
      Effect.gen(function* () {
        const threadId = ThreadId.make('thread-cut-one')
        const carried = foldedOf(threadId, [
          ...RESUMED_PREFIX,
          record('c_set_b', 'submission_settled', 4, { ...JOINED_B, outcome: 'failed' }),
        ])
        yield* runtime.persons.use(ada, (person) => carry(person.harness, carried))
        yield* untilResting(runtime, ada)
        expect(yield* read(runtime, threadId)).toEqual(CUT_ONE_STATE)
      }),
    ),
  )

  it.effect('leaves nothing for the next process to resume or answer', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const given = yield* world()
        const threadId = ThreadId.make('thread-inert')
        const first = yield* Scope.make()
        const before = yield* start(given, { idleMillis: IDLE }).pipe(Scope.provide(first))
        yield* before.persons.use(ada, (person) => carry(person.harness, history(threadId)))
        yield* untilResting(before, ada)
        const state = yield* read(before, threadId)
        const written = yield* entryCount(given.database)
        yield* Scope.close(first, Exit.void)

        // The next process resumes every store with unfinished work (`persons.ts`); this one is
        // resumed by hand as well, and still has no task and no unsettled submission to run.
        const after = yield* start(given, { idleMillis: IDLE })
        const work = yield* after.persons.use(ada, (person) =>
          Effect.promise(() => {
            person.harness.resume()
            return person.harness.inspect(BACKGROUND_CONTEXT)
          }),
        )
        expect(work.tasks).toEqual([])
        expect(work.submissions).toEqual([])
        expect(
          yield* query(
            given.database,
            `SELECT count(*)::int AS n FROM runtime.submissions WHERE status IN ('queued', 'placed')`,
          ),
        ).toEqual([{ n: 0 }])
        expect(given.faux.state.callCount).toBe(0)
        expect(yield* read(after, threadId)).toEqual(state)
        expect(yield* entryCount(given.database)).toEqual(written)
      }),
    ),
  )

  it.effect('carries only Threads the product still has, under the creator it records', () =>
    scenario((_given, runtime) =>
      Effect.gen(function* () {
        const source = yield* sourceDatabase()
        const reading = yield* Layer.build(
          flueSourceLayer.pipe(
            Layer.provide(
              ConfigProvider.layer(ConfigProvider.fromUnknown({ VIVID_FLUE_DATABASE_URL: source })),
            ),
          ),
        )
        const lines: Array<Report> = []
        const pass = sweep(
          (personId, carried) =>
            runtime.persons.use(personId, (person) => carry(person.harness, carried)),
          (line) => Effect.sync(() => lines.push(line)),
        ).pipe(Effect.provide(reading))

        expect(yield* pass).toEqual({ carried: 1, already: 0, skipped: 1, failed: 1 })
        expect(lines).toEqual([
          { outcome: 'carried', threadId: KEPT, personId: ada, entries: 4 },
          { outcome: 'skipped', threadId: GONE, entries: 0, reason: 'no product Thread' },
          {
            outcome: 'failed',
            threadId: OTHER,
            personId: grace,
            entries: 0,
            reason: `CreatorMismatch: Thread ${OTHER} was started by ${ada} in Flue and belongs to ${grace} in the product`,
          },
        ])
        const state = yield* read(runtime, KEPT)
        expect(state.messages.map((message) => [message.role, message.parts])).toEqual([
          [
            'user',
            [
              { type: 'text', text: 'Look', state: 'done' },
              {
                type: 'file',
                mediaType: 'image/png',
                url: expect.stringMatching(/^attachments\/\d+-1$/),
              },
            ],
          ],
          ['assistant', [{ type: 'text', text: 'A cat.', state: 'done' }]],
        ])

        // The cutover runs it again: what is there stays, the rest is reported the same way.
        lines.length = 0
        expect(yield* pass).toEqual({ carried: 0, already: 1, skipped: 1, failed: 1 })
        expect(lines.map((line) => [line.threadId, line.outcome])).toEqual([
          [KEPT, 'already'],
          [GONE, 'skipped'],
          [OTHER, 'failed'],
        ])
      }),
    ),
  )
})
