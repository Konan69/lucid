import * as Schema from 'effect/Schema'
import * as Rpc from 'effect/unstable/rpc/Rpc'
import * as RpcGroup from 'effect/unstable/rpc/RpcGroup'
import * as RpcMiddleware from 'effect/unstable/rpc/RpcMiddleware'
import { ApprovalResponse, DecideApprovalRequest } from './approvals.js'
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
import {
  NotifyPersonOutcome,
  NotifyPersonRequest,
  PushUnavailable,
  PushKeyResponse,
  PushTargetId,
  PushTargetListResponse,
  PushTargetResponse,
  RegisterPushTargetRequest,
} from './push.js'
import type { AuthContext } from './auth.js'
import { CodeOutcome, ReadPageOutcome, ReadPageRequest, RunCodeRequest } from './code.js'
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
  WatchDeviceRequestsRequest,
  BrowseOutcome,
  BrowseRequest,
  DesktopOutcome,
  UseDesktopRequest,
  CommandOutcome,
  ComputerResponse,
  RunCommandRequest,
} from './computers.js'
import {
  AddIntegrationRequest,
  AddIntegrationOutcome,
  FindIntegrationsRequest,
  FindIntegrationsResponse,
  TestIntegrationRequest,
  TestIntegrationOutcome,
  BeginConnectionRequest,
  CompleteConnectionRequest,
  ConnectionListResponse,
  ConnectionRequestMessage,
  ConnectionResponse,
  ConnectionStep,
  ConnectionTool,
  FindServicesRequest,
  FindToolsRequest,
  FindToolsResponse,
  OfferConnectionRequest,
  ServiceCatalog,
  ToolOutcome,
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
  LibraryFolderId,
  LibraryItemId,
  MembershipId,
  MemoryId,
  RoutineId,
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
  MemoryBrief,
  MemoryListResponse,
  MemoryResponse,
  RecallRequest,
  RecallResponse,
  RememberRequest,
} from './memory.js'
import {
  NotificationListResponse,
  NotificationReadResponse,
  ReadNotificationsRequest,
} from './notifications.js'
import { CreateProjectRequest, Project, ProjectListResponse } from './projects.js'
import {
  CreateRoutineRequest,
  CreateOnceRoutineRequest,
  FindEventsRequest,
  FindEventsResponse,
  OccurrenceResponse,
  PatchRoutineRequest,
  RoutineListResponse,
  RoutineResponse,
  RoutineWebhook,
} from './routines.js'
import { CreateRuleRequest, RuleListResponse, RuleResponse } from './rules.js'
import { SearchRequest, SearchResponse, SuggestionListResponse } from './search.js'
import { Appearance } from './appearance.js'
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
  OpenThreadRequest,
  Inbox,
  PatchThreadRequest,
  PresenceRequest,
  ShareThreadRequest,
  ThreadDetail,
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
 * The server implements this group; web, mobile, desktop and the Flue runtime's tools all derive
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
 * Flue's stream, which the server proxies at `/api/vivid/*`.
 */

export { InvalidRequest, RuntimeUnavailable, ServiceUnavailable } from './failures.js'

/** Every failure a product call can return. Clients branch on `_tag`, never on a message. */
export const RpcFailure = Schema.Union([
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
  PushUnavailable,
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

// ── The signed-in Person and where they are working ────────────────────────
const Me = Rpc.make('Me', { ...call, success: MeResponse })
const WatchMe = Rpc.make('WatchMe', { ...live, success: MeResponse })
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
const OpenThread = Rpc.make('OpenThread', {
  ...call,
  payload: OpenThreadRequest,
  success: Schema.Struct({ title: Schema.String }),
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
const ReportPresence = Rpc.make('ReportPresence', { ...call, payload: PresenceRequest })
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
  ...call,
  payload: DecideApprovalRequest,
  success: ApprovalResponse,
})
/** Withdraws an Approval the Person no longer wants decided, leaving the action undone. */
const WithdrawApproval = Rpc.make('WithdrawApproval', { ...call, payload: { id: ApprovalId } })
/** Vivid asking a question it cannot safely answer alone. The turn ends until it is answered. */
const AskInput = Rpc.make('AskInput', {
  ...call,
  payload: AskInputRequest,
  success: InputRequestResponse,
})
const AnswerInput = Rpc.make('AnswerInput', {
  ...call,
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

// ── Routines ───────────────────────────────────────────────────────────────
const FindEvents = Rpc.make('FindEvents', {
  ...call,
  payload: FindEventsRequest,
  success: FindEventsResponse,
})
const ListRoutines = Rpc.make('ListRoutines', { ...call, success: RoutineListResponse })
const WatchRoutines = Rpc.make('WatchRoutines', { ...live, success: RoutineListResponse })
const CreateRoutine = Rpc.make('CreateRoutine', {
  ...call,
  payload: CreateRoutineRequest,
  success: RoutineResponse,
})
const CreateOnceRoutine = Rpc.make('CreateOnceRoutine', {
  ...call,
  payload: CreateOnceRoutineRequest,
  success: RoutineResponse,
})
const PatchRoutine = Rpc.make('PatchRoutine', {
  ...call,
  payload: { id: RoutineId, patch: PatchRoutineRequest },
  success: RoutineResponse,
})
const DeleteRoutine = Rpc.make('DeleteRoutine', { ...call, payload: { id: RoutineId } })
/** Start one Occurrence now, outside the Routine's trigger. */
const RunRoutine = Rpc.make('RunRoutine', {
  ...call,
  payload: { id: RoutineId },
  success: OccurrenceResponse,
})
/** The address and key for a webhook Routine. Asking again issues a new key and ends the old one. */
const IssueRoutineWebhook = Rpc.make('IssueRoutineWebhook', {
  ...call,
  payload: { id: RoutineId },
  success: RoutineWebhook,
})

// ── Projects ───────────────────────────────────────────────────────────────
const ListProjects = Rpc.make('ListProjects', { ...call, success: ProjectListResponse })
const WatchProjects = Rpc.make('WatchProjects', { ...live, success: ProjectListResponse })
const CreateProject = Rpc.make('CreateProject', {
  ...call,
  payload: CreateProjectRequest,
  success: Project,
})

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
  payload: { id: ConnectionId },
  success: ConnectionStep,
})
const RemoveConnection = Rpc.make('RemoveConnection', { ...call, payload: { id: ConnectionId } })
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
    account: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(200)),
    tool: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(200)),
  },
  success: ConnectionTool,
})
/** Vivid asking to do one thing through a Connection. The server decides whether it happens. */
const UseTool = Rpc.make('UseTool', { ...call, payload: UseToolRequest, success: ToolOutcome })
/** Vivid offering a service in the Thread, with the acting Person's real state for it. */
const OfferConnection = Rpc.make('OfferConnection', {
  ...call,
  payload: OfferConnectionRequest,
  success: ConnectionRequestMessage,
})

// ── Memory ─────────────────────────────────────────────────────────────────
const ListMemory = Rpc.make('ListMemory', { ...call, success: MemoryListResponse })
const WatchMemory = Rpc.make('WatchMemory', { ...live, success: MemoryListResponse })
/** The page Vivid reads when a Run starts. */
const GetMemoryBrief = Rpc.make('GetMemoryBrief', { ...call, success: MemoryBrief })
const Recall = Rpc.make('Recall', { ...call, payload: RecallRequest, success: RecallResponse })
const Remember = Rpc.make('Remember', {
  ...call,
  payload: RememberRequest,
  success: MemoryResponse,
})
const CorrectMemory = Rpc.make('CorrectMemory', {
  ...call,
  payload: CorrectMemoryRequest,
  success: MemoryResponse,
})
const ForgetMemory = Rpc.make('ForgetMemory', { ...call, payload: { id: MemoryId } })

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
const WatchComputer = Rpc.make('WatchComputer', { ...live, success: ComputerResponse })
const StartComputer = Rpc.make('StartComputer', { ...call, success: ComputerResponse })
const StopComputer = Rpc.make('StopComputer', { ...call, success: ComputerResponse })
/** A Person taking the keyboard and pointer, or handing them back. Vivid cannot act while held. */
const HoldComputer = Rpc.make('HoldComputer', {
  ...call,
  payload: { held: Schema.Boolean },
  success: ComputerResponse,
})
const RunCommand = Rpc.make('RunCommand', {
  ...call,
  payload: RunCommandRequest,
  success: CommandOutcome,
})
const Browse = Rpc.make('Browse', {
  ...call,
  payload: BrowseRequest,
  success: BrowseOutcome,
  error: Schema.Union([RpcFailure, NoDeviceConnected]),
})
// ── The Person's own computers ─────────────────────────────────────────────
/** The desktop app naming itself after sign-in. The same installation always gets the same Device. */
const EnrolDevice = Rpc.make('EnrolDevice', {
  ...call,
  payload: EnrolDeviceRequest,
  success: DeviceResponse,
})
const ListDevices = Rpc.make('ListDevices', { ...call, success: DeviceListResponse })
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
  CreateThread,
  OpenFirstThread,
  OpenThread,
  PatchThread,
  RegenerateThreadTitle,
  ShareThread,
  DeleteThread,
  MarkThreadRead,
  StopThread,
  ReportPresence,
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
  WatchNotifications,
  ReadNotifications,
  FindEvents,
  ListRoutines,
  WatchRoutines,
  CreateRoutine,
  CreateOnceRoutine,
  PatchRoutine,
  DeleteRoutine,
  RunRoutine,
  IssueRoutineWebhook,
  ListProjects,
  WatchProjects,
  CreateProject,
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
  TestIntegration,
  ListConnections,
  WatchConnections,
  FindServices,
  BeginConnection,
  CompleteConnection,
  ResumeConnection,
  RemoveConnection,
  FindTools,
  ResolveTool,
  UseTool,
  OfferConnection,
  ListMemory,
  WatchMemory,
  GetMemoryBrief,
  Recall,
  Remember,
  CorrectMemory,
  ForgetMemory,
  ListSkills,
  WatchSkills,
  ListSkillSummaries,
  ReadSkill,
  SaveSkill,
  PatchSkill,
  DeleteSkill,
  GetComputer,
  WatchComputer,
  StartComputer,
  StopComputer,
  HoldComputer,
  RunCommand,
  Browse,
  EnrolDevice,
  ListDevices,
  AllowDevice,
  RevokeDevice,
  WatchDeviceRequests,
  AnswerDeviceRequestRpc,
  UseDesktop,
  RunCode,
  ReadPage,
  Search,
  ListSuggestions,
  WatchSuggestions,
).middleware(RpcAuthMiddleware)
