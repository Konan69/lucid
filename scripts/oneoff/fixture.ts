import { PersonId } from '../../packages/contracts/src/index.ts'
import type { Schema } from 'effect'
const ada = PersonId.make('earlier-person')
const USAGE = {
  input: 10,
  output: 5,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 15,
  cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, total: 3 },
}
const MODEL = { api: 'openai-completions', provider: 'example', model: 'example' } as const

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
]
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

export { SOURCE_TABLES, BIRTH, REPLY_BATCHES, PICTURE, ROOT, ada }
