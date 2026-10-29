import * as Schema from 'effect/Schema'
import * as Rpc from 'effect/rpc/Rpc'
import * as RpcGroup from 'effect/rpc/RpcGroup'
import * as RpcMiddleware from 'effect/rpc/RpcMiddleware'
import { ConversationFrame } from './conversation.js'
import {
  ApprovalChanged,
  ApprovalExpired,
  ApprovalResponse,
  DecideApprovalRequest,
} from './approvals.js'
import {
  ArtifactChanged,
  ArtifactDetail,
  ArtifactListResponse,
  ArtifactResponse,
  GetArtifactRequest,
  ReadDocumentOutcome,
  ReadDocumentRequest,
  ReviseArtifactRequest,
  WriteDocumentOutcome,
  WriteDocumentRequest,
} from './artifacts.js'
import { AuditListResponse } from './audit.js'
import { ServerBuild } from './build.js'
import {
  FeedDisplayInvalid,
  FeedResponse,
  MarkFeedCardRequest,
  PostOutcome,
  PostRequest,
} from './feed.js'
import {
  NotifyPersonOutcome,
  NotifyPersonRequest,
  PushKeyResponse,
  PushTargetId,
  PushTargetListResponse,
  PushTargetResponse,
  RegisterPushTargetRequest,
} from './push.js'
import type { AuthContext } from './auth.js'
import {
  CreateWatchRequest,
  FindAppEventsRequest,
  FindAppEventsResponse,
  StopWatchRequest,
  WatchListResponse,
  WatchResponse,
} from './watches.js'
import {
  CodeOutcome,
  ReadPageOutcome,
  ReadPageRequest,
  RunCodeRequest,
  RunDisplayCodeRequest,
  DisplayProgramRefused,
  DisplayCodeOutcome,
} from './code.js'
import {
  AcceptMembershipRequest,
  ChangeRoleRequest,
  Company,
  CreateCompanyRequest,
  Invitation,
  InvitationPreview,
  InviteMembershipRequest,
  Member,
  MeResponse,
  PeopleResponse,
  SwitchWorkspaceRequest,
} from './companies.js'
import {
  AnswerDeviceRequest,
  DeviceId,
  DeviceListResponse,
  DeviceRequest,
  DeviceResponse,
  EnrolDeviceRequest,
  NoDeviceConnected,
  ReportDeviceStopRequest,
  WatchDeviceRequestsRequest,
  BrowseOutcome,
  BrowseRequest,
  DesktopOutcome,
  UseDesktopRequest,
  ComputerResponse,
  ComputerShellRequest,
  ComputerShellOutcome,
  ComputerFileReadRequest,
  ComputerFileReadOutcome,
  ComputerFileWriteRequest,
  ComputerFileWriteOutcome,
} from './computers.js'
import {
  Channel,
  ChannelFailure,
  ChannelLinkResponse,
  ChannelListResponse,
  ConnectChannelRequest,
} from './channels.js'
import { UseWindowRequest, WindowOutcome } from './windows.js'
import { CopySignInRequest, CopySignInOutcome } from './signins.js'
import { DraftListResponse, DraftSaved, SaveDraftRequest } from './drafts.js'
import {
  ACCOUNT_HANDLE_MAX,
  AddIntegrationRequest,
  AddIntegrationOutcome,
  MakeIntegrationRequest,
  MakeIntegrationOutcome,
  FindIntegrationsRequest,
  FindIntegrationsResponse,
  TestIntegrationRequest,
  TestIntegrationOutcome,
  BeginConnectionRequest,
  SignInSurface,
  CompleteConnectionRequest,
  ConnectionListResponse,
  ConnectionOffer,
  ConnectionResponse,
  ConnectionStep,
  ConnectionTool,
  FindServicesRequest,
  FindToolsRequest,
  FindToolsResponse,
  OfferConnectionRequest,
  RenameConnectionRequest,
  ServiceCatalog,
  ToolOutcome,
  UseDisplayToolRequest,
  DisplayApprovalUnsupported,
  UseToolRequest,
} from './connections.js'
import {
  Conflict,
  DatabaseConstraintViolation,
  DatabaseFailure,
  DatabaseUnavailable,
  Forbidden,
  InvalidRequest,
  MailboxUnconfirmed,
  NotFound,
  RuntimeUnavailable,
  ServiceUnavailable,
  Unauthenticated,
} from './failures.js'
import {
  ArtifactId,
  ApprovalId,
  ConnectionId,
  InvitationId,
  InputRequestId,
  LibraryFolderId,
  LibraryItemId,
  MembershipId,
  PersonName,
  RuleId,
  SkillId,
  ThreadId,
} from './identity.js'
import { AnswerInputRequest, AskInputRequest, InputRequestResponse } from './inputs.js'
import {
  CreateLibraryFolderRequest,
  LibraryFolderListResponse,
  LibraryFolderResponse,
  LibraryItemResponse,
  LibraryListQuery,
  LibraryListResponse,
  LibrarySearchRequest,
  LibrarySearchResponse,
  PatchLibraryFolderRequest,
  PatchLibraryItemRequest,
} from './library.js'
import {
  CorrectMemoryRequest,
  ForgetMemoryRequest,
  MemoryForgetId,
  MemoryForgetPlan,
  MemoryForgetReceipt,
  MemoryForgetStale,
  PlanMemoryForgetRequest,
  MemoryAddress,
  MemoryIndex,
  MemoryListing,
  MemoryPage,
  SavedMemory,
} from './memory.js'
import {
  NotificationListResponse,
  NotificationReadResponse,
  ReadNotificationsRequest,
} from './notifications.js'
import {
  CreateProjectRequest,
  Project,
  ProjectChanged,
  ProjectEvidenceMissing,
  ProjectListResponse,
  ProjectNotActive,
  UpdateProjectRequest,
} from './projects.js'
import {
  Owed,
  OwedListResponse,
  TrackOwedRequest,
  UpdateOwedRequest,
  NudgedOwedRequest,
  ResolveOwedRequest,
  DropOwedRequest,
} from './owed.js'
import {
  Todo,
  TodoListResponse,
  AddTodoRequest,
  CompleteTodoRequest,
  DropTodoRequest,
} from './todos.js'
import { ComputerInventory } from './applications.js'
import { CreateRuleRequest, RuleListResponse, RuleResponse } from './rules.js'
import { SearchRequest, SearchResponse, SuggestionListResponse } from './search.js'
import { Appearance } from './appearance.js'
import { EgressStatus } from './egress.js'
import { PatchSettingsRequest, Settings } from './settings.js'
import {
  SkillReadOnly,
  PatchSkillRequest,
  SaveSkillRequest,
  SkillListResponse,
  SkillResponse,
  SkillSummaryListResponse,
} from './skills.js'
import {
  CreateThreadRequest,
  OpenFirstThreadResult,
  Inbox,
  PatchThreadRequest,
  PresenceRequest,
  ShareThreadRequest,
  ThreadDetail,
  ConversationTooLarge,
  SendToThreadRequest,
  CarryOnRequest,
  SendToThreadResponse,
  UnsupportedAttachment,
  InvalidAttachment,
  AttachmentTooLarge,
  TooManyAttachments,
  PicturesRequirePrivateThread,
  ThreadListResponse,
  ThreadResponse,
  ThreadTitleHistoryUnavailable,
  ThreadTitleModelUnavailable,
  ThreadTitleOutputInvalid,
  DeliveryScope,
  DeliveryScopeRequest,
} from './threads.js'

/**
 * Every product call a Vivid client makes to the application server, declared once.
 *
 * The server implements this group; web, mobile, desktop and the runtime's tools all derive
 * their client from it with `RpcClient.make(VividRpc)`. No client writes a path, a method, a
 * response type or a status check by hand, so a changed payload or a renamed call is a compile
 * error in every consumer.
 *
 * **Every read is live.** A read is declared twice from the same payload and result: `ListThings`
 * answers once, and `WatchThings` is a stream that answers with the current result and then again
 * each time that result changes. Clients subscribe to the `Watch` form over one socket and never
 * refetch; the runtime's tools, which want one answer, use the plain form. A handler implements
 * both from one loader, so the two cannot disagree.
 *
 * Only three kinds of route stay plain HTTP, because a browser or a third party calls them
 * without our client: Better Auth (`/api/auth/*`), the address a provider or an outside service
 * calls back to, and byte transfer (Library upload and download). The conversation itself is
 * runtime state, which the server proxies at `/api/vivid/*`.
 */

export { InvalidRequest, RuntimeUnavailable, ServiceUnavailable } from './failures.js'

/** Every failure a product call can return. Clients branch on `_tag`, never on a message. */
export const RpcFailure = Schema.Union([
  ConversationTooLarge,
  Unauthenticated,
  Forbidden,
  NotFound,
  Conflict,
  InvalidRequest,
  RuntimeUnavailable,
  ServiceUnavailable,
  DatabaseConstraintViolation,
  DatabaseUnavailable,
  DatabaseFailure,
])
export type RpcFailure = typeof RpcFailure.Type

/** Authenticates every RPC and provides the request-local identity to its handler. */
export class RpcAuthMiddleware extends RpcMiddleware.Service<
  RpcAuthMiddleware,
  { provides: AuthContext; requires: never }
>()('vivid/RpcAuthMiddleware', { error: RpcFailure }) {}

const call = { error: RpcFailure } as const
const live = { error: RpcFailure, stream: true } as const

/** Push registration is session-scoped; NotifyPerson is runtime-only at the handler boundary. */
const RegisterPushTarget = Rpc.make('RegisterPushTarget', {
  ...call,
  payload: RegisterPushTargetRequest,
  success: PushTargetResponse,
})
const ListPushTargets = Rpc.make('ListPushTargets', { ...call, success: PushTargetListResponse })
const WatchPushTargets = Rpc.make('WatchPushTargets', { ...live, success: PushTargetListResponse })
const RemovePushTarget = Rpc.make('RemovePushTarget', { ...call, payload: { id: PushTargetId } })
const GetPushKey = Rpc.make('GetPushKey', { ...call, success: PushKeyResponse })
const NotifyPerson = Rpc.make('NotifyPerson', {
  ...call,
  payload: NotifyPersonRequest,
  success: NotifyPersonOutcome,
})

// ── The Feed ───────────────────────────────────────────────────────────────
/** A Person's own Feed; Post is runtime-only at the handler boundary, like NotifyPerson. */
const ListFeed = Rpc.make('ListFeed', { ...call, success: FeedResponse })
const WatchFeed = Rpc.make('WatchFeed', { ...live, success: FeedResponse })
const MarkFeedCard = Rpc.make('MarkFeedCard', { ...call, payload: MarkFeedCardRequest })
const Post = Rpc.make('Post', {
  ...call,
  error: Schema.Union([RpcFailure, FeedDisplayInvalid]),
  payload: PostRequest,
  success: PostOutcome,
})

// ── The signed-in Person and where they are working ────────────────────────
const Me = Rpc.make('Me', { ...call, success: MeResponse })
const WatchMe = Rpc.make('WatchMe', { ...live, success: MeResponse })
/**
 * What the signed-in Person is called, changed by them in Settings. Vivid reads the name through
 * `Me` at the start of each response, so the next answer uses it. Only the Person can change it.
 */
const SetPersonName = Rpc.make('SetPersonName', {
  ...call,
  payload: { name: PersonName },
  success: MeResponse,
})
/** Creates a Company on purpose and moves the session into it. */
const CreateCompany = Rpc.make('CreateCompany', {
  ...call,
  payload: CreateCompanyRequest,
  success: Company,
})
const SwitchWorkspace = Rpc.make('SwitchWorkspace', {
  ...call,
  payload: { to: SwitchWorkspaceRequest },
  success: MeResponse,
})
/** The build of the server that is answering (`build.ts`), for Settings to say beside its own. */
const GetBuild = Rpc.make('GetBuild', { ...call, success: ServerBuild })
const WatchBuild = Rpc.make('WatchBuild', { ...live, success: ServerBuild })
const GetSettings = Rpc.make('GetSettings', { ...call, success: Settings })
const WatchSettings = Rpc.make('WatchSettings', { ...live, success: Settings })
const PatchSettings = Rpc.make('PatchSettings', {
  ...call,
  payload: PatchSettingsRequest,
  success: Settings,
})
/**
 * What Vivid is called and how it looks where the caller is working. Vivid reads it too, to know
 * the name the Person it acts for gave it.
 */
const GetAppearance = Rpc.make('GetAppearance', { ...call, success: Appearance })
const WatchAppearance = Rpc.make('WatchAppearance', { ...live, success: Appearance })
/** The Person's own choice in a personal space; an owner's or admin's in a Company. */
const SetAppearance = Rpc.make('SetAppearance', {
  ...call,
  payload: Appearance,
  success: Appearance,
})

// ── People in a Company ────────────────────────────────────────────────────
const ListPeople = Rpc.make('ListPeople', { ...call, success: PeopleResponse })
const WatchPeople = Rpc.make('WatchPeople', { ...live, success: PeopleResponse })
const InviteMember = Rpc.make('InviteMember', {
  ...call,
  payload: InviteMembershipRequest,
  success: Invitation,
})
const RevokeInvitation = Rpc.make('RevokeInvitation', { ...call, payload: { id: InvitationId } })
/** What an invited Person sees before accepting. Callable by anyone signed in who holds the id. */
const PreviewInvitation = Rpc.make('PreviewInvitation', {
  ...call,
  payload: { id: InvitationId },
  success: InvitationPreview,
})
/**
 * Joins the Company an invitation names. `MailboxUnconfirmed` is this call's own refusal: the
 * invited address is the caller's, but nothing has shown that they receive its mail.
 */
const AcceptInvitation = Rpc.make('AcceptInvitation', {
  error: Schema.Union([RpcFailure, MailboxUnconfirmed]),
  payload: AcceptMembershipRequest,
  success: MeResponse,
})
const ChangeRole = Rpc.make('ChangeRole', { ...call, payload: ChangeRoleRequest, success: Member })
const RemoveMember = Rpc.make('RemoveMember', {
  ...call,
  payload: { membershipId: MembershipId },
})
/** Leaves the active Company and returns the session to the personal space. */
const LeaveCompany = Rpc.make('LeaveCompany', { ...call, success: MeResponse })

// ── Threads ────────────────────────────────────────────────────────────────
const ListThreads = Rpc.make('ListThreads', { ...call, success: ThreadListResponse })
const WatchThreads = Rpc.make('WatchThreads', { ...live, success: ThreadListResponse })
const GetThread = Rpc.make('GetThread', {
  ...call,
  payload: { id: ThreadId },
  success: ThreadDetail,
})
const WatchThread = Rpc.make('WatchThread', {
  ...live,
  payload: { id: ThreadId },
  success: ThreadDetail,
})
/** A Thread's conversation: one `Whole` on every subscription, then its changes. */
const WatchConversation = Rpc.make('WatchConversation', {
  ...live,
  payload: { threadId: ThreadId },
  success: ConversationFrame,
})
/** One send from a Person's client; it answers once the runtime admitted the delivery. */
const SendToThread = Rpc.make('SendToThread', {
  payload: SendToThreadRequest,
  success: SendToThreadResponse,
  error: Schema.Union([
    RpcFailure,
    UnsupportedAttachment,
    InvalidAttachment,
    AttachmentTooLarge,
    TooManyAttachments,
    PicturesRequirePrivateThread,
  ]),
})
/** A connection card's continuation uses the same authenticated socket as ordinary sends. */
const CarryOnThread = Rpc.make('CarryOnThread', {
  ...call,
  payload: CarryOnRequest,
})
const CreateThread = Rpc.make('CreateThread', {
  ...call,
  payload: CreateThreadRequest,
  success: ThreadResponse,
})
/** The signed-in Person and active workspace are the whole input; Vivid speaks first. */
const OpenFirstThread = Rpc.make('OpenFirstThread', {
  ...call,
  success: OpenFirstThreadResult,
})
const PatchThread = Rpc.make('PatchThread', {
  ...call,
  payload: { id: ThreadId, patch: PatchThreadRequest },
  success: ThreadResponse,
})
/** Explicit naming uses the same visibility/rename authority as PatchThread. */
const RegenerateThreadTitle = Rpc.make('RegenerateThreadTitle', {
  ...call,
  payload: { thread: ThreadId },
  success: Schema.Struct({ title: Schema.String }),
  error: Schema.Union([
    RpcFailure,
    ThreadTitleHistoryUnavailable,
    ThreadTitleModelUnavailable,
    ThreadTitleOutputInvalid,
  ]),
})
const ShareThread = Rpc.make('ShareThread', {
  ...call,
  payload: { id: ThreadId, audience: ShareThreadRequest },
  success: ThreadResponse,
})
const DeleteThread = Rpc.make('DeleteThread', { ...call, payload: { id: ThreadId } })
/** Records that the Person has seen the Thread as it stands, which clears `Unread`. */
const MarkThreadRead = Rpc.make('MarkThreadRead', { ...call, payload: { id: ThreadId } })
/** Stops the Run in progress. Work already done is not undone. */
const StopThread = Rpc.make('StopThread', { ...call, payload: { id: ThreadId } })
/**
 * Holds the Person present in a Thread for as long as the call stays open on the live socket. It
 * answers nothing; closing it is how a client says the Person left.
 */
const BePresent = Rpc.make('BePresent', { ...live, payload: PresenceRequest })
/**
 * The runtime asking who a delivery is for, by the turn the conversation names. Only the runtime
 * may ask, and it asks only when it no longer holds the scope it was handed with the delivery (it
 * restarted in the middle of a response). No Person's client can call this.
 */
const GetDeliveryScope = Rpc.make('GetDeliveryScope', {
  ...call,
  payload: DeliveryScopeRequest,
  success: DeliveryScope,
})

// ── Artifacts ──────────────────────────────────────────────────────────────
const ListArtifacts = Rpc.make('ListArtifacts', {
  ...call,
  payload: { threadId: ThreadId },
  success: ArtifactListResponse,
})
const WatchArtifacts = Rpc.make('WatchArtifacts', {
  ...live,
  payload: { threadId: ThreadId },
  success: ArtifactListResponse,
})
const GetArtifact = Rpc.make('GetArtifact', {
  ...call,
  payload: GetArtifactRequest,
  success: ArtifactDetail,
})
const ReviseArtifact = Rpc.make('ReviseArtifact', {
  ...call,
  payload: ReviseArtifactRequest,
  success: ArtifactResponse,
  error: Schema.Union([RpcFailure, ArtifactChanged]),
})
const RemoveArtifact = Rpc.make('RemoveArtifact', { ...call, payload: { id: ArtifactId } })
/** The server attributes a write to the authenticated Thread’s working Run; no model identifier is needed. */
const WriteDocument = Rpc.make('WriteDocument', {
  ...call,
  payload: WriteDocumentRequest,
  success: WriteDocumentOutcome,
})
const ReadDocument = Rpc.make('ReadDocument', {
  ...call,
  payload: ReadDocumentRequest,
  success: ReadDocumentOutcome,
})

// ── What is waiting on the Person: questions and Approvals ─────────────────
const GetInbox = Rpc.make('GetInbox', { ...call, success: Inbox })
const WatchInbox = Rpc.make('WatchInbox', { ...live, success: Inbox })
const DecideApproval = Rpc.make('DecideApproval', {
  payload: DecideApprovalRequest,
  success: ApprovalResponse,
  error: Schema.Union([RpcFailure, ApprovalChanged, ApprovalExpired]),
})
/** Withdraws an Approval the Person no longer wants decided, leaving the action undone. */
const WithdrawApproval = Rpc.make('WithdrawApproval', { ...call, payload: { id: ApprovalId } })
/** Vivid asking a question it cannot safely answer alone. The turn ends until it is answered. */
const AskInput = Rpc.make('AskInput', {
  ...call,
  payload: AskInputRequest,
  success: InputRequestResponse,
})
/** Answer refusals name the request and question position, never echo supplied answer text. */
const inputAnswerContext = { id: InputRequestId, questionIndex: Schema.Int }

/** Every question needs one answer. */
export class InputAnswerCountMismatch extends Schema.TaggedError<InputAnswerCountMismatch>()(
  'InputAnswerCountMismatch',
  {
    id: InputRequestId,
    expected: Schema.Int,
    received: Schema.Int,
    message: Schema.Literal('Every question needs one answer.'),
  },
  { title: 'Answer count mismatch' },
) {}

/** Choose only options offered for this question. */
export class InputAnswerUnknownLabel extends Schema.TaggedError<InputAnswerUnknownLabel>()(
  'InputAnswerUnknownLabel',
  {
    ...inputAnswerContext,
    message: Schema.Literal('Choose only options offered for this question.'),
  },
  { title: 'Unknown answer option' },
) {}

/** Choose one option for this question. */
export class InputAnswerSeveralForbidden extends Schema.TaggedError<InputAnswerSeveralForbidden>()(
  'InputAnswerSeveralForbidden',
  { ...inputAnswerContext, message: Schema.Literal('Choose one option for this question.') },
  { title: 'Multiple choices forbidden' },
) {}

/** Choose each option only once. */
export class InputAnswerRepeatedLabel extends Schema.TaggedError<InputAnswerRepeatedLabel>()(
  'InputAnswerRepeatedLabel',
  { ...inputAnswerContext, message: Schema.Literal('Choose each option only once.') },
  { title: 'Repeated answer option' },
) {}

/** Choose an offered option for this question. */
export class InputAnswerWrittenForbidden extends Schema.TaggedError<InputAnswerWrittenForbidden>()(
  'InputAnswerWrittenForbidden',
  { ...inputAnswerContext, message: Schema.Literal('Choose an offered option for this question.') },
  { title: 'Written answer forbidden' },
) {}

/** Write an answer for this question. */
export class InputAnswerEmptyWords extends Schema.TaggedError<InputAnswerEmptyWords>()(
  'InputAnswerEmptyWords',
  { ...inputAnswerContext, message: Schema.Literal('Write an answer for this question.') },
  { title: 'Empty written answer' },
) {}

/** The closed answer-validation failures shared by the store and its RPC transport. */
export const InputAnswerFailure = Schema.Union([
  InputAnswerCountMismatch,
  InputAnswerUnknownLabel,
  InputAnswerSeveralForbidden,
  InputAnswerRepeatedLabel,
  InputAnswerWrittenForbidden,
  InputAnswerEmptyWords,
])
export type InputAnswerFailure = typeof InputAnswerFailure.Type

const AnswerInput = Rpc.make('AnswerInput', {
  ...call,
  error: Schema.Union([RpcFailure, InputAnswerFailure]),
  payload: AnswerInputRequest,
  success: InputRequestResponse,
})

// ── Rules and the audit record ─────────────────────────────────────────────
const ListRules = Rpc.make('ListRules', { ...call, success: RuleListResponse })
const WatchRules = Rpc.make('WatchRules', { ...live, success: RuleListResponse })
const CreateRule = Rpc.make('CreateRule', {
  ...call,
  payload: CreateRuleRequest,
  success: RuleResponse,
})
const DeleteRule = Rpc.make('DeleteRule', { ...call, payload: { id: RuleId } })
const ListAudit = Rpc.make('ListAudit', { ...call, success: AuditListResponse })
const WatchAudit = Rpc.make('WatchAudit', { ...live, success: AuditListResponse })

// ── Notifications ──────────────────────────────────────────────────────────
const ListNotifications = Rpc.make('ListNotifications', {
  ...call,
  success: NotificationListResponse,
})
const WatchNotifications = Rpc.make('WatchNotifications', {
  ...live,
  success: NotificationListResponse,
})
const ReadNotifications = Rpc.make('ReadNotifications', {
  ...call,
  payload: ReadNotificationsRequest,
  success: NotificationReadResponse,
})

// ── Watches ────────────────────────────────────────────────────────────────
/** The events an Integration's app declares, named by the account the Person was shown. */
const FindAppEvents = Rpc.make('FindAppEvents', {
  ...call,
  payload: FindAppEventsRequest,
  success: FindAppEventsResponse,
})
/** Subscribe to one of those events for the acting Person; each event wakes Vivid. */
const CreateWatch = Rpc.make('CreateWatch', {
  ...call,
  payload: CreateWatchRequest,
  success: WatchResponse,
})
const ListWatches = Rpc.make('ListWatches', { ...call, success: WatchListResponse })
const StopWatch = Rpc.make('StopWatch', {
  ...call,
  payload: StopWatchRequest,
  success: WatchResponse,
})

// ── Projects ───────────────────────────────────────────────────────────────
const ListProjects = Rpc.make('ListProjects', { ...call, success: ProjectListResponse })
const WatchProjects = Rpc.make('WatchProjects', { ...live, success: ProjectListResponse })
const CreateProject = Rpc.make('CreateProject', {
  ...call,
  payload: CreateProjectRequest,
  success: Project,
})
/** Vivid recording a Project's objective, progress or completion, against the revision it read. */
const UpdateProject = Rpc.make('UpdateProject', {
  payload: UpdateProjectRequest,
  success: Project,
  error: Schema.Union([RpcFailure, ProjectChanged, ProjectNotActive, ProjectEvidenceMissing]),
})

// ── Waiting on ────────────────────────────────────────────────────────────
const ListOwed = Rpc.make('ListOwed', { ...call, success: OwedListResponse })
const WatchOwed = Rpc.make('WatchOwed', { ...live, success: OwedListResponse })
const TrackOwed = Rpc.make('TrackOwed', { ...call, payload: TrackOwedRequest, success: Owed })
const UpdateOwed = Rpc.make('UpdateOwed', { ...call, payload: UpdateOwedRequest, success: Owed })
const NudgedOwed = Rpc.make('NudgedOwed', { ...call, payload: NudgedOwedRequest, success: Owed })
const ResolveOwed = Rpc.make('ResolveOwed', { ...call, payload: ResolveOwedRequest, success: Owed })
const DropOwed = Rpc.make('DropOwed', { ...call, payload: DropOwedRequest, success: Owed })

// ── The Person's to-do list ───────────────────────────────────────────────
const ListTodos = Rpc.make('ListTodos', { ...call, success: TodoListResponse })
const WatchTodos = Rpc.make('WatchTodos', { ...live, success: TodoListResponse })
const AddTodo = Rpc.make('AddTodo', { ...call, payload: AddTodoRequest, success: Todo })
const CompleteTodo = Rpc.make('CompleteTodo', {
  ...call,
  payload: CompleteTodoRequest,
  success: Todo,
})
const DropTodo = Rpc.make('DropTodo', { ...call, payload: DropTodoRequest, success: Todo })

// ── Library (metadata; bytes travel over plain HTTP) ───────────────────────
const ListLibrary = Rpc.make('ListLibrary', {
  ...call,
  payload: LibraryListQuery,
  success: LibraryListResponse,
})
const WatchLibrary = Rpc.make('WatchLibrary', {
  ...live,
  payload: LibraryListQuery,
  success: LibraryListResponse,
})
const GetLibraryItem = Rpc.make('GetLibraryItem', {
  ...call,
  payload: { id: LibraryItemId },
  success: LibraryItemResponse,
})
const PatchLibraryItem = Rpc.make('PatchLibraryItem', {
  ...call,
  payload: { id: LibraryItemId, patch: PatchLibraryItemRequest },
  success: LibraryItemResponse,
})
const DeleteLibraryItem = Rpc.make('DeleteLibraryItem', {
  ...call,
  payload: { id: LibraryItemId },
})
const SearchLibrary = Rpc.make('SearchLibrary', {
  ...call,
  payload: LibrarySearchRequest,
  success: LibrarySearchResponse,
})
const ListLibraryFolders = Rpc.make('ListLibraryFolders', {
  ...call,
  success: LibraryFolderListResponse,
})
const CreateLibraryFolder = Rpc.make('CreateLibraryFolder', {
  ...call,
  payload: CreateLibraryFolderRequest,
  success: LibraryFolderResponse,
})
const PatchLibraryFolder = Rpc.make('PatchLibraryFolder', {
  ...call,
  payload: { id: LibraryFolderId, patch: PatchLibraryFolderRequest },
  success: LibraryFolderResponse,
})
const DeleteLibraryFolder = Rpc.make('DeleteLibraryFolder', {
  ...call,
  payload: { id: LibraryFolderId },
})

/** URL integration discovery/import/testing share the existing attributed Connection boundary. */
const FindIntegrations = Rpc.make('FindIntegrations', {
  ...call,
  payload: FindIntegrationsRequest,
  success: FindIntegrationsResponse,
})
const AddIntegration = Rpc.make('AddIntegration', {
  ...call,
  payload: AddIntegrationRequest,
  success: AddIntegrationOutcome,
})
const TestIntegration = Rpc.make('TestIntegration', {
  ...call,
  payload: TestIntegrationRequest,
  success: TestIntegrationOutcome,
})
const MakeIntegration = Rpc.make('MakeIntegration', {
  ...call,
  payload: MakeIntegrationRequest,
  success: MakeIntegrationOutcome,
})

// ── Connections (a provider's sign-in redirect returns over plain HTTP) ────
const ListConnections = Rpc.make('ListConnections', { ...call, success: ConnectionListResponse })
const WatchConnections = Rpc.make('WatchConnections', {
  ...live,
  success: ConnectionListResponse,
})
/** A Person looking through the catalog for a service to connect. */
const FindServices = Rpc.make('FindServices', {
  ...call,
  payload: FindServicesRequest,
  success: ServiceCatalog,
})
const BeginConnection = Rpc.make('BeginConnection', {
  ...call,
  payload: BeginConnectionRequest,
  success: ConnectionStep,
})
const CompleteConnection = Rpc.make('CompleteConnection', {
  ...call,
  payload: CompleteConnectionRequest,
  success: ConnectionResponse,
})
/**
 * Picking a Connection up where it stopped: the sign-in tab was closed, the key dialog was
 * cancelled, or the authorization lapsed. It answers with the same next step beginning one does,
 * for the Connection that already exists, so finishing it never leaves a second account behind.
 * Only whoever may remove the Connection may resume it.
 */
const ResumeConnection = Rpc.make('ResumeConnection', {
  ...call,
  payload: { id: ConnectionId, from: SignInSurface },
  success: ConnectionStep,
})
const RemoveConnection = Rpc.make('RemoveConnection', { ...call, payload: { id: ConnectionId } })
/**
 * A Person naming one of their accounts ("Work"), so they and Vivid can tell it from their others
 * on the same service. Only whoever may remove the Connection may name it.
 */
const RenameConnection = Rpc.make('RenameConnection', {
  ...call,
  payload: RenameConnectionRequest,
  success: ConnectionResponse,
})
/** Vivid looking for what it can do, limited to what the acting Person may use in this Thread. */
const FindTools = Rpc.make('FindTools', {
  ...call,
  payload: FindToolsRequest,
  success: FindToolsResponse,
})
/**
 * The one tool an account offers under a name, exactly. Vivid names a tool by the account and
 * tool it was shown, never by an identifier, and a search is the wrong way to turn that pair back
 * into a tool: a search ranks, pages, and can leave the wanted one off the end. This answers for
 * the pair itself, under the acting Person's access, or says it is not there.
 */
const ResolveTool = Rpc.make('ResolveTool', {
  ...call,
  payload: {
    account: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(ACCOUNT_HANDLE_MAX)),
    tool: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(200)),
  },
  success: ConnectionTool,
})
/** Vivid asking to do one thing through a Connection. The server decides whether it happens. */
const UseTool = Rpc.make('UseTool', { ...call, payload: UseToolRequest, success: ToolOutcome })
/** A display's Query or Mutation, run for the Person who is looking at it. */
const UseDisplayTool = Rpc.make('UseDisplayTool', {
  ...call,
  error: Schema.Union([RpcFailure, DisplayApprovalUnsupported]),
  payload: UseDisplayToolRequest,
  success: ToolOutcome,
})
/** Vivid offering a service in the Thread, with the acting Person's real state for it. */
const OfferConnection = Rpc.make('OfferConnection', {
  ...call,
  payload: OfferConnectionRequest,
  success: ConnectionOffer,
})

// ── Memory ─────────────────────────────────────────────────────────────────
// The acting Person's own memory, read from and written to their cell.
/** What Vivid reads every response: the standing pages whole and the newest lines. */
const GetMemoryIndex = Rpc.make('GetMemoryIndex', { ...call, success: MemoryIndex })
/** Older lines than the index shows, newest first, one layer or all. */
const ListMemory = Rpc.make('ListMemory', { ...call, payload: MemoryListing, success: MemoryPage })
const ReadMemory = Rpc.make('ReadMemory', { ...call, payload: MemoryAddress, success: SavedMemory })
const CorrectMemory = Rpc.make('CorrectMemory', {
  ...call,
  payload: CorrectMemoryRequest,
  success: SavedMemory,
})
/** Vivid's forget plan, checked against the acting Person's memory, Watches and owed records. */
const PlanMemoryForget = Rpc.make('PlanMemoryForget', {
  ...call,
  payload: PlanMemoryForgetRequest,
  success: MemoryForgetPlan,
})
/** Carry out a confirmed plan, or hand a Settings Forget press to Vivid; answers the receipt. */
const ForgetMemory = Rpc.make('ForgetMemory', {
  payload: ForgetMemoryRequest,
  success: MemoryForgetReceipt,
  error: Schema.Union([RpcFailure, MemoryForgetStale]),
})
/** One forget's receipt, live: Settings shows Pending until Vivid's background Run settles. */
const WatchMemoryForget = Rpc.make('WatchMemoryForget', {
  ...live,
  payload: { id: MemoryForgetId },
  success: MemoryForgetReceipt,
})

// ── Skills ─────────────────────────────────────────────────────────────────
const ListSkills = Rpc.make('ListSkills', { ...call, success: SkillListResponse })
const WatchSkills = Rpc.make('WatchSkills', { ...live, success: SkillListResponse })
/** The names and "use when" lines Vivid chooses from, without the full text of each. */
const ListSkillSummaries = Rpc.make('ListSkillSummaries', {
  ...call,
  success: SkillSummaryListResponse,
})
const ReadSkill = Rpc.make('ReadSkill', {
  ...call,
  payload: { id: SkillId },
  success: SkillResponse,
})
const SaveSkill = Rpc.make('SaveSkill', {
  ...call,
  payload: SaveSkillRequest,
  success: SkillResponse,
})
const PatchSkill = Rpc.make('PatchSkill', {
  ...call,
  error: Schema.Union([RpcFailure, SkillReadOnly]),
  payload: { id: SkillId, patch: PatchSkillRequest },
  success: SkillResponse,
})
const DeleteSkill = Rpc.make('DeleteSkill', {
  ...call,
  error: Schema.Union([RpcFailure, SkillReadOnly]),
  payload: { id: SkillId },
})

// ── The Computer ───────────────────────────────────────────────────────────
const GetComputer = Rpc.make('GetComputer', { ...call, success: ComputerResponse })
const GetComputerApps = Rpc.make('GetComputerApps', { ...call, success: ComputerInventory })
const WatchComputer = Rpc.make('WatchComputer', { ...live, success: ComputerResponse })
/**
 * What egress is doing for the caller right now (`egress.ts`). Whether it is on is the Person's
 * own setting (`Settings.egress`); this is what came of it.
 */
const GetEgress = Rpc.make('GetEgress', { ...call, success: EgressStatus })
const WatchEgress = Rpc.make('WatchEgress', { ...live, success: EgressStatus })
const StartComputer = Rpc.make('StartComputer', { ...call, success: ComputerResponse })
const StopComputer = Rpc.make('StopComputer', { ...call, success: ComputerResponse })
/** A Person taking the keyboard and pointer, or handing them back. Vivid cannot act while held. */
const HoldComputer = Rpc.make('HoldComputer', {
  ...call,
  payload: { held: Schema.Boolean },
  success: ComputerResponse,
})
/** Vivid's own shell and files on the acting Person's Computer; runtime-only at the handler. */
const ComputerShell = Rpc.make('ComputerShell', {
  ...call,
  payload: ComputerShellRequest,
  success: ComputerShellOutcome,
})
const ComputerFileRead = Rpc.make('ComputerFileRead', {
  ...call,
  payload: ComputerFileReadRequest,
  success: ComputerFileReadOutcome,
})
const ComputerFileWrite = Rpc.make('ComputerFileWrite', {
  ...call,
  payload: ComputerFileWriteRequest,
  success: ComputerFileWriteOutcome,
})
const Browse = Rpc.make('Browse', {
  ...call,
  payload: BrowseRequest,
  success: BrowseOutcome,
  error: Schema.Union([RpcFailure, NoDeviceConnected]),
})
// ── Channels: texting Vivid from a messaging app ───────────────────────────
/** Every channel and where it stands for the signed-in Person. */
const WatchChannels = Rpc.make('WatchChannels', { ...live, success: ChannelListResponse })
/**
 * Enrols the Person's own number and starts confirming it. The channel is theirs only after the
 * code arrives from that number; until then it stands as `Confirming`.
 */
const ConnectChannel = Rpc.make('ConnectChannel', {
  ...call,
  payload: ConnectChannelRequest,
  success: ChannelLinkResponse,
  error: Schema.Union([RpcFailure, ChannelFailure]),
})
/** Removes the Person's number from the channel, and its enrolment with the provider. */
const DisconnectChannel = Rpc.make('DisconnectChannel', {
  ...call,
  payload: { channel: Channel },
  success: ChannelLinkResponse,
  error: Schema.Union([RpcFailure, ChannelFailure]),
})
// ── Drafts: unsent words that follow the Person across devices ─────────────
/** The Person's drafts in this workspace. Emits again whenever any device saves or clears one. */
const WatchDrafts = Rpc.make('WatchDrafts', { ...live, success: DraftListResponse })
/**
 * Keeps, replaces or (with empty text) removes the draft of one place. A Thread the caller cannot
 * see is `NotFound`, as everywhere.
 */
const SaveDraft = Rpc.make('SaveDraft', {
  ...call,
  payload: SaveDraftRequest,
  success: DraftSaved,
})
// ── The Person's own computers ─────────────────────────────────────────────
/** The desktop app naming itself after sign-in. The same installation always gets the same Device. */
const EnrolDevice = Rpc.make('EnrolDevice', {
  ...call,
  payload: EnrolDeviceRequest,
  success: DeviceResponse,
})
const ListDevices = Rpc.make('ListDevices', { ...call, success: DeviceListResponse })
/** The same owned list, kept current as access and desktop presence change on any device. */
const WatchDevices = Rpc.make('WatchDevices', { ...live, success: DeviceListResponse })
/** Lets Vivid use this computer and, in the same step, no other computer of this Person. */
const AllowDevice = Rpc.make('AllowDevice', {
  ...call,
  payload: { id: DeviceId },
  success: DeviceResponse,
})
const RevokeDevice = Rpc.make('RevokeDevice', {
  ...call,
  payload: { id: DeviceId },
  success: DeviceResponse,
})
/** The desktop app saying its Person stopped Vivid between two actions of a Run. */
const ReportDeviceStop = Rpc.make('ReportDeviceStop', {
  ...call,
  payload: ReportDeviceStopRequest,
})
/** One action in an app on the Person's own computer; the answer is the window after it. */
const UseWindow = Rpc.make('UseWindow', {
  ...call,
  payload: UseWindowRequest,
  success: WindowOutcome,
})
/** One explicit site's sign-in. Cookies stay inside the device and Computer channel. */
const CopySignIn = Rpc.make('CopySignIn', {
  ...call,
  payload: CopySignInRequest,
  success: CopySignInOutcome,
})
/**
 * The desktop app listening for work. Holding this open is what makes its Device `Connected`;
 * only the installation that enrolled an allowed Device may hold it, and nothing sent while it
 * was closed is sent again.
 */
const WatchDeviceRequests = Rpc.make('WatchDeviceRequests', {
  ...live,
  payload: WatchDeviceRequestsRequest,
  success: DeviceRequest,
})
const AnswerDeviceRequestRpc = Rpc.make('AnswerDeviceRequest', {
  ...call,
  payload: AnswerDeviceRequest,
})
/** One pointer or keyboard action on the Computer's desktop; the answer is the screen after it. */
const UseDesktop = Rpc.make('UseDesktop', {
  ...call,
  payload: UseDesktopRequest,
  success: DesktopOutcome,
})

// ── What Vivid can do without a Computer ───────────────────────────────────
/** Runs a program Vivid wrote over the tools it already has. See `RunCodeRequest`. */
const RunCode = Rpc.make('RunCode', { ...call, payload: RunCodeRequest, success: CodeOutcome })
/** A Person may run a reply's program only inside a Thread they can currently read. */
const RunDisplayCode = Rpc.make('RunDisplayCode', {
  error: Schema.Union([RpcFailure, DisplayProgramRefused]),
  payload: RunDisplayCodeRequest,
  success: DisplayCodeOutcome,
})
/** Reads one public page. Private and local addresses are refused before anything is fetched. */
const ReadPage = Rpc.make('ReadPage', {
  ...call,
  payload: ReadPageRequest,
  success: ReadPageOutcome,
})

// ── Finding things ─────────────────────────────────────────────────────────
const Search = Rpc.make('Search', { ...call, payload: SearchRequest, success: SearchResponse })
const ListSuggestions = Rpc.make('ListSuggestions', { ...call, success: SuggestionListResponse })
const WatchSuggestions = Rpc.make('WatchSuggestions', { ...live, success: SuggestionListResponse })

export const VividRpc = RpcGroup.make(
  Me,
  WatchMe,
  SetPersonName,
  GetBuild,
  WatchBuild,
  CreateCompany,
  SwitchWorkspace,
  GetSettings,
  WatchSettings,
  PatchSettings,
  GetAppearance,
  WatchAppearance,
  SetAppearance,
  ListPeople,
  WatchPeople,
  InviteMember,
  RevokeInvitation,
  PreviewInvitation,
  AcceptInvitation,
  ChangeRole,
  RemoveMember,
  LeaveCompany,
  ListThreads,
  WatchThreads,
  GetThread,
  WatchThread,
  WatchConversation,
  SendToThread,
  CarryOnThread,
  CreateThread,
  OpenFirstThread,
  PatchThread,
  RegenerateThreadTitle,
  ShareThread,
  DeleteThread,
  MarkThreadRead,
  StopThread,
  BePresent,
  GetDeliveryScope,
  ListArtifacts,
  WatchArtifacts,
  GetArtifact,
  ReviseArtifact,
  RemoveArtifact,
  WriteDocument,
  ReadDocument,
  GetInbox,
  WatchInbox,
  DecideApproval,
  WithdrawApproval,
  AskInput,
  AnswerInput,
  ListRules,
  WatchRules,
  CreateRule,
  DeleteRule,
  ListAudit,
  WatchAudit,
  ListNotifications,
  RegisterPushTarget,
  ListPushTargets,
  WatchPushTargets,
  RemovePushTarget,
  GetPushKey,
  NotifyPerson,
  ListFeed,
  WatchFeed,
  MarkFeedCard,
  Post,
  WatchNotifications,
  ReadNotifications,
  FindAppEvents,
  CreateWatch,
  ListWatches,
  StopWatch,
  ListProjects,
  WatchProjects,
  CreateProject,
  UpdateProject,
  ListOwed,
  WatchOwed,
  TrackOwed,
  UpdateOwed,
  NudgedOwed,
  ResolveOwed,
  DropOwed,
  ListTodos,
  WatchTodos,
  AddTodo,
  CompleteTodo,
  DropTodo,
  ListLibrary,
  WatchLibrary,
  GetLibraryItem,
  PatchLibraryItem,
  DeleteLibraryItem,
  SearchLibrary,
  ListLibraryFolders,
  CreateLibraryFolder,
  PatchLibraryFolder,
  DeleteLibraryFolder,
  FindIntegrations,
  AddIntegration,
  MakeIntegration,
  TestIntegration,
  ListConnections,
  WatchConnections,
  FindServices,
  BeginConnection,
  CompleteConnection,
  ResumeConnection,
  RemoveConnection,
  RenameConnection,
  FindTools,
  ResolveTool,
  UseTool,
  UseDisplayTool,
  OfferConnection,
  GetMemoryIndex,
  ListMemory,
  ReadMemory,
  CorrectMemory,
  PlanMemoryForget,
  ForgetMemory,
  WatchMemoryForget,
  ListSkills,
  WatchSkills,
  ListSkillSummaries,
  ReadSkill,
  SaveSkill,
  PatchSkill,
  DeleteSkill,
  GetComputer,
  GetEgress,
  WatchEgress,
  GetComputerApps,
  WatchComputer,
  StartComputer,
  StopComputer,
  HoldComputer,
  ComputerShell,
  ComputerFileRead,
  ComputerFileWrite,
  Browse,
  WatchChannels,
  WatchDrafts,
  SaveDraft,
  ConnectChannel,
  DisconnectChannel,
  EnrolDevice,
  ListDevices,
  WatchDevices,
  AllowDevice,
  RevokeDevice,
  ReportDeviceStop,
  UseWindow,
  CopySignIn,
  WatchDeviceRequests,
  AnswerDeviceRequestRpc,
  UseDesktop,
  RunCode,
  RunDisplayCode,
  ReadPage,
  Search,
  ListSuggestions,
  WatchSuggestions,
).middleware(RpcAuthMiddleware)
