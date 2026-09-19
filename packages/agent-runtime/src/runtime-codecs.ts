import * as Schema from "effect/Schema";

const nullable = <A extends Schema.Top>(schema: A) => Schema.NullOr(schema);
const taskStatus = Schema.Union([Schema.Literal("open"), Schema.Literal("done"), Schema.Literal("dropped")]);
const taskPriority = Schema.Union([Schema.Literal("normal"), Schema.Literal("urgent")]);
const author = Schema.Union([Schema.Literal("you"), Schema.Literal("vivid")]);
const followUpStatus = Schema.Union([
  Schema.Literal("scheduled"), Schema.Literal("running"), Schema.Literal("fired"),
  Schema.Literal("cancelled"), Schema.Literal("failed")
]);
const notificationKind = Schema.Union([
  Schema.Literal("tracked"), Schema.Literal("overdue"), Schema.Literal("follow-up"),
  Schema.Literal("follow-up-failed")
]);
const routineRunStatus = Schema.Union([Schema.Literal("running"), Schema.Literal("succeeded"), Schema.Literal("failed")]);

export const ConversationSchema = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  preview: Schema.String,
  updatedAt: Schema.Number,
  archived: Schema.Boolean
});

export const TaskRowSchema = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  detail: Schema.String,
  status: taskStatus,
  priority: taskPriority,
  assignee: nullable(Schema.String),
  dueAt: nullable(Schema.Number),
  originKind: Schema.Union([Schema.Literal("conversation"), Schema.Literal("routine"), Schema.Literal("manual")]),
  originId: nullable(Schema.String),
  createdBy: author,
  conversationId: Schema.String,
  overdueNotifiedAt: nullable(Schema.Number),
  completedAt: nullable(Schema.Number),
  createdAt: Schema.Number,
  updatedAt: Schema.Number
});

export const FollowUpSchema = Schema.Struct({
  id: Schema.String,
  taskId: Schema.String,
  at: Schema.Number,
  note: Schema.String,
  repeatEveryMs: nullable(Schema.Number),
  status: followUpStatus,
  submissionId: nullable(Schema.String),
  firedAt: nullable(Schema.Number),
  output: nullable(Schema.String),
  error: nullable(Schema.String),
  createdBy: author,
  createdAt: Schema.Number
});

export const NotificationSchema = Schema.Struct({
  id: Schema.String,
  kind: notificationKind,
  title: Schema.String,
  body: Schema.String,
  taskId: nullable(Schema.String),
  conversationId: nullable(Schema.String),
  createdAt: Schema.Number,
  readAt: nullable(Schema.Number)
});

export const RoutineSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  prompt: Schema.String,
  cron: Schema.String,
  timezone: Schema.String,
  libraryFolderId: nullable(Schema.String),
  enabled: Schema.Boolean,
  nextExpectedAt: nullable(Schema.Number),
  lastMissedAt: nullable(Schema.Number),
  createdAt: Schema.Number,
  updatedAt: Schema.Number
});

export const RoutineRunSchema = Schema.Struct({
  id: Schema.String,
  routineId: Schema.String,
  conversationId: Schema.String,
  submissionId: nullable(Schema.String),
  status: routineRunStatus,
  startedAt: Schema.Number,
  finishedAt: nullable(Schema.Number),
  output: nullable(Schema.String),
  error: nullable(Schema.String)
});

export const LibraryDocumentSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  mimeType: Schema.String,
  size: Schema.Number,
  sha256: Schema.String,
  status: Schema.Union([Schema.Literal("processing"), Schema.Literal("ready"), Schema.Literal("failed")]),
  error: nullable(Schema.String),
  preview: Schema.String,
  chunkCount: Schema.Number,
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
  folderId: nullable(Schema.String)
});

export const StoredLibraryDocumentSchema = Schema.Struct({
  ...LibraryDocumentSchema.fields,
  bytes: Schema.Uint8Array,
  extractedText: Schema.String
});

export const LibraryFolderSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  parentId: nullable(Schema.String),
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
  itemCount: Schema.Number
});

export const LibrarySearchResultSchema = Schema.Struct({
  chunkId: Schema.String,
  documentId: Schema.String,
  filename: Schema.String,
  page: nullable(Schema.Number),
  text: Schema.String,
  score: Schema.Number
});

export const LibrarySearchRowSchema = Schema.Struct({
  chunkId: Schema.String,
  documentId: Schema.String,
  filename: Schema.String,
  page: nullable(Schema.Number),
  text: Schema.String,
  score: Schema.Number
});

export const decodeConversation = Schema.decodeUnknownSync(ConversationSchema);
export const decodeTaskRow = Schema.decodeUnknownSync(TaskRowSchema);
export const decodeFollowUp = Schema.decodeUnknownSync(FollowUpSchema);
export const decodeNotification = Schema.decodeUnknownSync(NotificationSchema);
export const decodeRoutine = Schema.decodeUnknownSync(RoutineSchema);
export const decodeRoutineRun = Schema.decodeUnknownSync(RoutineRunSchema);
export const decodeLibraryDocument = Schema.decodeUnknownSync(LibraryDocumentSchema);
export const decodeStoredLibraryDocument = Schema.decodeUnknownSync(StoredLibraryDocumentSchema);
export const decodeLibraryFolder = Schema.decodeUnknownSync(LibraryFolderSchema);
export const decodeLibrarySearchResult = Schema.decodeUnknownSync(LibrarySearchResultSchema);
