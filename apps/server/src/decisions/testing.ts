import * as NodeProcess from 'node:process'
import { NodeHttpClient } from '@effect/platform-node'
import { DECISION_MODEL, gatewayDecisionLayer } from './model.ts'
import { Array as Arr, Config, Effect, Layer, Logger, Schema } from 'effect'

/** Live judgments require explicit consent and the gateway key; normal suites never spend
 * credentials. They ask the real provider whatever `VIVID_DECISIONS` says, because the claim
 * under test is the model's behaviour, not the switch. The key is decoded redacted. */
export const liveDecisionEnabled =
  NodeProcess.env['VIVID_LIVE_DECISIONS'] === '1' &&
  NodeProcess.env['EXPLABS_API_KEY'] !== undefined
export const liveDecisionLayer = Layer.unwrap(
  Effect.map(Config.schema(Schema.Redacted(Schema.NonEmptyString), 'EXPLABS_API_KEY'), (key) =>
    gatewayDecisionLayer({ key, model: DECISION_MODEL }),
  ),
).pipe(Layer.provide(NodeHttpClient.layerUndici))

/** Provider descriptions are fixture inputs only; they never enter production classifiers. */
export const liveTools = [
  {
    serviceName: 'DeepWiki',
    account: 'DeepWiki',
    name: 'ask_question',
    description: 'Ask any question about a GitHub repository',
    expected: 'read',
  },
  {
    serviceName: 'DeepWiki',
    account: 'DeepWiki',
    name: 'read_wiki_structure',
    description: 'Get a list of documentation topics for a GitHub repository',
    expected: 'read',
  },
  {
    serviceName: 'DeepWiki',
    account: 'DeepWiki',
    name: 'read_wiki_contents',
    description: 'View documentation about a GitHub repository',
    expected: 'read',
  },
  {
    serviceName: 'Gmail',
    account: 'Gmail',
    name: 'list_messages',
    description: 'List messages matching a mailbox query without changing them',
    expected: 'read',
  },
  {
    serviceName: 'Gmail',
    account: 'Gmail',
    name: 'get_message',
    description: 'Retrieve the contents and headers of an email',
    expected: 'read',
  },
  {
    serviceName: 'Slack',
    account: 'Slack',
    name: 'search_messages',
    description: 'Search existing messages in accessible channels',
    expected: 'read',
  },
  {
    serviceName: 'GitHub',
    account: 'GitHub',
    name: 'list_issues',
    description: 'List issues in a repository',
    expected: 'read',
  },
  {
    serviceName: 'GitHub',
    account: 'GitHub',
    name: 'get_pull_request',
    description: 'Retrieve pull request metadata and diff',
    expected: 'read',
  },
  {
    serviceName: 'Drive',
    account: 'Drive',
    name: 'search_files',
    description: 'Search existing files by name and content',
    expected: 'read',
  },
  {
    serviceName: 'Notion',
    account: 'Notion',
    name: 'fetch_page',
    description: 'Fetch page properties and blocks without modifying the page',
    expected: 'read',
  },
  {
    serviceName: 'Calendar',
    account: 'Calendar',
    name: 'list_events',
    description: 'List scheduled events in a calendar',
    expected: 'read',
  },
  {
    serviceName: 'Stripe',
    account: 'Stripe',
    name: 'get_payment',
    description: 'Retrieve payment status and amount',
    expected: 'read',
  },
  {
    serviceName: 'Salesforce',
    account: 'Salesforce',
    name: 'read_contact',
    description: 'Read the fields of an existing contact',
    expected: 'read',
  },
  {
    serviceName: 'PostgreSQL',
    account: 'PostgreSQL',
    name: 'run_query',
    description: 'Execute a read-only SELECT query; writes and schema changes are forbidden',
    expected: 'read',
  },
  {
    serviceName: 'Analytics',
    account: 'Analytics',
    name: 'export_report',
    description:
      'Fetch an existing report as a CSV download without creating or changing stored reports',
    expected: 'read',
  },
  {
    serviceName: 'Drive',
    account: 'Drive',
    name: 'generate_link',
    description: 'Return the existing sharing URL of a file without changing permissions',
    expected: 'read',
  },
  {
    serviceName: 'Linear',
    account: 'Linear',
    name: 'fetch_issue',
    description: 'Fetch issue details and comments',
    expected: 'read',
  },
  {
    serviceName: 'Dropbox',
    account: 'Dropbox',
    name: 'list_folder',
    description: 'List files and subfolders in an existing folder',
    expected: 'read',
  },
  {
    serviceName: 'Gmail',
    account: 'Gmail',
    name: 'send_email',
    description: 'Send an email message to recipients',
    expected: 'write',
  },
  {
    serviceName: 'Slack',
    account: 'Slack',
    name: 'post_message',
    description: 'Post a new message in a channel',
    expected: 'write',
  },
  {
    serviceName: 'GitHub',
    account: 'GitHub',
    name: 'create_issue',
    description: 'Create a new issue in a repository',
    expected: 'write',
  },
  {
    serviceName: 'Notion',
    account: 'Notion',
    name: 'update_page',
    description: 'Update page properties and editable content',
    expected: 'write',
  },
  {
    serviceName: 'Calendar',
    account: 'Calendar',
    name: 'create_event',
    description: 'Create a calendar event and invite attendees',
    expected: 'write',
  },
  {
    serviceName: 'Drive',
    account: 'Drive',
    name: 'create_file',
    description: 'Create a file with supplied content',
    expected: 'write',
  },
  {
    serviceName: 'Salesforce',
    account: 'Salesforce',
    name: 'update_contact',
    description: 'Change editable contact fields',
    expected: 'write',
  },
  {
    serviceName: 'Gmail',
    account: 'Gmail',
    name: 'mark_as_read',
    description: 'Change unread messages to the read state',
    expected: 'write',
  },
  {
    serviceName: 'Stripe',
    account: 'Stripe',
    name: 'refund_payment',
    description: 'Issue a refund to the customer for an existing payment',
    expected: 'write',
  },
  {
    serviceName: 'Drive',
    account: 'Drive',
    name: 'generate_sharing_link',
    description: 'Create a public sharing link and enable public access',
    expected: 'write',
  },
  {
    serviceName: 'Analytics',
    account: 'Analytics',
    name: 'export_saved_report',
    description: 'Create and save a new exported report in the account',
    expected: 'write',
  },
  {
    serviceName: 'PostgreSQL',
    account: 'PostgreSQL',
    name: 'run_mutation',
    description: 'Execute an UPDATE query on existing rows',
    expected: 'write',
  },
  {
    serviceName: 'GitHub',
    account: 'GitHub',
    name: 'delete_repository',
    description: 'Permanently delete a repository and all of its data',
    expected: 'destructive',
  },
  {
    serviceName: 'Slack',
    account: 'Slack',
    name: 'purge_channel',
    description: 'Permanently remove all messages in a channel',
    expected: 'destructive',
  },
  {
    serviceName: 'Google',
    account: 'Google',
    name: 'revoke_access',
    description: 'Permanently revoke an issued access credential',
    expected: 'destructive',
  },
  {
    serviceName: 'Drive',
    account: 'Drive',
    name: 'delete_file',
    description: 'Permanently delete a file without using the recoverable trash',
    expected: 'destructive',
  },
  {
    serviceName: 'Stripe',
    account: 'Stripe',
    name: 'delete_customer',
    description: 'Permanently delete a customer and associated stored data',
    expected: 'destructive',
  },
  {
    serviceName: 'PostgreSQL',
    account: 'PostgreSQL',
    name: 'drop_table',
    description: 'Permanently drop a table and all rows',
    expected: 'destructive',
  },
] as const

/** Scripted provider wire variants share one vocabulary across behavior tests. The
 * DecisionModel constructor still validates distributions and missing answers. */
export const ScriptedAnswer = Schema.TaggedUnion({
  Probability: { probability: Schema.Finite },
  Classify: { label: Schema.String, probabilities: Schema.Record(Schema.String, Schema.Finite) },
})

/** Keep the gateway's actual per-tool score receipts, alongside visible calibration logs.
 * A conservative write from timeout/backoff has no receipt and cannot satisfy a live claim. */
export const effectScoreLogLayer = (lines: string[]) =>
  Logger.layer([
    Logger.consoleLogFmt,
    Logger.make(({ message }) => {
      lines.push(JSON.stringify(message))
    }),
  ])

/** Each fixture must have its own score, not merely a successful neighbouring request.
 * JSON.stringify escapes the identity exactly as the structured logger does. */
export const effectScoreCount = (lines: readonly string[], tool: string) =>
  lines.filter(
    (line) => line.includes('Tool effect score') && line.includes(`"tool":${JSON.stringify(tool)}`),
  ).length

/** Round-four calibration read cohorts recovered 15/18 on both paths; fourteen leaves one
 * read of variation without weakening the 0.95 Approval-removal threshold. */
export const LIVE_READ_RECOVERY_FLOOR = 14

const decodeEffectScore = Schema.decodeUnknownResult(
  Schema.fromJsonString(
    Schema.Tuple([
      Schema.Literal('Tool effect score'),
      Schema.Struct({ tool: Schema.String, read: Schema.Finite }),
    ]),
  ),
)

/** Decode structured debug receipts once at their log boundary. Missing scores stay
 * absent, so tests cannot mistake a conservative timeout result for a measured score. */
export const effectScores = (lines: readonly string[], tool: string) =>
  Arr.filterMap(lines, (line) => decodeEffectScore(line))
    .filter(([, receipt]) => receipt.tool === tool)
    .map(([, receipt]) => receipt.read)

/** Gateway jev-latest, 4 Oct 2026: measured warm outliers reached 1983/2092ms,
 * beyond the 1800ms production budget. Ten seconds leaves 7908ms of measurement
 * headroom above the largest observed sample without changing any runtime budget. */
export const LIVE_METADATA_BUDGET = '10 seconds'
/** The largest direct calibration has eighteen sequential attempts: 18 × 10s
 * plus twenty seconds for Layer acquisition and receipt assertions. */
export const LIVE_METADATA_COHORT_BUDGET_MILLIS = 200_000
