import * as Schema from 'effect/Schema'
import * as Rpc from 'effect/unstable/rpc/Rpc'
import * as RpcGroup from 'effect/unstable/rpc/RpcGroup'
import * as RpcMiddleware from 'effect/unstable/rpc/RpcMiddleware'
import { ApprovalResponse, DecideApprovalRequest } from './approvals.js'
import { AuditListResponse } from './audit.js'
import type { AuthContext } from './auth.js'
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
  BrowseOutcome,
  BrowseRequest,
  CommandOutcome,
  ComputerResponse,
  RunCommandRequest,
} from './computers.js'
import {
  BeginConnectionRequest,
  CompleteConnectionRequest,
  ConnectionListResponse,
  ConnectionRequestMessage,
  ConnectionResponse,
  ConnectionStep,
  FindToolsRequest,
  FindToolsResponse,
  OfferConnectionRequest,
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
  NotFound,
  RuntimeUnavailable,
  ServiceUnavailable,
  Unauthenticated,
} from './failures.js'
import {
  ApprovalId,
  ConnectionId,
  FollowUpId,
  InvitationId,
  LibraryFolderId,
  LibraryItemId,
  MembershipId,
  MemoryId,
  RoutineId,
  RuleId,
  SkillId,
  TaskId,
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
  OccurrenceResponse,
  PatchRoutineRequest,
  RoutineListResponse,
  RoutineResponse,
  RoutineWebhook,
} from './routines.js'
import { CreateRuleRequest, RuleListResponse, RuleResponse } from './rules.js'
import { SearchRequest, SearchResponse, SuggestionListResponse } from './search.js'
import { PatchSettingsRequest, Settings } from './settings.js'
import {
  PatchSkillRequest,
  SaveSkillRequest,
  SkillListResponse,
  SkillResponse,
  SkillSummaryListResponse,
} from './skills.js'
import {
  CreateTaskRequest,
  FollowUpInput,
  FollowUpResponse,
  NudgeTaskRequest,
  PatchFollowUpRequest,
  PatchTaskRequest,
  TaskListQuery,
  TaskListResponse,
  TaskResponse,
} from './tasks.js'
import {
  CreateThreadRequest,
  Inbox,
  PatchThreadRequest,
  PresenceRequest,
  ShareThreadRequest,
  ThreadDetail,
  ThreadListResponse,
  ThreadResponse,
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
])
export type RpcFailure = typeof RpcFailure.Type

/** Authenticates every RPC and provides the request-local identity to its handler. */
export class RpcAuthMiddleware extends RpcMiddleware.Service<
  RpcAuthMiddleware,
  { provides: AuthContext; requires: never }
>()('vivid/RpcAuthMiddleware', { error: RpcFailure }) {}

const call = { error: RpcFailure } as const
const live = { error: RpcFailure, stream: true } as const

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
const AcceptInvitation = Rpc.make('AcceptInvitation', {
  ...call,
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
const PatchThread = Rpc.make('PatchThread', {
  ...call,
  payload: { id: ThreadId, patch: PatchThreadRequest },
  success: ThreadResponse,
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

// ── Tasks and follow-ups ───────────────────────────────────────────────────
const ListTasks = Rpc.make('ListTasks', {
  ...call,
  payload: TaskListQuery,
  success: TaskListResponse,
})
const WatchTasks = Rpc.make('WatchTasks', {
  ...live,
  payload: TaskListQuery,
  success: TaskListResponse,
})
const CreateTask = Rpc.make('CreateTask', {
  ...call,
  payload: CreateTaskRequest,
  success: TaskResponse,
})
const PatchTask = Rpc.make('PatchTask', {
  ...call,
  payload: { id: TaskId, patch: PatchTaskRequest },
  success: TaskResponse,
})
const DeleteTask = Rpc.make('DeleteTask', { ...call, payload: { id: TaskId } })
/** Ask Vivid to chase a Task now, outside its scheduled follow-ups. */
const NudgeTask = Rpc.make('NudgeTask', {
  ...call,
  payload: { id: TaskId, nudge: NudgeTaskRequest },
  success: TaskResponse,
})
const AddFollowUp = Rpc.make('AddFollowUp', {
  ...call,
  payload: { taskId: TaskId, followUp: FollowUpInput },
  success: FollowUpResponse,
})
const PatchFollowUp = Rpc.make('PatchFollowUp', {
  ...call,
  payload: { id: FollowUpId, patch: PatchFollowUpRequest },
  success: FollowUpResponse,
})
const DeleteFollowUp = Rpc.make('DeleteFollowUp', { ...call, payload: { id: FollowUpId } })
const RunFollowUp = Rpc.make('RunFollowUp', {
  ...call,
  payload: { id: FollowUpId },
  success: FollowUpResponse,
})

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
const ListRoutines = Rpc.make('ListRoutines', { ...call, success: RoutineListResponse })
const WatchRoutines = Rpc.make('WatchRoutines', { ...live, success: RoutineListResponse })
const CreateRoutine = Rpc.make('CreateRoutine', {
  ...call,
  payload: CreateRoutineRequest,
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

// ── Connections (a provider's sign-in redirect returns over plain HTTP) ────
const ListConnections = Rpc.make('ListConnections', { ...call, success: ConnectionListResponse })
const WatchConnections = Rpc.make('WatchConnections', {
  ...live,
  success: ConnectionListResponse,
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
const RemoveConnection = Rpc.make('RemoveConnection', { ...call, payload: { id: ConnectionId } })
/** Vivid looking for what it can do, limited to what the acting Person may use in this Thread. */
const FindTools = Rpc.make('FindTools', {
  ...call,
  payload: FindToolsRequest,
  success: FindToolsResponse,
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
  payload: { id: SkillId, patch: PatchSkillRequest },
  success: SkillResponse,
})
const DeleteSkill = Rpc.make('DeleteSkill', { ...call, payload: { id: SkillId } })

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
const Browse = Rpc.make('Browse', { ...call, payload: BrowseRequest, success: BrowseOutcome })

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
  PatchThread,
  ShareThread,
  DeleteThread,
  MarkThreadRead,
  StopThread,
  ReportPresence,
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
  ListTasks,
  WatchTasks,
  CreateTask,
  PatchTask,
  DeleteTask,
  NudgeTask,
  AddFollowUp,
  PatchFollowUp,
  DeleteFollowUp,
  RunFollowUp,
  ListNotifications,
  WatchNotifications,
  ReadNotifications,
  ListRoutines,
  WatchRoutines,
  CreateRoutine,
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
  ListConnections,
  WatchConnections,
  BeginConnection,
  CompleteConnection,
  RemoveConnection,
  FindTools,
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
  Search,
  ListSuggestions,
  WatchSuggestions,
).middleware(RpcAuthMiddleware)
