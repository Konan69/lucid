import { describe, expect, it } from '@effect/vitest'
import { PersonId, ThreadId } from '@vivid/contracts'
import { Option, Result, type Schema } from 'effect'
import {
  AnswerMissing,
  AttachmentMismatch,
  AttachmentMissing,
  DeltaGap,
  fold,
  Item,
  RecoveryPairUnsupported,
  StreamStartMissing,
  ToolBatchUnderStop,
  type Attachments,
} from './fold.ts'
import { decodeRecords, RecordUnknown } from './records.ts'

const THREAD = ThreadId.make('11111111-1111-4111-8111-111111111111')
const ROOT = 'conv_DEMO'
const ORIGIN = { creator: PersonId.make('person_DEMO'), creatorName: 'Ada' }

/** Flue's record envelope for the root conversation; ids are the test's own, in log order. */
const record = (
  id: string,
  type: string,
  timestamp: string,
  fields: Readonly<Record<string, Schema.Json>>,
) => ({
  v: 1,
  id,
  type,
  conversationId: ROOT,
  harness: 'default',
  session: 'default',
  timestamp,
  ...fields,
})

const BIRTH = record('record_birth', 'conversation_created', '2026-10-15T10:00:00.000Z', {
  createdAt: '2026-10-15T10:00:00.000Z',
  kind: 'root',
  affinityKey: 'aff_DEMO',
  uid: 'inst_DEMO',
  initialData: { creator: 'person_DEMO', creatorName: 'Ada' },
})

const MODEL_INFO = { api: 'openai-completions', provider: 'example', model: 'example' }
const USAGE = {
  input: 10,
  output: 5,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 15,
  cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, total: 3 },
}

/** The records as they sit in the batches: one batch, decoded at ingress, then folded. */
const folded = (records: ReadonlyArray<Schema.JsonObject>, files: Attachments = new Map()) =>
  Result.flatMap(decodeRecords(JSON.stringify(records)), (decoded) => fold(THREAD, decoded, files))

/** A user message, its single-text reply and its settlement, under one submission. */
const userSays = (sub: string, id: string, at: string, text: string) =>
  record(id, 'user_message', at, {
    submissionId: sub,
    messageId: `entry_${id}`,
    parentId: null,
    content: [{ type: 'text', text }],
  })

/** Fields of a record written for `sub` under attempt `attempt`. */
const at = (sub: string, attempt: string, fields: Readonly<Record<string, Schema.Json>>) => ({
  submissionId: sub,
  attemptId: attempt,
  ...fields,
})

/**
 * A's first attempt ran a tool step, then the process stopped. On the resumed attempt B and C
 * joined before any model message started there: their deliveries and start markers are its
 * only records.
 */
const resumedPrefix = [
  record('r_a', 'user_message', '2026-10-15T10:00:01.000Z', {
    ...at('sub_A', 'att_1', { messageId: 'u_A', parentId: null }),
    content: [{ type: 'text', text: 'A' }],
  }),
  record('r_s1', 'assistant_message_started', '2026-10-15T10:00:02.000Z', {
    ...at('sub_A', 'att_1', { messageId: 'm_1', parentId: 'u_A' }),
    modelInfo: MODEL_INFO,
    responseMetadata: { startedAt: 1792058402000 },
  }),
  record('r_call', 'assistant_tool_call', '2026-10-15T10:00:02.100Z', {
    ...at('sub_A', 'att_1', { messageId: 'm_1', blockId: 'b_c', blockIndex: 0 }),
    toolCallId: 'call_1',
    name: 'look',
    arguments: {},
  }),
  record('r_c1', 'assistant_message_completed', '2026-10-15T10:00:02.200Z', {
    ...at('sub_A', 'att_1', { messageId: 'm_1' }),
    stopReason: 'toolUse',
    usage: USAGE,
  }),
  record('r_out', 'tool_outcome', '2026-10-15T10:00:02.300Z', {
    ...at('sub_A', 'att_1', { assistantMessageId: 'm_1', toolCallId: 'call_1' }),
    toolName: 'look',
    isError: false,
    content: [{ type: 'text', text: 'seen' }],
  }),
  record('r_commit', 'tool_results_committed', '2026-10-15T10:00:02.400Z', {
    ...at('sub_A', 'att_1', { assistantMessageId: 'm_1' }),
    outcomeIds: ['r_out'],
  }),
  record('r_b', 'user_message', '2026-10-15T10:00:03.000Z', {
    ...at('sub_B', 'att_2', { messageId: 'u_B', parentId: 'm_1' }),
    content: [{ type: 'text', text: 'B' }],
  }),
  record('r_b_run', 'agent_start_run', '2026-10-15T10:00:03.000Z', at('sub_B', 'att_2', {})),
  record('r_c', 'user_message', '2026-10-15T10:00:03.000Z', {
    ...at('sub_C', 'att_2', { messageId: 'u_C', parentId: 'u_B' }),
    content: [{ type: 'text', text: 'C' }],
  }),
  record('r_c_run', 'agent_start_run', '2026-10-15T10:00:03.000Z', at('sub_C', 'att_2', {})),
]

/** A's tool step from `resumedPrefix`, without its run record while A has not settled. */
const stepOfA = [
  Item.Replied({
    message: {
      role: 'assistant',
      content: [{ type: 'toolCall', id: 'call_1', name: 'look', arguments: {} }],
      ...MODEL_INFO,
      usage: USAGE,
      stopReason: 'toolUse',
      timestamp: 1792058402000,
    },
  }),
  Item.Answered({
    message: {
      role: 'toolResult',
      toolCallId: 'call_1',
      toolName: 'look',
      content: [{ type: 'text', text: 'seen' }],
      isError: false,
      timestamp: 1792058402300,
    },
  }),
]

/**
 * The response of a delivery that stands alone and failed before a model message: its own
 * submission only, its own outcome, and nothing measured but its delivery and settlement times.
 */
const alone = (submission: string, deliveredAt: number, settledAt: number) =>
  Item.Responded({
    data: {
      outcome: 'failed',
      startedAt: deliveredAt,
      finishedAt: settledAt,
      toolCallCount: 0,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 },
    },
    inputs: [{ submission, outcome: 'failed' }],
  })

describe('folding a Flue stream', () => {
  it('carries a plain reply with main’s response times', () => {
    const records = [
      BIRTH,
      userSays('sub_1', 'r_user', '2026-10-15T10:00:01.000Z', 'Hi'),
      record('r_run', 'agent_start_run', '2026-10-15T10:00:01.500Z', { submissionId: 'sub_1' }),
      record('r_res', 'resource_snapshot', '2026-10-15T10:00:01.600Z', {
        submissionId: 'sub_1',
        baseline: true,
        snapshot: {},
      }),
      record('r_start', 'assistant_message_started', '2026-10-15T10:00:02.000Z', {
        submissionId: 'sub_1',
        messageId: 'm_1',
        parentId: 'entry_r_user',
        modelInfo: MODEL_INFO,
        responseMetadata: { model: 'example/example', startedAt: 1792058402000 },
      }),
      record('r_block', 'assistant_text_started', '2026-10-15T10:00:02.000Z', {
        submissionId: 'sub_1',
        messageId: 'm_1',
        blockId: 'b_1',
        blockIndex: 0,
      }),
      record('r_d0', 'assistant_text_delta', '2026-10-15T10:00:02.100Z', {
        submissionId: 'sub_1',
        messageId: 'm_1',
        blockId: 'b_1',
        sequence: 0,
        delta: 'Hel',
      }),
      record('r_d1', 'assistant_text_delta', '2026-10-15T10:00:02.200Z', {
        submissionId: 'sub_1',
        messageId: 'm_1',
        blockId: 'b_1',
        sequence: 1,
        delta: 'lo',
      }),
      record('r_bdone', 'assistant_text_completed', '2026-10-15T10:00:02.300Z', {
        submissionId: 'sub_1',
        messageId: 'm_1',
        blockId: 'b_1',
        deltaCount: 2,
      }),
      record('r_done', 'assistant_message_completed', '2026-10-15T10:00:02.300Z', {
        submissionId: 'sub_1',
        messageId: 'm_1',
        stopReason: 'stop',
        usage: USAGE,
      }),
      record('r_meta', 'message_metadata', '2026-10-15T10:00:02.350Z', {
        submissionId: 'sub_1',
        metadata: { finishedAt: 1792058403000, toolCallCount: 0, usage: USAGE },
      }),
      record('r_settled', 'submission_settled', '2026-10-15T10:00:02.400Z', {
        submissionId: 'sub_1',
        outcome: 'completed',
      }),
    ]
    expect(Result.getOrThrow(folded(records))).toEqual({
      threadId: THREAD,
      origin: ORIGIN,
      items: [
        Item.Said({
          message: { role: 'user', content: 'Hi', timestamp: 1792058401000 },
          submission: Option.some('sub_1'),
        }),
        Item.Ran({ inputs: ['sub_1'] }),
        Item.Replied({
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'Hello' }],
            api: 'openai-completions',
            provider: 'example',
            model: 'example',
            usage: USAGE,
            stopReason: 'stop',
            timestamp: 1792058402000,
          },
        }),
        Item.Responded({
          data: {
            outcome: 'completed',
            startedAt: 1792058402000,
            finishedAt: 1792058403000,
            toolCallCount: 0,
            usage: {
              input: 10,
              output: 5,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 15,
              cost: 3,
            },
            model: 'example/example',
          },
          inputs: [{ submission: 'sub_1', outcome: 'completed' }],
        }),
      ],
    })
  })

  it('carries a tool call, its committed structured result and a second step of the same reply', () => {
    const records = [
      BIRTH,
      userSays('sub_1', 'r_user', '2026-10-15T10:00:01.000Z', 'List my Routines'),
      record('r_s1', 'assistant_message_started', '2026-10-15T10:00:02.000Z', {
        submissionId: 'sub_1',
        messageId: 'm_1',
        parentId: 'entry_r_user',
        modelInfo: MODEL_INFO,
      }),
      record('r_call', 'assistant_tool_call', '2026-10-15T10:00:02.100Z', {
        submissionId: 'sub_1',
        messageId: 'm_1',
        blockId: 'b_call',
        blockIndex: 0,
        toolCallId: 'call_1',
        name: 'list_routines',
        arguments: { limit: 5 },
      }),
      record('r_c1', 'assistant_message_completed', '2026-10-15T10:00:02.200Z', {
        submissionId: 'sub_1',
        messageId: 'm_1',
        stopReason: 'toolUse',
        usage: USAGE,
      }),
      record('r_out', 'tool_outcome', '2026-10-15T10:00:02.500Z', {
        submissionId: 'sub_1',
        assistantMessageId: 'm_1',
        toolCallId: 'call_1',
        toolName: 'list_routines',
        isError: false,
        content: [{ type: 'text', text: '{"ok":true}' }],
        output: { ok: true },
        durationMs: 12,
      }),
      record('r_commit', 'tool_results_committed', '2026-10-15T10:00:02.600Z', {
        submissionId: 'sub_1',
        assistantMessageId: 'm_1',
        parentId: 'm_1',
        outcomeIds: ['r_out'],
      }),
      record('r_s2', 'assistant_message_started', '2026-10-15T10:00:03.000Z', {
        submissionId: 'sub_1',
        messageId: 'm_2',
        parentId: 'tool_m_1_call_1',
        modelInfo: MODEL_INFO,
      }),
      record('r_t2', 'assistant_text_started', '2026-10-15T10:00:03.000Z', {
        submissionId: 'sub_1',
        messageId: 'm_2',
        blockId: 'b_2',
        blockIndex: 0,
      }),
      record('r_t2d', 'assistant_text_delta', '2026-10-15T10:00:03.100Z', {
        submissionId: 'sub_1',
        messageId: 'm_2',
        blockId: 'b_2',
        sequence: 0,
        delta: 'Done',
      }),
      record('r_t2c', 'assistant_text_completed', '2026-10-15T10:00:03.200Z', {
        submissionId: 'sub_1',
        messageId: 'm_2',
        blockId: 'b_2',
        deltaCount: 1,
      }),
      record('r_c2', 'assistant_message_completed', '2026-10-15T10:00:03.200Z', {
        submissionId: 'sub_1',
        messageId: 'm_2',
        stopReason: 'stop',
        usage: USAGE,
      }),
      record('r_settled', 'submission_settled', '2026-10-15T10:00:03.300Z', {
        submissionId: 'sub_1',
        outcome: 'completed',
      }),
    ]
    expect(Result.getOrThrow(folded(records)).items).toEqual([
      Item.Said({
        message: { role: 'user', content: 'List my Routines', timestamp: 1792058401000 },
        submission: Option.some('sub_1'),
      }),
      Item.Ran({ inputs: ['sub_1'] }),
      Item.Replied({
        message: {
          role: 'assistant',
          content: [
            { type: 'toolCall', id: 'call_1', name: 'list_routines', arguments: { limit: 5 } },
          ],
          api: 'openai-completions',
          provider: 'example',
          model: 'example',
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
      Item.Replied({
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Done' }],
          api: 'openai-completions',
          provider: 'example',
          model: 'example',
          usage: USAGE,
          stopReason: 'stop',
          timestamp: 1792058403000,
        },
      }),
      // No main metadata: started when the message was placed, finished when it settled, and
      // the calls counted from the results Flue committed.
      Item.Responded({
        data: {
          outcome: 'completed',
          startedAt: 1792058401000,
          finishedAt: 1792058403300,
          toolCallCount: 1,
          usage: {
            input: 20,
            output: 10,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 30,
            cost: 6,
          },
          model: 'example/example',
        },
        inputs: [{ submission: 'sub_1', outcome: 'completed' }],
      }),
    ])
  })

  it('keeps thinking with its signature and words with theirs, by block place', () => {
    const records = [
      BIRTH,
      userSays('sub_1', 'r_user', '2026-10-15T10:00:01.000Z', 'Why?'),
      record('r_s', 'assistant_message_started', '2026-10-15T10:00:02.000Z', {
        submissionId: 'sub_1',
        messageId: 'm_1',
        parentId: 'entry_r_user',
        modelInfo: MODEL_INFO,
      }),
      // The words open at place 1 before the thinking at place 0; the message keeps place order.
      record('r_t', 'assistant_text_started', '2026-10-15T10:00:02.000Z', {
        submissionId: 'sub_1',
        messageId: 'm_1',
        blockId: 'b_text',
        blockIndex: 1,
      }),
      record('r_r', 'assistant_reasoning_started', '2026-10-15T10:00:02.000Z', {
        submissionId: 'sub_1',
        messageId: 'm_1',
        blockId: 'b_think',
        blockIndex: 0,
      }),
      record('r_rd', 'assistant_reasoning_delta', '2026-10-15T10:00:02.100Z', {
        submissionId: 'sub_1',
        messageId: 'm_1',
        blockId: 'b_think',
        sequence: 0,
        delta: 'Because',
      }),
      record('r_rc', 'assistant_reasoning_completed', '2026-10-15T10:00:02.200Z', {
        submissionId: 'sub_1',
        messageId: 'm_1',
        blockId: 'b_think',
        deltaCount: 1,
        encrypted: 'opaque-signature',
      }),
      record('r_td', 'assistant_text_delta', '2026-10-15T10:00:02.300Z', {
        submissionId: 'sub_1',
        messageId: 'm_1',
        blockId: 'b_text',
        sequence: 0,
        delta: 'It is so.',
      }),
      record('r_tc', 'assistant_text_completed', '2026-10-15T10:00:02.400Z', {
        submissionId: 'sub_1',
        messageId: 'm_1',
        blockId: 'b_text',
        deltaCount: 1,
        textSignature: 'text-signature',
      }),
      record('r_c', 'assistant_message_completed', '2026-10-15T10:00:02.400Z', {
        submissionId: 'sub_1',
        messageId: 'm_1',
        stopReason: 'stop',
        usage: USAGE,
      }),
    ]
    expect(Result.getOrThrow(folded(records)).items[1]).toEqual(
      Item.Replied({
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'Because', thinkingSignature: 'opaque-signature' },
            { type: 'text', text: 'It is so.', textSignature: 'text-signature' },
          ],
          api: 'openai-completions',
          provider: 'example',
          model: 'example',
          usage: USAGE,
          stopReason: 'stop',
          timestamp: 1792058402000,
        },
      }),
    )
  })

  it('carries an application signal as the runtime places one and skips Flue’s plumbing', () => {
    const records = [
      BIRTH,
      record('r_env', 'signal', '2026-10-15T10:00:00.500Z', {
        messageId: 'entry_env',
        parentId: null,
        signalType: 'environment',
        content: 'Working directory: /',
      }),
      record('r_sig', 'signal', '2026-10-15T10:00:01.000Z', {
        submissionId: 'sub_1',
        messageId: 'entry_sig',
        parentId: 'entry_env',
        signalType: 'message',
        tagName: 'message',
        content: 'Please check <this> & that',
        attributes: { from: 'Ada', turn: '2' },
      }),
      record('r_abort', 'signal', '2026-10-15T10:00:02.000Z', {
        messageId: 'entry_abort',
        parentId: 'entry_sig',
        signalType: 'submission_aborted',
        content: 'The reply was stopped.',
        attributes: { submissionId: 'sub_1' },
      }),
      record('r_settled', 'submission_settled', '2026-10-15T10:00:02.100Z', {
        submissionId: 'sub_1',
        outcome: 'aborted',
      }),
    ]
    expect(Result.getOrThrow(folded(records)).items).toEqual([
      Item.Signalled({
        data: {
          type: 'message',
          attributes: { from: 'Ada', turn: '2' },
          body: 'Please check <this> & that',
        },
        message: {
          role: 'user',
          content:
            '<message type="message" from="Ada" turn="2">\nPlease check &lt;this&gt; &amp; that\n</message>',
          timestamp: 1792058401000,
        },
        submission: Option.some('sub_1'),
      }),
      Item.Responded({
        data: {
          outcome: 'aborted',
          startedAt: 1792058401000,
          finishedAt: 1792058402100,
          toolCallCount: 0,
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 },
        },
        inputs: [{ submission: 'sub_1', outcome: 'aborted' }],
      }),
    ])
  })

  it('drops a reply a failed submission never completed and records the failure', () => {
    const records = [
      BIRTH,
      userSays('sub_1', 'r_user', '2026-10-15T10:00:01.000Z', 'Hi'),
      record('r_s', 'assistant_message_started', '2026-10-15T10:00:02.000Z', {
        submissionId: 'sub_1',
        messageId: 'm_1',
        parentId: 'entry_r_user',
        modelInfo: MODEL_INFO,
      }),
      record('r_t', 'assistant_text_started', '2026-10-15T10:00:02.000Z', {
        submissionId: 'sub_1',
        messageId: 'm_1',
        blockId: 'b_1',
        blockIndex: 0,
      }),
      record('r_d', 'assistant_text_delta', '2026-10-15T10:00:02.100Z', {
        submissionId: 'sub_1',
        messageId: 'm_1',
        blockId: 'b_1',
        sequence: 0,
        delta: 'Half a',
      }),
      record('r_settled', 'submission_settled', '2026-10-15T10:00:05.000Z', {
        submissionId: 'sub_1',
        outcome: 'failed',
        error: { message: 'provider down' },
      }),
    ]
    expect(Result.getOrThrow(folded(records)).items).toEqual([
      Item.Said({
        message: { role: 'user', content: 'Hi', timestamp: 1792058401000 },
        submission: Option.some('sub_1'),
      }),
      Item.Responded({
        data: {
          outcome: 'failed',
          startedAt: 1792058401000,
          finishedAt: 1792058405000,
          toolCallCount: 0,
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 },
        },
        inputs: [{ submission: 'sub_1', outcome: 'failed' }],
      }),
    ])
  })

  it('drops a tool outcome no commit named', () => {
    const records = [
      BIRTH,
      userSays('sub_1', 'r_user', '2026-10-15T10:00:01.000Z', 'Go'),
      record('r_s', 'assistant_message_started', '2026-10-15T10:00:02.000Z', {
        submissionId: 'sub_1',
        messageId: 'm_1',
        parentId: 'entry_r_user',
        modelInfo: MODEL_INFO,
      }),
      record('r_call', 'assistant_tool_call', '2026-10-15T10:00:02.100Z', {
        submissionId: 'sub_1',
        messageId: 'm_1',
        blockId: 'b_call',
        blockIndex: 0,
        toolCallId: 'call_1',
        name: 'run_code',
        arguments: {},
      }),
      record('r_c', 'assistant_message_completed', '2026-10-15T10:00:02.200Z', {
        submissionId: 'sub_1',
        messageId: 'm_1',
        stopReason: 'toolUse',
        usage: USAGE,
      }),
      record('r_out', 'tool_outcome', '2026-10-15T10:00:03.000Z', {
        submissionId: 'sub_1',
        assistantMessageId: 'm_1',
        toolCallId: 'call_1',
        toolName: 'run_code',
        isError: true,
        content: [{ type: 'text', text: 'stopped' }],
      }),
      record('r_settled', 'submission_settled', '2026-10-15T10:00:03.500Z', {
        submissionId: 'sub_1',
        outcome: 'aborted',
      }),
    ]
    expect(Result.getOrThrow(folded(records)).items.map((item) => item._tag)).toEqual([
      'Said',
      'Ran',
      'Replied',
      'Responded',
    ])
  })

  it('resolves a picture a Person sent from the kept file', () => {
    const bytes = Uint8Array.from([1, 2, 3])
    const reference = {
      id: 'att_user_sub_1_0',
      mimeType: 'image/png',
      size: 3,
      digest: '039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81',
      filename: 'photo.png',
    }
    const records = [
      BIRTH,
      record('r_user', 'user_message', '2026-10-15T10:00:01.000Z', {
        submissionId: 'sub_1',
        messageId: 'entry_user',
        parentId: null,
        content: [
          { type: 'text', text: 'Look' },
          { type: 'attachment', attachment: reference },
        ],
      }),
    ]
    const files = new Map([[reference.id, { mimeType: 'image/png', bytes }]])
    expect(Result.getOrThrow(folded(records, files)).items).toEqual([
      Item.Said({
        message: {
          role: 'user',
          content: [
            { type: 'text', text: 'Look' },
            { type: 'image', data: 'AQID', mimeType: 'image/png' },
          ],
          timestamp: 1792058401000,
        },
        // Its submission never settled, so it names none and no run waits on it.
        submission: Option.none(),
      }),
    ])
    expect(Result.getOrThrow(Result.flip(folded(records)))).toEqual(
      new AttachmentMissing({ attachmentId: reference.id }),
    )
    const altered = new Map([
      [reference.id, { mimeType: 'image/png', bytes: Uint8Array.from([1, 2, 4]) }],
    ])
    expect(Result.getOrThrow(Result.flip(folded(records, altered)))).toEqual(
      new AttachmentMismatch({ attachmentId: reference.id, check: 'digest' }),
    )
  })

  it('groups a delivery that joined a running reply with that reply', () => {
    const under = (sub: string, fields: Readonly<Record<string, Schema.Json>>) => ({
      submissionId: sub,
      attemptId: 'att_A',
      ...fields,
    })
    const records = [
      BIRTH,
      record('r_a', 'user_message', '2026-10-15T10:00:01.000Z', {
        ...under('sub_A', { messageId: 'u_A', parentId: null }),
        content: [{ type: 'text', text: 'A' }],
      }),
      record('r_s1', 'assistant_message_started', '2026-10-15T10:00:02.000Z', {
        ...under('sub_A', { messageId: 'm_1', parentId: 'u_A' }),
        modelInfo: MODEL_INFO,
        responseMetadata: { startedAt: 1792058402000 },
      }),
      record('r_call', 'assistant_tool_call', '2026-10-15T10:00:02.100Z', {
        ...under('sub_A', { messageId: 'm_1', blockId: 'b_c', blockIndex: 0 }),
        toolCallId: 'call_1',
        name: 'look',
        arguments: {},
      }),
      record('r_c1', 'assistant_message_completed', '2026-10-15T10:00:02.200Z', {
        ...under('sub_A', { messageId: 'm_1' }),
        stopReason: 'toolUse',
        usage: USAGE,
      }),
      record('r_out', 'tool_outcome', '2026-10-15T10:00:02.300Z', {
        ...under('sub_A', { assistantMessageId: 'm_1', toolCallId: 'call_1' }),
        toolName: 'look',
        isError: false,
        content: [{ type: 'text', text: 'seen' }],
      }),
      record('r_commit', 'tool_results_committed', '2026-10-15T10:00:02.400Z', {
        ...under('sub_A', { assistantMessageId: 'm_1' }),
        outcomeIds: ['r_out'],
      }),
      // B joins at the tool boundary: its own submission, the host's attempt.
      record('r_b', 'user_message', '2026-10-15T10:00:02.500Z', {
        ...under('sub_B', { messageId: 'u_B', parentId: 'tool' }),
        content: [{ type: 'text', text: 'B' }],
      }),
      record('r_s2', 'assistant_message_started', '2026-10-15T10:00:03.000Z', {
        ...under('sub_A', { messageId: 'm_2', parentId: 'u_B' }),
        modelInfo: MODEL_INFO,
      }),
      record('r_c2', 'assistant_message_completed', '2026-10-15T10:00:03.100Z', {
        ...under('sub_A', { messageId: 'm_2' }),
        stopReason: 'stop',
        usage: USAGE,
      }),
      record('r_meta', 'message_metadata', '2026-10-15T10:00:03.150Z', {
        ...under('sub_A', {}),
        metadata: { finishedAt: 1792058403150, toolCallCount: 1 },
      }),
      record('r_set_b', 'submission_settled', '2026-10-15T10:00:03.200Z', {
        ...under('sub_B', {}),
        outcome: 'completed',
      }),
      record('r_set_a', 'submission_settled', '2026-10-15T10:00:03.300Z', {
        ...under('sub_A', {}),
        outcome: 'completed',
      }),
    ]
    expect(Result.getOrThrow(folded(records)).items.map((item) => item._tag)).toEqual([
      'Said',
      'Ran',
      'Replied',
      'Answered',
      'Said',
      'Ran',
      'Replied',
      'Responded',
    ])
    const items = Result.getOrThrow(folded(records)).items
    expect(items.filter(Item.$is('Ran'))).toEqual([
      Item.Ran({ inputs: ['sub_A'] }),
      Item.Ran({ inputs: ['sub_A', 'sub_B'] }),
    ])
    expect(items.at(-1)).toEqual(
      Item.Responded({
        data: {
          outcome: 'completed',
          startedAt: 1792058402000,
          finishedAt: 1792058403150,
          toolCallCount: 1,
          usage: { input: 20, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 30, cost: 6 },
          model: 'example/example',
        },
        inputs: [
          { submission: 'sub_A', outcome: 'completed' },
          { submission: 'sub_B', outcome: 'completed' },
        ],
      }),
    )
  })

  it('lets a delivery on a resumed attempt no model message started stand alone', () => {
    // A's first attempt ran a model step; the resumed attempt took B in and failed before any
    // model message started. Nothing names the resumed attempt's host, so B is not joined to A:
    // each settles its own response with the outcome its own settlement states.
    const records = [
      BIRTH,
      ...resumedPrefix,
      record('r_set_b', 'submission_settled', '2026-10-15T10:00:04.000Z', {
        ...at('sub_B', 'att_2', {}),
        outcome: 'failed',
      }),
      record('r_set_a', 'submission_settled', '2026-10-15T10:00:04.100Z', {
        ...at('sub_A', 'att_2', {}),
        outcome: 'failed',
      }),
    ]
    const items = Result.getOrThrow(folded(records)).items
    expect(items.map((item) => item._tag)).toEqual([
      'Said',
      'Ran',
      'Replied',
      'Answered',
      'Said',
      'Said',
      'Responded',
      'Responded',
    ])
    expect(items.filter(Item.$is('Ran'))).toEqual([Item.Ran({ inputs: ['sub_A'] })])
    expect(items.filter(Item.$is('Responded'))).toEqual([
      alone('sub_B', 1792058403000, 1792058404000),
      Item.Responded({
        data: {
          outcome: 'failed',
          startedAt: 1792058402000,
          finishedAt: 1792058404100,
          toolCallCount: 1,
          usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: 3 },
          model: 'example/example',
        },
        inputs: [{ submission: 'sub_A', outcome: 'failed' }],
      }),
    ])
  })

  it('names no host for a first attempt cut between a joined and the host settlement', () => {
    // Sol's first cut: A and B were placed under A's first attempt, which failed before a model
    // message started, and the log ends after B's settlement, before A's.
    const records = [
      BIRTH,
      record('r_a', 'user_message', '2026-10-15T10:00:01.000Z', {
        ...at('sub_A', 'att_1', { messageId: 'u_A', parentId: null }),
        content: [{ type: 'text', text: 'A' }],
      }),
      record('r_a_run', 'agent_start_run', '2026-10-15T10:00:01.000Z', at('sub_A', 'att_1', {})),
      record('r_b', 'user_message', '2026-10-15T10:00:02.000Z', {
        ...at('sub_B', 'att_1', { messageId: 'u_B', parentId: 'u_A' }),
        content: [{ type: 'text', text: 'B' }],
      }),
      record('r_b_run', 'agent_start_run', '2026-10-15T10:00:02.000Z', at('sub_B', 'att_1', {})),
      record('r_set_b', 'submission_settled', '2026-10-15T10:00:03.000Z', {
        ...at('sub_B', 'att_1', {}),
        outcome: 'failed',
      }),
    ]
    expect(Result.getOrThrow(folded(records)).items).toEqual([
      Item.Said({
        message: { role: 'user', content: 'A', timestamp: 1792058401000 },
        submission: Option.none(),
      }),
      Item.Said({
        message: { role: 'user', content: 'B', timestamp: 1792058402000 },
        submission: Option.some('sub_B'),
      }),
      alone('sub_B', 1792058402000, 1792058403000),
    ])
  })

  it('names no host for a resumed attempt cut after both joined settlements', () => {
    // Sol's second cut: B and C joined A's resumed attempt before a model message started there,
    // and the log ends after both joined settlements, before A's.
    const records = [
      BIRTH,
      ...resumedPrefix,
      record('r_set_b', 'submission_settled', '2026-10-15T10:00:04.000Z', {
        ...at('sub_B', 'att_2', {}),
        outcome: 'failed',
      }),
      record('r_set_c', 'submission_settled', '2026-10-15T10:00:04.100Z', {
        ...at('sub_C', 'att_2', {}),
        outcome: 'failed',
      }),
    ]
    expect(Result.getOrThrow(folded(records)).items).toEqual([
      Item.Said({
        message: { role: 'user', content: 'A', timestamp: 1792058401000 },
        submission: Option.none(),
      }),
      ...stepOfA,
      Item.Said({
        message: { role: 'user', content: 'B', timestamp: 1792058403000 },
        submission: Option.some('sub_B'),
      }),
      Item.Said({
        message: { role: 'user', content: 'C', timestamp: 1792058403000 },
        submission: Option.some('sub_C'),
      }),
      alone('sub_B', 1792058403000, 1792058404000),
      alone('sub_C', 1792058403000, 1792058404100),
    ])
  })

  it('names no host for a resumed attempt cut after one joined settlement', () => {
    // Sol's third cut: as the second, but the log ends after B's settlement, before C's and A's.
    const records = [
      BIRTH,
      ...resumedPrefix,
      record('r_set_b', 'submission_settled', '2026-10-15T10:00:04.000Z', {
        ...at('sub_B', 'att_2', {}),
        outcome: 'failed',
      }),
    ]
    expect(Result.getOrThrow(folded(records)).items).toEqual([
      Item.Said({
        message: { role: 'user', content: 'A', timestamp: 1792058401000 },
        submission: Option.none(),
      }),
      ...stepOfA,
      Item.Said({
        message: { role: 'user', content: 'B', timestamp: 1792058403000 },
        submission: Option.some('sub_B'),
      }),
      Item.Said({
        message: { role: 'user', content: 'C', timestamp: 1792058403000 },
        submission: Option.none(),
      }),
      alone('sub_B', 1792058403000, 1792058404000),
    ])
  })

  it('fails a Thread holding a stream recovery signal instead of losing its partial reply', () => {
    const records = [
      BIRTH,
      userSays('sub_1', 'r_user', '2026-10-15T10:00:01.000Z', 'Hi'),
      record('r_int', 'signal', '2026-10-15T10:00:02.000Z', {
        submissionId: 'sub_1',
        messageId: 'entry_int',
        parentId: 'entry_r_user',
        signalType: 'stream_interrupted',
        content: 'The stream was interrupted.',
      }),
    ]
    expect(Result.getOrThrow(Result.flip(folded(records)))).toEqual(
      new RecoveryPairUnsupported({ recordId: 'r_int', signalType: 'stream_interrupted' }),
    )
  })

  it('fails a Thread with tool calls under a stop reason Pi does not run them for', () => {
    const records = [
      BIRTH,
      userSays('sub_1', 'r_user', '2026-10-15T10:00:01.000Z', 'Go'),
      record('r_s', 'assistant_message_started', '2026-10-15T10:00:02.000Z', {
        submissionId: 'sub_1',
        messageId: 'm_1',
        parentId: 'entry_r_user',
        modelInfo: MODEL_INFO,
      }),
      record('r_call', 'assistant_tool_call', '2026-10-15T10:00:02.100Z', {
        submissionId: 'sub_1',
        messageId: 'm_1',
        blockId: 'b_call',
        blockIndex: 0,
        toolCallId: 'call_1',
        name: 'run_code',
        arguments: {},
      }),
      record('r_c', 'assistant_message_completed', '2026-10-15T10:00:02.200Z', {
        submissionId: 'sub_1',
        messageId: 'm_1',
        stopReason: 'length',
        usage: USAGE,
      }),
    ]
    expect(Result.getOrThrow(Result.flip(folded(records)))).toEqual(
      new ToolBatchUnderStop({ recordId: 'r_c', stopReason: 'length' }),
    )
  })

  it('fails a Thread whose submission completed with no reply to answer it', () => {
    const records = [
      BIRTH,
      userSays('sub_1', 'r_user', '2026-10-15T10:00:01.000Z', 'Hi'),
      record('r_settled', 'submission_settled', '2026-10-15T10:00:02.000Z', {
        submissionId: 'sub_1',
        outcome: 'completed',
      }),
    ]
    expect(Result.getOrThrow(Result.flip(folded(records)))).toEqual(
      new AnswerMissing({ submissionId: 'sub_1' }),
    )
  })

  it('fails a Thread whose deltas skip a number', () => {
    const records = [
      BIRTH,
      userSays('sub_1', 'r_user', '2026-10-15T10:00:01.000Z', 'Hi'),
      record('r_s', 'assistant_message_started', '2026-10-15T10:00:02.000Z', {
        submissionId: 'sub_1',
        messageId: 'm_1',
        parentId: 'entry_r_user',
        modelInfo: MODEL_INFO,
      }),
      record('r_t', 'assistant_text_started', '2026-10-15T10:00:02.000Z', {
        submissionId: 'sub_1',
        messageId: 'm_1',
        blockId: 'b_1',
        blockIndex: 0,
      }),
      record('r_d0', 'assistant_text_delta', '2026-10-15T10:00:02.100Z', {
        submissionId: 'sub_1',
        messageId: 'm_1',
        blockId: 'b_1',
        sequence: 0,
        delta: 'a',
      }),
      record('r_d2', 'assistant_text_delta', '2026-10-15T10:00:02.200Z', {
        submissionId: 'sub_1',
        messageId: 'm_1',
        blockId: 'b_1',
        sequence: 2,
        delta: 'c',
      }),
    ]
    expect(Result.getOrThrow(Result.flip(folded(records)))).toEqual(
      new DeltaGap({ recordId: 'r_d2', blockId: 'b_1', expected: 1, found: 2 }),
    )
  })

  it('fails a Thread with a record type the import has no rule for', () => {
    const records = [
      BIRTH,
      record('r_compact', 'compaction', '2026-10-15T10:00:01.000Z', {
        entryId: 'entry_c',
        parentId: null,
        summary: 'Earlier',
        firstKeptEntryId: 'entry_c',
        sourceLeafId: 'entry_c',
        tokensBefore: 10,
      }),
    ]
    expect(Result.getOrThrow(Result.flip(folded(records)))).toEqual(
      new RecordUnknown({ recordType: 'compaction', recordId: 'r_compact' }),
    )
  })

  it('fails a stream that does not begin with its conversation', () => {
    const records = [userSays('sub_1', 'r_user', '2026-10-15T10:00:01.000Z', 'Hi')]
    expect(Result.getOrThrow(Result.flip(folded(records)))).toEqual(
      new StreamStartMissing({ threadId: THREAD }),
    )
  })
})
