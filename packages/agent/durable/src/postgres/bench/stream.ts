import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import type { JsonValue } from '@earendil-works/chord'
import type { ConversationId, DocumentId, EntryId, Storage, StorageWrite, SubmissionId, TaskId, TaskRecord } from '@earendil-works/pi-durable'

/** Public Storage workloads representative of streaming progress commits. Setup
 * is excluded from both time and query count; all records use real PostgreSQL. */
export async function streamingWrites(storage: Storage) {
  const context = BACKGROUND_CONTEXT
  const conversationId = await storage.mintId<ConversationId>()
  const taskId = await storage.mintId<TaskId<JsonValue>>()
  const documentId = await storage.mintId<DocumentId>()
  const task: TaskRecord<JsonValue, JsonValue, JsonValue> = {
    id: taskId, conversationId, kind: 'stream', version: 1, input: {},
    background: false, abortRequested: false,
    state: { status: 'running', checkpoint: { text: '' } },
  }
  await storage.commit([
    { type: 'conversation', value: { id: conversationId } },
    { type: 'task', value: task },
    { type: 'document.create', record: { id: documentId, kind: 'stream', scope: { kind: 'session' } }, content: { kind: 'base', version: 1, value: { text: '' } } },
  ], context)
  const entryId = await storage.mintId<EntryId>()
  const secondEntryId = await storage.mintId<EntryId>()
  const submissionId = await storage.mintId<SubmissionId>()
  return [
    { name: 'stream entry append', writes: [{ type: 'entry', value: { id: entryId, conversationId, kind: 'stream', data: { text: 'hello' } } }] },
    { name: 'stream task update + document revision', writes: [
      { type: 'task', value: { ...task, state: { status: 'running', checkpoint: { text: 'hello' } } } },
      { type: 'document.change', id: documentId, content: { kind: 'delta', version: 1, ops: [['s', ['text'], 'hello']] } },
    ] },
    { name: 'stream submission + entry', writes: [
      { type: 'submission', value: { id: submissionId, conversationId, requestId: 'stream', type: 'write', status: 'done', entry: secondEntryId } },
      { type: 'entry', value: { id: secondEntryId, conversationId, kind: 'stream' } },
    ] },
  ] satisfies readonly { readonly name: string; readonly writes: readonly StorageWrite[] }[]
}
