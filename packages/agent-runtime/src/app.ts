import { createAgentRouter } from '@flue/runtime/routing'
import { Hono } from 'hono'
import { Config, Effect, Option, Redacted, Schema } from 'effect'
import * as Result from 'effect/Result'
import {
  ConnectionCallbackQuery,
  ConnectionCallbackState,
  ConnectionId,
  ConnectionParams,
  CreateLibraryFolderRequest,
  CreateRoutineRequest,
  CreateTaskRequest,
  FollowUpInput,
  FollowUpParams,
  LibraryFolderParams,
  LibraryItemParams,
  LibraryListQuery,
  LibrarySearchRequest,
  LibrarySourceQuery,
  LibraryUploadMetadata,
  NudgeTaskRequest,
  PatchFollowUpRequest,
  PatchLibraryFolderRequest,
  PatchLibraryItemRequest,
  PatchRoutineRequest,
  PatchTaskRequest,
  PatchThreadRequest,
  PutThreadRequest,
  ReadNotificationsRequest,
  RoutineParams,
  TaskListQuery,
  TaskParams,
  ThreadParams,
  TimestampInput,
} from '@vivid/contracts'
import './providers/openrouter.ts'
import { Vivid } from './agents/vivid.ts'
import { MAX_LIBRARY_FILE_BYTES, digestBytes, ingestLibraryDocument } from './library-ingest.ts'
import {
  createLibraryFolder,
  createLibraryDocument,
  deleteLibraryFolder,
  deleteLibraryDocument,
  getLibraryFolder,
  getLibraryDocument,
  getLibraryDocumentByDigest,
  getStoredLibraryDocument,
  getStoredLibraryDocumentByName,
  listAllLibraryFolders,
  listLibraryDocuments,
  listLibraryFolders,
  searchLibrary,
  updateLibraryDocument,
  updateLibraryFolder,
} from './library-store.ts'
import {
  GmailConnector,
  CalendarConnector,
  DriveConnector,
  getConnectorStatus,
  deleteCredentialsForConnector,
} from '@vivid/connectors'
import {
  getRoutineView,
  initializeRoutineScheduler,
  listRoutineViews,
  removeRoutineJob,
  runRoutineNow,
  syncRoutineJob,
  validateRoutineSchedule,
  type RoutineSchedulerBoundary,
} from './routine-scheduler.ts'
import { createRoutine, deleteRoutine, getRoutine, updateRoutine } from './routine-store.ts'
import {
  chaseTaskNow,
  FOLLOW_UP_TICK_MS,
  initializeFollowUpScheduler,
  runFollowUpNow,
  runFollowUpSchedulerTick,
} from './follow-up-scheduler.ts'
import {
  createFollowUp,
  createTask,
  deleteFollowUp,
  deleteTask,
  getFollowUp,
  getTask,
  getTaskView,
  listNotifications,
  listTaskViews,
  markNotificationsRead,
  unreadNotificationCount,
  updateFollowUp,
  updateTask,
  type TaskPatch,
} from './task-store.ts'
import { deleteConversation, listConversations, upsertConversation } from './thread-store.ts'

const app = new Hono()

type AppContext = Parameters<Parameters<typeof app.use>[1]>[0]

class InvalidIngress extends Schema.TaggedError<InvalidIngress>()(
  'InvalidIngress',
  {
    message: Schema.String,
  },
  { title: 'Invalid runtime ingress' },
) {}

class RuntimeOperationFailed extends Schema.TaggedError<RuntimeOperationFailed>()(
  'RuntimeOperationFailed',
  {
    message: Schema.String,
  },
  { title: 'Runtime operation failed' },
) {}

class InvalidTaskMutation extends Schema.TaggedError<InvalidTaskMutation>()(
  'InvalidTaskMutation',
  {
    message: Schema.String,
  },
  { title: 'Invalid Task mutation' },
) {}

class InvalidFollowUpMutation extends Schema.TaggedError<InvalidFollowUpMutation>()(
  'InvalidFollowUpMutation',
  {
    message: Schema.String,
  },
  { title: 'Invalid follow-up mutation' },
) {}

type IngressValue =
  | string
  | number
  | boolean
  | null
  | ReadonlyArray<IngressValue>
  | { readonly [key: string]: IngressValue }

const decodeConnectionCallbackState = Schema.decodeUnknownResult(
  Schema.fromJsonString(ConnectionCallbackState),
)
const isNumber = Schema.is(Schema.Number)
const libraryMimeTypes = new Map([
  ['pdf', 'application/pdf'],
  ['md', 'text/markdown'],
  ['markdown', 'text/markdown'],
  ['txt', 'text/plain'],
])

/** Maps supported filename extensions before the shared upload schema checks the final MIME type. */
const inferLibraryMimeType = (name: string, declaredType: string) => {
  const extension = name.toLocaleLowerCase().split('.').pop()
  return (extension === undefined ? undefined : libraryMimeTypes.get(extension)) ?? declaredType
}

/** Converts FormData's absent, file, and empty folder variants into the domain's root-folder value. */
const libraryUploadFolderId = (value: string | File | null) => {
  if (value === null || value instanceof File || value.length === 0) return null
  return value
}

/** Reads one JSON body and decodes it before domain code can observe the value. */
const decodeJsonBody = <Value, Encoded>(
  context: AppContext,
  schema: Schema.Codec<Value, Encoded>,
  emptyObject = false,
): Promise<Result.Result<Value, InvalidIngress>> => {
  const program = Effect.fn('RuntimeIngress.decodeJsonBody')(function* () {
    const body = yield* Effect.tryPromise(() => context.req.text()).pipe(
      Effect.mapError(() => new InvalidIngress({ message: 'Request body could not be read' })),
    )
    const json = emptyObject && body.trim().length === 0 ? '{}' : body
    return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(json).pipe(
      Effect.mapError(
        () => new InvalidIngress({ message: 'Request body did not match its contract' }),
      ),
    )
  })()
  // Hono owns this Promise callback; request validation remains in the typed Effect channel.
  // oxlint-disable-next-line vivid/no-runpromise-in-library
  return Effect.runPromise(Effect.result(program))
}

/** Captures one Promise or throwing adapter at the Hono boundary. */
const runOperation = <Value>(
  operation: () => Value | Promise<Value>,
): Promise<Result.Result<Value, RuntimeOperationFailed>> => {
  const program = Effect.tryPromise(() => Promise.resolve(operation())).pipe(
    Effect.mapError((error) => new RuntimeOperationFailed({ message: error.message })),
  )
  // Hono owns this Promise callback; expected failures remain typed until response mapping.
  // oxlint-disable-next-line vivid/no-runpromise-in-library
  return Effect.runPromise(Effect.result(program))
}

/** Runs one service-free Effect at the Hono Promise boundary. */
const runRuntimeEffect = <Value, Failure>(
  effect: Effect.Effect<Value, Failure>,
): Promise<Result.Result<Value, Failure>> => {
  // Hono owns this Promise callback; the reusable program stays in Effect.
  // oxlint-disable-next-line vivid/no-runpromise-in-library
  return Effect.runPromise(Effect.result(effect))
}

/** Starts one observed runtime fiber from a Hono-owned timer callback. */
const observeRuntimeEffect = <Failure>(
  label: string,
  effect: Effect.Effect<void, Failure>,
): void => {
  Effect.runFork(effect.pipe(Effect.tapCause((cause) => Effect.logError(label, cause))))
}
const routineSchedulerBoundary: RoutineSchedulerBoundary = {
  run: (label, effect) => observeRuntimeEffect(label, effect),
}

setInterval(
  () => observeRuntimeEffect('follow-up tick', runFollowUpSchedulerTick()),
  FOLLOW_UP_TICK_MS,
).unref()
setTimeout(() => {
  observeRuntimeEffect('follow-up recovery', initializeFollowUpScheduler())
  observeRuntimeEffect('routine recovery', initializeRoutineScheduler(routineSchedulerBoundary))
}, 1500).unref()

/** Decodes route and query records synchronously at Hono's string boundary. */
const decodeIngress = <Value>(
  schema: Schema.ConstraintDecoder<Value>,
  value: IngressValue,
): Result.Result<Value, InvalidIngress> =>
  Schema.decodeUnknownResult(schema)(value).pipe(
    Result.mapError(
      () => new InvalidIngress({ message: 'Request values did not match their contract' }),
    ),
  )

app.get('/health', async (context) => {
  const model = await runRuntimeEffect(
    Config.String('VIVID_MODEL').pipe(Config.withDefault('openrouter/z-ai/glm-5.3-flash')),
  )
  return context.json({
    model: Result.isSuccess(model) ? model.success : 'openrouter/z-ai/glm-5.3-flash',
    service: 'vivid-agent-runtime',
    status: 'ok',
  })
})

const requireRuntimeToken = async (
  context: Parameters<Parameters<typeof app.use>[1]>[0],
  next: () => Promise<void>,
) => {
  const configured = await runRuntimeEffect(Config.option(Config.Redacted('VIVID_RUNTIME_TOKEN')))
  if (Result.isFailure(configured) || Option.isNone(configured.success)) {
    return context.json({ error: 'Runtime token is not configured' }, 503)
  }
  const token = Redacted.value(configured.success.value)
  if (context.req.header('authorization') !== `Bearer ${token}`) {
    return context.json({ error: 'Unauthorized' }, 401)
  }

  return next()
}

app.use('/agents/vivid/*', requireRuntimeToken)
app.use('/api/conversations', requireRuntimeToken)
app.use('/api/conversations/*', requireRuntimeToken)
app.use('/api/routines', requireRuntimeToken)
app.use('/api/routines/*', requireRuntimeToken)
app.use('/api/library', requireRuntimeToken)
app.use('/api/library/*', requireRuntimeToken)
app.use('/api/tasks', requireRuntimeToken)
app.use('/api/tasks/*', requireRuntimeToken)
app.use('/api/follow-ups/*', requireRuntimeToken)
app.use('/api/notifications', requireRuntimeToken)
app.use('/api/notifications/*', requireRuntimeToken)

app.get('/api/conversations', async (context) =>
  context.json({ conversations: await listConversations() }),
)

app.put('/api/conversations/:id', async (context) => {
  const params = decodeIngress(ThreadParams, { id: context.req.param('id') })
  if (Result.isFailure(params) || !/^[A-Za-z0-9_-]{1,128}$/.test(params.success.id)) {
    return context.json({ error: 'Invalid conversation id' }, 400)
  }
  const decoded = await decodeJsonBody(context, PutThreadRequest)
  if (Result.isFailure(decoded)) {
    return context.json({ error: 'title and preview must be strings' }, 400)
  }
  const body = decoded.success
  const conversation = await upsertConversation({
    archived: body.archived ?? false,
    id: params.success.id,
    title: body.title.trim().slice(0, 120) || 'New conversation',
    preview: body.preview.trim().slice(0, 500),
    updatedAt: body.updatedAt === undefined ? Date.now() : Math.trunc(body.updatedAt),
  })

  return context.json({ conversation })
})

app.patch('/api/conversations/:id', async (context) => {
  const params = decodeIngress(ThreadParams, { id: context.req.param('id') })
  if (Result.isFailure(params)) return context.json({ error: 'Conversation not found' }, 404)
  const current = (await listConversations()).find(
    (conversation) => conversation.id === params.success.id,
  )
  if (!current) return context.json({ error: 'Conversation not found' }, 404)
  const decoded = await decodeJsonBody(context, PatchThreadRequest)
  if (Result.isFailure(decoded)) return context.json({ error: 'Invalid conversation update' }, 400)
  const body = decoded.success
  if (body.title !== undefined && !body.title.trim())
    return context.json({ error: 'Invalid title' }, 400)
  const conversation = await upsertConversation({
    ...current,
    title: body.title === undefined ? current.title : body.title.trim().slice(0, 120),
    archived: body.archived ?? current.archived,
    updatedAt: Date.now(),
  })
  return context.json({ conversation })
})

app.delete('/api/conversations/:id', async (context) => {
  const params = decodeIngress(ThreadParams, { id: context.req.param('id') })
  if (Result.isFailure(params) || !(await deleteConversation(params.success.id))) {
    return context.json({ error: 'Conversation not found' }, 404)
  }
  return context.body(null, 204)
})

app.get('/api/library', async (context) => {
  const rawFolderId = context.req.query('folderId')
  const query = decodeIngress(
    LibraryListQuery,
    rawFolderId === undefined ? {} : { folderId: rawFolderId },
  )
  if (Result.isFailure(query)) return context.json({ error: 'Invalid folder' }, 400)
  const folderId = query.success.folderId ?? null
  if (folderId !== null && !(await getLibraryFolder(folderId)))
    return context.json({ error: 'Folder not found' }, 404)
  return context.json({
    documents: await listLibraryDocuments(folderId),
    folders: await listLibraryFolders(folderId),
  })
})

app.post('/api/library/folders', async (context) => {
  const decoded = await decodeJsonBody(context, CreateLibraryFolderRequest)
  if (Result.isFailure(decoded) || !decoded.success.name.trim()) {
    return context.json({ error: 'Folder name is required' }, 400)
  }
  const body = decoded.success
  const parentId = body.parentId === undefined || body.parentId === '' ? null : body.parentId
  if (parentId && !(await getLibraryFolder(parentId)))
    return context.json({ error: 'Parent folder not found' }, 404)
  return context.json(
    { folder: await createLibraryFolder(body.name.trim().slice(0, 120), parentId) },
    201,
  )
})

app.get('/api/library/folders', async (context) =>
  context.json({ folders: await listAllLibraryFolders() }),
)

app.patch('/api/library/folders/:id', async (context) => {
  const params = decodeIngress(LibraryFolderParams, { id: context.req.param('id') })
  const decoded = await decodeJsonBody(context, PatchLibraryFolderRequest)
  if (Result.isFailure(params) || Result.isFailure(decoded))
    return context.json({ error: 'Invalid folder update' }, 400)
  const body = decoded.success
  const patch: Parameters<typeof updateLibraryFolder>[1] = {}
  if (body.name !== undefined) {
    if (!body.name.trim()) return context.json({ error: 'Folder name is required' }, 400)
    patch.name = body.name.trim().slice(0, 120)
  }
  if (body.parentId !== undefined) {
    patch.parentId = body.parentId === '' ? null : body.parentId
    if (patch.parentId && !(await getLibraryFolder(patch.parentId)))
      return context.json({ error: 'Parent folder not found' }, 404)
  }
  const updated = await runOperation(() => updateLibraryFolder(params.success.id, patch))
  if (Result.isFailure(updated)) return context.json({ error: updated.failure.message }, 409)
  return updated.success
    ? context.json({ folder: updated.success })
    : context.json({ error: 'Folder not found' }, 404)
})

app.delete('/api/library/folders/:id', async (context) => {
  const params = decodeIngress(LibraryFolderParams, { id: context.req.param('id') })
  if (Result.isFailure(params)) return context.json({ error: 'Folder not found' }, 404)
  const outcome = await deleteLibraryFolder(params.success.id)
  if (outcome === 'not-found') return context.json({ error: 'Folder not found' }, 404)
  if (outcome === 'not-empty')
    return context.json({ error: 'Folder must be empty before it can be deleted' }, 409)
  return context.body(null, 204)
})

app.post('/api/library', async (context) => {
  const form = await context.req.formData()
  const upload = form.get('file')
  if (!(upload instanceof File)) return context.json({ error: 'A file is required' }, 400)
  if (upload.size === 0) return context.json({ error: 'The file is empty' }, 400)
  if (upload.size > MAX_LIBRARY_FILE_BYTES)
    return context.json({ error: 'Files must be 10 MB or smaller' }, 413)

  const name = (upload.name.split(/[\\/]/).pop() ?? 'document').trim().slice(0, 180)
  const metadata = decodeIngress(LibraryUploadMetadata, {
    name,
    mimeType: inferLibraryMimeType(name, upload.type),
    size: upload.size,
    folderId: libraryUploadFolderId(form.get('folderId')),
  })
  if (Result.isFailure(metadata))
    return context.json({ error: 'Only PDF, Markdown, and plain-text files are supported' }, 415)
  const { folderId, mimeType } = metadata.success
  if (folderId !== null && !(await getLibraryFolder(folderId)))
    return context.json({ error: 'Folder not found' }, 404)

  const bytes = new Uint8Array(await upload.arrayBuffer())
  const sha256 = digestBytes(bytes)
  const existing = await getLibraryDocumentByDigest(sha256)
  if (existing) return context.json({ document: existing, duplicate: true })

  const document = await createLibraryDocument({ name, mimeType, bytes, sha256, folderId })
  observeRuntimeEffect('library ingest', ingestLibraryDocument(document.id))
  return context.json({ document, duplicate: false }, 202)
})

app.post('/api/library/search', async (context) => {
  const decoded = await decodeJsonBody(context, LibrarySearchRequest)
  if (Result.isFailure(decoded) || decoded.success.query.trim().length < 2) {
    return context.json({ error: 'A search query is required' }, 400)
  }
  const body = decoded.success
  const limit = body.limit === undefined || !Number.isInteger(body.limit) ? 6 : body.limit
  const folderId = body.folderId === null || body.folderId === '' ? undefined : body.folderId
  if (folderId && !(await getLibraryFolder(folderId)))
    return context.json({ error: 'Folder not found' }, 404)
  return context.json({
    results: await searchLibrary(body.query.trim().slice(0, 500), limit, folderId),
  })
})

app.get('/api/library/source', async (context) => {
  const rawName = context.req.query('name')
  const query = decodeIngress(LibrarySourceQuery, rawName === undefined ? {} : { name: rawName })
  if (Result.isFailure(query) || query.success.name.length === 0)
    return context.json({ error: 'Source name is required' }, 400)
  const name = query.success.name
  const document = await getStoredLibraryDocumentByName(name)
  if (!document) return context.json({ error: 'Document not found' }, 404)
  return new Response(document.bytes, {
    headers: {
      'content-disposition': `inline; filename*=UTF-8''${encodeURIComponent(document.name)}`,
      'content-length': String(document.size),
      'content-type': document.mimeType,
      'x-content-type-options': 'nosniff',
    },
  })
})

app.get('/api/library/:id/content', async (context) => {
  const params = decodeIngress(LibraryItemParams, { id: context.req.param('id') })
  if (Result.isFailure(params)) return context.json({ error: 'Document not found' }, 404)
  const document = await getStoredLibraryDocument(params.success.id)
  if (!document) return context.json({ error: 'Document not found' }, 404)
  return new Response(document.bytes, {
    headers: {
      'content-disposition': `inline; filename*=UTF-8''${encodeURIComponent(document.name)}`,
      'content-length': String(document.size),
      'content-type': document.mimeType,
      'x-content-type-options': 'nosniff',
    },
  })
})

app.get('/api/library/:id', async (context) => {
  const params = decodeIngress(LibraryItemParams, { id: context.req.param('id') })
  if (Result.isFailure(params)) return context.json({ error: 'Document not found' }, 404)
  const document = await getLibraryDocument(params.success.id)
  return document ? context.json({ document }) : context.json({ error: 'Document not found' }, 404)
})

app.patch('/api/library/:id', async (context) => {
  const params = decodeIngress(LibraryItemParams, { id: context.req.param('id') })
  const decoded = await decodeJsonBody(context, PatchLibraryItemRequest)
  if (Result.isFailure(params) || Result.isFailure(decoded))
    return context.json({ error: 'Invalid Library item update' }, 400)
  const body = decoded.success
  const patch: Parameters<typeof updateLibraryDocument>[1] = {}
  if (body.name !== undefined) {
    if (!body.name.trim()) return context.json({ error: 'File name is required' }, 400)
    patch.name = body.name.trim().slice(0, 180)
  }
  if (body.folderId !== undefined) {
    patch.folderId = body.folderId === '' ? null : body.folderId
    if (patch.folderId && !(await getLibraryFolder(patch.folderId)))
      return context.json({ error: 'Folder not found' }, 404)
  }
  const document = await updateLibraryDocument(params.success.id, patch)
  return document ? context.json({ document }) : context.json({ error: 'Document not found' }, 404)
})

app.delete('/api/library/:id', async (context) => {
  const params = decodeIngress(LibraryItemParams, { id: context.req.param('id') })
  if (Result.isFailure(params)) return context.json({ error: 'Document not found' }, 404)
  return (await deleteLibraryDocument(params.success.id))
    ? context.body(null, 204)
    : context.json({ error: 'Document not found' }, 404)
})

app.get('/api/routines', async (context) => {
  const listed = await runRuntimeEffect(listRoutineViews())
  return Result.isSuccess(listed)
    ? context.json({ routines: listed.success })
    : context.json({ error: 'Could not load Routines' }, 500)
})

app.post('/api/routines', async (context) => {
  const decoded = await decodeJsonBody(context, CreateRoutineRequest)
  if (Result.isFailure(decoded)) {
    return context.json({ error: 'name, prompt, cron, and timezone are required' }, 400)
  }
  const normalized = createRoutineInputFrom(decoded.success)
  if (Result.isFailure(normalized)) {
    return context.json({ error: normalized.failure.message }, 400)
  }
  const input = normalized.success
  if (input.libraryFolderId && !(await getLibraryFolder(input.libraryFolderId))) {
    return context.json({ error: 'Library folder not found' }, 404)
  }
  const schedule = await runRuntimeEffect(validateRoutineSchedule(input.cron, input.timezone))
  if (Result.isFailure(schedule)) return context.json({ error: schedule.failure.message }, 400)
  const routine = await createRoutine(input)
  const synced = await runRuntimeEffect(syncRoutineJob(routine, routineSchedulerBoundary))
  if (Result.isFailure(synced))
    return context.json({ error: 'Could not schedule the Routine' }, 500)
  const view = await runRuntimeEffect(getRoutineView(routine))
  return Result.isSuccess(view)
    ? context.json({ routine: view.success }, 201)
    : context.json({ error: 'Could not load the Routine' }, 500)
})

app.patch('/api/routines/:id', async (context) => {
  const params = decodeIngress(RoutineParams, { id: context.req.param('id') })
  if (Result.isFailure(params)) return context.json({ error: 'Routine not found' }, 404)
  const current = await getRoutine(params.success.id)
  if (!current) return context.json({ error: 'Routine not found' }, 404)
  const decoded = await decodeJsonBody(context, PatchRoutineRequest)
  if (Result.isFailure(decoded)) return context.json({ error: 'Invalid Routine update' }, 400)
  const normalized = routinePatchFrom(decoded.success)
  if (Result.isFailure(normalized)) {
    return context.json({ error: normalized.failure.message }, 400)
  }
  const patch = normalized.success
  if (patch.libraryFolderId && !(await getLibraryFolder(patch.libraryFolderId))) {
    return context.json({ error: 'Library folder not found' }, 404)
  }
  const scheduleInput = routineScheduleFromPatch(patch, current)
  const schedule = await runRuntimeEffect(
    validateRoutineSchedule(scheduleInput.cron, scheduleInput.timezone),
  )
  if (Result.isFailure(schedule)) return context.json({ error: schedule.failure.message }, 400)
  const routine = await updateRoutine(current.id, patch)
  if (!routine) return context.json({ error: 'Routine not found' }, 404)
  const synced = await runRuntimeEffect(syncRoutineJob(routine, routineSchedulerBoundary))
  if (Result.isFailure(synced))
    return context.json({ error: 'Could not schedule the Routine' }, 500)
  const view = await runRuntimeEffect(getRoutineView(routine))
  return Result.isSuccess(view)
    ? context.json({ routine: view.success })
    : context.json({ error: 'Could not load the Routine' }, 500)
})

app.delete('/api/routines/:id', async (context) => {
  const params = decodeIngress(RoutineParams, { id: context.req.param('id') })
  if (Result.isFailure(params)) return context.json({ error: 'Routine not found' }, 404)
  const id = params.success.id
  if (!(await deleteRoutine(id))) return context.json({ error: 'Routine not found' }, 404)
  const removed = await runRuntimeEffect(removeRoutineJob(id))
  return Result.isSuccess(removed)
    ? context.body(null, 204)
    : context.json({ error: 'Could not stop the Routine' }, 500)
})

app.post('/api/routines/:id/run', async (context) => {
  const params = decodeIngress(RoutineParams, { id: context.req.param('id') })
  if (Result.isFailure(params)) return context.json({ error: 'Routine not found' }, 404)
  const routine = await getRoutine(params.success.id)
  if (!routine) return context.json({ error: 'Routine not found' }, 404)
  const started = await runRuntimeEffect(runRoutineNow(routine, routineSchedulerBoundary))
  return Result.isSuccess(started)
    ? context.json({ run: started.success }, 202)
    : context.json({ error: 'Could not start the Routine' }, 500)
})

// Connector routes
const connectors = new Map<ConnectionId, () => GmailConnector | CalendarConnector | DriveConnector>(
  [
    ['gmail', () => new GmailConnector()],
    ['calendar', () => new CalendarConnector()],
    ['drive', () => new DriveConnector()],
  ],
)

app.use('/api/connectors', requireRuntimeToken)
app.use('/api/connectors/*', requireRuntimeToken)

app.get('/api/connectors', async (context) => {
  const status = await Promise.all(
    Array.from(connectors, async ([id, createConnector]) => ({
      id,
      status: await getConnectorStatus(id),
      metadata: createConnector().metadata(),
    })),
  )
  return context.json({ connectors: status })
})

app.get('/api/connectors/:id/auth', async (context) => {
  const params = decodeIngress(ConnectionParams, { id: context.req.param('id') })
  if (Result.isFailure(params)) return context.json({ error: 'Unknown connector' }, 404)
  const factory = connectors.get(params.success.id)
  if (factory === undefined) return context.json({ error: 'Unknown connector' }, 404)

  const state = JSON.stringify({ connector: params.success.id, nonce: crypto.randomUUID() })
  const authorization = await runOperation(() =>
    factory().getAuthUrl(Buffer.from(state).toString('base64url')),
  )
  return Result.isSuccess(authorization)
    ? context.json({ authUrl: authorization.success })
    : context.json({ error: 'Google sign-in is not configured on this Vivid server yet.' }, 503)
})

app.get('/api/connectors/google/callback', async (context) => {
  const rawState = context.req.query('state')
  const rawCode = context.req.query('code')
  const callbackQuery: IngressValue =
    rawCode === undefined
      ? {}
      : rawState === undefined
        ? { code: rawCode }
        : { code: rawCode, state: rawState }
  const query = decodeIngress(ConnectionCallbackQuery, callbackQuery)
  if (Result.isFailure(query)) return context.json({ error: 'Missing code' }, 400)
  const { code } = query.success
  let connectorId: ConnectionId = 'gmail'
  if (query.success.state !== undefined) {
    const decodedState = decodeConnectionCallbackState(
      Buffer.from(query.success.state, 'base64url').toString('utf-8'),
    )
    if (Result.isSuccess(decodedState)) connectorId = decodedState.success.connector
  }

  // Google lands the browser here through the web dev proxy, so send it back to the Connectors
  // screen with the outcome instead of showing raw JSON.
  const connectorFactory = connectors.get(connectorId)
  if (connectorFactory === undefined) return context.json({ error: 'Unknown connector' }, 404)
  const exchange = await runOperation(() => connectorFactory().exchangeCode(code))
  if (Result.isFailure(exchange)) {
    return context.redirect(
      `/?settings=connectors&error=${encodeURIComponent(exchange.failure.message)}`,
      303,
    )
  }
  return context.redirect(
    `/?settings=connectors&connected=${encodeURIComponent(exchange.success.connectorId)}`,
    303,
  )
})

app.delete('/api/connectors/:id', async (context) => {
  const params = decodeIngress(ConnectionParams, { id: context.req.param('id') })
  if (Result.isFailure(params) || !connectors.has(params.success.id))
    return context.json({ error: 'Unknown connector' }, 404)
  const deleted = await deleteCredentialsForConnector(params.success.id)
  return context.json({ success: true, deleted })
})

const MAX_REPEAT_MS = 366 * 86_400_000

type RoutineInput = Parameters<typeof createRoutine>[0]
type RoutinePatch = Parameters<typeof updateRoutine>[1]
type RoutineRequest = typeof CreateRoutineRequest.Type
type RoutinePatchRequest = typeof PatchRoutineRequest.Type

/** Normalizes a complete Routine request before persistence and scheduling. */
function createRoutineInputFrom(body: RoutineRequest): Result.Result<RoutineInput, InvalidIngress> {
  const input = {
    name: body.name.trim().slice(0, 120),
    prompt: body.prompt.trim().slice(0, 4_000),
    cron: body.cron.trim().slice(0, 120),
    timezone: body.timezone.trim().slice(0, 120),
    libraryFolderId:
      body.libraryFolderId === undefined || body.libraryFolderId === ''
        ? null
        : body.libraryFolderId,
  }
  return [input.name, input.prompt, input.cron, input.timezone].some((value) => value.length === 0)
    ? Result.fail(new InvalidIngress({ message: 'Routine fields cannot be empty' }))
    : Result.succeed(input)
}

const routineTextFields = [
  { key: 'name', limit: 120 },
  { key: 'prompt', limit: 4_000 },
  { key: 'cron', limit: 120 },
  { key: 'timezone', limit: 120 },
] as const

/** Applies the four required non-empty Routine text fields from a partial request. */
function applyRoutineTextPatch(
  body: RoutinePatchRequest,
  patch: RoutinePatch,
): Result.Result<void, InvalidIngress> {
  for (const field of routineTextFields) {
    const value = body[field.key]
    if (value === undefined) continue
    const normalized = value.trim().slice(0, field.limit)
    if (normalized.length === 0) {
      return Result.fail(new InvalidIngress({ message: `Invalid ${field.key}` }))
    }
    patch[field.key] = normalized
  }
  return Result.succeed(undefined)
}

const routineScheduleFromPatch = (
  patch: RoutinePatch,
  current: { readonly cron: string; readonly timezone: string },
) => ({
  cron: patch.cron ?? current.cron,
  timezone: patch.timezone ?? current.timezone,
})

/** Normalizes one partial Routine request without duplicating route decisions. */
function routinePatchFrom(body: RoutinePatchRequest): Result.Result<RoutinePatch, InvalidIngress> {
  const patch: RoutinePatch = {}
  const text = applyRoutineTextPatch(body, patch)
  if (Result.isFailure(text)) return Result.fail(text.failure)
  if (body.enabled !== undefined) patch.enabled = body.enabled
  if (body.libraryFolderId !== undefined) {
    patch.libraryFolderId = body.libraryFolderId === '' ? null : body.libraryFolderId
  }
  return Result.succeed(patch)
}

type ParsedTimestamp =
  | { readonly _tag: 'Omitted' }
  | { readonly _tag: 'Cleared' }
  | { readonly _tag: 'Value'; readonly value: number }

/** Accepts the decoded wire timestamp forms and normalizes them to epoch milliseconds. */
function parseWhen(
  value?: TimestampInput | null,
): Result.Result<ParsedTimestamp, InvalidTaskMutation> {
  if (value === undefined) return Result.succeed({ _tag: 'Omitted' })
  if (value === null) return Result.succeed({ _tag: 'Cleared' })
  if (isNumber(value)) return Result.succeed({ _tag: 'Value', value })
  const parsed = Date.parse(value)
  return Number.isFinite(parsed)
    ? Result.succeed({ _tag: 'Value', value: parsed })
    : Result.fail(new InvalidTaskMutation({ message: 'Invalid due date' }))
}

const normalizedAssignee = (assignee: string | null) =>
  assignee !== null && assignee.trim().length > 0 ? assignee.trim().slice(0, 80) : null

/** Applies timestamp state to the Task patch while preserving omission. */
function applyTaskDueAt(patch: TaskPatch, dueAt: ParsedTimestamp) {
  if (dueAt._tag === 'Cleared') patch.dueAt = null
  if (dueAt._tag === 'Value') patch.dueAt = dueAt.value
}

/** Normalizes a decoded Task request without using string errors as control flow. */
function taskPatchFrom(
  body: PatchTaskRequest | CreateTaskRequest,
): Result.Result<TaskPatch, InvalidTaskMutation> {
  const patch: TaskPatch = {}
  if (body.title !== undefined) {
    const title = body.title.trim().slice(0, 200)
    if (title.length === 0)
      return Result.fail(new InvalidTaskMutation({ message: 'Title is required' }))
    patch.title = title
  }
  if (body.detail !== undefined) patch.detail = body.detail.trim().slice(0, 2_000)
  if (body.assignee !== undefined) patch.assignee = normalizedAssignee(body.assignee)
  const dueAt = parseWhen(body.dueAt)
  if (Result.isFailure(dueAt)) return Result.fail(dueAt.failure)
  applyTaskDueAt(patch, dueAt.success)
  if (body.priority !== undefined) patch.priority = body.priority
  if ('status' in body && body.status !== undefined) patch.status = body.status
  return Result.succeed(patch)
}

type NormalizedFollowUpInput = { at?: number; note?: string; repeatEveryMs?: number | null }
type FollowUpMutationInput = FollowUpInput | typeof PatchFollowUpRequest.Type

/** Normalizes a decoded follow-up request into one valid mutation. */
function followUpInputFrom(
  body: FollowUpMutationInput,
): Result.Result<NormalizedFollowUpInput, InvalidFollowUpMutation> {
  const input: NormalizedFollowUpInput = {}
  const at = parseWhen(body.at)
  if (Result.isFailure(at)) {
    return Result.fail(new InvalidFollowUpMutation({ message: at.failure.message }))
  }
  if (at.success._tag === 'Cleared') {
    return Result.fail(new InvalidFollowUpMutation({ message: 'A follow-up time is required' }))
  }
  if (at.success._tag === 'Value') input.at = at.success.value
  if (body.note !== undefined) input.note = body.note.trim().slice(0, 500)
  const repeat = body.repeatEveryMs
  if (repeat !== undefined) {
    if (
      repeat !== null &&
      (!Number.isSafeInteger(repeat) || repeat < 60_000 || repeat > MAX_REPEAT_MS)
    ) {
      return Result.fail(
        new InvalidFollowUpMutation({ message: 'Repeat must be between one minute and one year' }),
      )
    }
    input.repeatEveryMs = repeat
  }
  return Result.succeed(input)
}

app.get('/api/tasks', async (context) => {
  const rawStatus = context.req.query('status')
  const query = decodeIngress(TaskListQuery, rawStatus === undefined ? {} : { status: rawStatus })
  if (Result.isFailure(query)) return context.json({ error: 'Invalid status' }, 400)
  return context.json({ tasks: await listTaskViews(query.success.status) })
})

app.post('/api/tasks', async (context) => {
  const decoded = await decodeJsonBody(context, CreateTaskRequest)
  if (Result.isFailure(decoded)) return context.json({ error: 'Invalid Task' }, 400)
  const body = decoded.success
  const patch = taskPatchFrom(body)
  if (Result.isFailure(patch)) return context.json({ error: patch.failure.message }, 400)
  if (patch.success.title === undefined) return context.json({ error: 'Title is required' }, 400)
  const followUp = body.followUp === undefined ? null : followUpInputFrom(body.followUp)
  if (followUp !== null && Result.isFailure(followUp)) {
    return context.json({ error: followUp.failure.message }, 400)
  }
  if (followUp !== null && followUp.success.at === undefined) {
    return context.json({ error: 'A follow-up time is required' }, 400)
  }
  const task = await createTask({
    title: patch.success.title,
    detail: patch.success.detail,
    assignee: patch.success.assignee,
    dueAt: patch.success.dueAt,
    priority: patch.success.priority,
    origin: { kind: 'manual' },
    createdBy: 'you',
  })
  if (followUp !== null && Result.isSuccess(followUp) && followUp.success.at !== undefined) {
    await createFollowUp({
      taskId: task.id,
      at: followUp.success.at,
      note: followUp.success.note,
      repeatEveryMs: followUp.success.repeatEveryMs,
      createdBy: 'you',
    })
  }
  return context.json({ task: await getTaskView(task) }, 201)
})

app.patch('/api/tasks/:id', async (context) => {
  const params = decodeIngress(TaskParams, { id: context.req.param('id') })
  const decoded = await decodeJsonBody(context, PatchTaskRequest)
  if (Result.isFailure(params) || Result.isFailure(decoded))
    return context.json({ error: 'Invalid Task update' }, 400)
  const patch = taskPatchFrom(decoded.success)
  if (Result.isFailure(patch)) return context.json({ error: patch.failure.message }, 400)
  const task = await updateTask(params.success.id, patch.success)
  return task
    ? context.json({ task: await getTaskView(task) })
    : context.json({ error: 'Task not found' }, 404)
})

app.delete('/api/tasks/:id', async (context) => {
  const params = decodeIngress(TaskParams, { id: context.req.param('id') })
  if (Result.isFailure(params)) return context.json({ error: 'Task not found' }, 404)
  return (await deleteTask(params.success.id))
    ? context.body(null, 204)
    : context.json({ error: 'Task not found' }, 404)
})

app.post('/api/tasks/:id/nudge', async (context) => {
  const params = decodeIngress(TaskParams, { id: context.req.param('id') })
  if (Result.isFailure(params)) return context.json({ error: 'Task not found' }, 404)
  const task = await getTask(params.success.id)
  if (!task) return context.json({ error: 'Task not found' }, 404)
  if (task.status !== 'open') return context.json({ error: 'Only open tasks can be chased' }, 409)
  const decoded = await decodeJsonBody(context, NudgeTaskRequest, true)
  if (Result.isFailure(decoded)) return context.json({ error: 'Invalid nudge' }, 400)
  const note = decoded.success.note === undefined ? '' : decoded.success.note.trim().slice(0, 500)
  const chased = await runRuntimeEffect(
    chaseTaskNow(task, note.length > 0 ? note : 'You asked Vivid to chase this now.', 'you'),
  )
  if (Result.isFailure(chased)) return context.json({ error: 'Could not start the follow-up' }, 500)
  return context.json({ followUp: chased.success, task: await getTaskView(task) }, 202)
})

app.post('/api/tasks/:id/follow-ups', async (context) => {
  const params = decodeIngress(TaskParams, { id: context.req.param('id') })
  if (Result.isFailure(params)) return context.json({ error: 'Task not found' }, 404)
  const task = await getTask(params.success.id)
  if (!task) return context.json({ error: 'Task not found' }, 404)
  if (task.status !== 'open')
    return context.json({ error: 'Reopen the task before scheduling a follow-up' }, 409)
  const decoded = await decodeJsonBody(context, FollowUpInput)
  if (Result.isFailure(decoded)) return context.json({ error: 'Invalid follow-up' }, 400)
  const input = followUpInputFrom(decoded.success)
  if (Result.isFailure(input)) return context.json({ error: input.failure.message }, 400)
  if (input.success.at === undefined)
    return context.json({ error: 'A follow-up time is required' }, 400)
  const followUp = await createFollowUp({
    taskId: task.id,
    at: input.success.at,
    note: input.success.note,
    repeatEveryMs: input.success.repeatEveryMs,
    createdBy: 'you',
  })
  return context.json({ followUp, task: await getTaskView(task) }, 201)
})

app.patch('/api/follow-ups/:id', async (context) => {
  const params = decodeIngress(FollowUpParams, { id: context.req.param('id') })
  if (Result.isFailure(params)) return context.json({ error: 'Follow-up not found' }, 404)
  const current = await getFollowUp(params.success.id)
  if (!current) return context.json({ error: 'Follow-up not found' }, 404)
  const decoded = await decodeJsonBody(context, PatchFollowUpRequest)
  if (Result.isFailure(decoded)) return context.json({ error: 'Invalid follow-up update' }, 400)
  const body = decoded.success
  const input = followUpInputFrom(body)
  if (Result.isFailure(input)) return context.json({ error: input.failure.message }, 400)
  if (current.status === 'running')
    return context.json({ error: 'This follow-up is running right now' }, 409)
  const followUpPatch: Parameters<typeof updateFollowUp>[1] = { ...input.success }
  if (body.status !== undefined) followUpPatch.status = body.status
  else if (input.success.at !== undefined && current.status !== 'scheduled')
    followUpPatch.status = 'scheduled'
  const followUp = await updateFollowUp(current.id, followUpPatch)
  const task = followUp ? await getTask(followUp.taskId) : null
  return followUp && task
    ? context.json({ followUp, task: await getTaskView(task) })
    : context.json({ error: 'Follow-up not found' }, 404)
})

app.delete('/api/follow-ups/:id', async (context) => {
  const params = decodeIngress(FollowUpParams, { id: context.req.param('id') })
  if (Result.isFailure(params)) return context.json({ error: 'Follow-up not found' }, 404)
  return (await deleteFollowUp(params.success.id))
    ? context.body(null, 204)
    : context.json({ error: 'Follow-up not found' }, 404)
})

app.post('/api/follow-ups/:id/run', async (context) => {
  const params = decodeIngress(FollowUpParams, { id: context.req.param('id') })
  if (Result.isFailure(params)) return context.json({ error: 'Follow-up not found' }, 404)
  const started = await runRuntimeEffect(runFollowUpNow(params.success.id))
  if (Result.isFailure(started))
    return context.json({ error: 'Could not start the follow-up' }, 500)
  const followUp = started.success
  if (followUp === null) return context.json({ error: 'Follow-up not found' }, 404)
  const task = await getTask(followUp.taskId)
  return context.json({ followUp, task: task ? await getTaskView(task) : null }, 202)
})

app.get('/api/notifications', async (context) =>
  context.json({
    notifications: await listNotifications(),
    unreadCount: await unreadNotificationCount(),
  }),
)

app.post('/api/notifications/read', async (context) => {
  const decoded = await decodeJsonBody(context, ReadNotificationsRequest, true)
  if (Result.isFailure(decoded)) return context.json({ error: 'Invalid notification ids' }, 400)
  const changed = await markNotificationsRead(decoded.success.ids)
  return context.json({ changed, unreadCount: await unreadNotificationCount() })
})

app.route('/agents/vivid', createAgentRouter(Vivid))

export default app
