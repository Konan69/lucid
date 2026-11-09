import { bigint, integer, pgTable } from 'drizzle-orm/pg-core'

/**
 * The product owner's schema: every table `product-drizzle.config.ts` generates `./product-drizzle`
 * from. It migrates after the identity owner in `schema.ts`.
 */
export { actions } from '../actions/tables.ts'
export {
  artifacts,
  artifactVersions,
  artifactFiles,
  artifactPreparations,
} from '../artifacts/tables.ts'
export { approvals } from '../approvals/tables.ts'
export { channelCodes, channelLinks, channelMessages, channelReplies } from '../channels/tables.ts'
export { auditEntries } from '../audit/tables.ts'
export {
  computerRecoveries,
  computers,
  machineBindings,
  devices,
  deviceRequests,
} from '../computers/tables.ts'
export { connections, connectionPermissions, credentials } from '../connections/tables.ts'
export { draftGenerations, drafts } from '../drafts/tables.ts'
export { feedCards } from '../feed/tables.ts'
export { memoryForgets } from '../forget/tables.ts'
export { handoffs, inputRequests } from '../inputs/tables.ts'
export { libraryChunks, libraryDocuments, libraryFolders } from '../library/tables.ts'
export { rules } from '../rules/tables.ts'
export { childRuns } from '../runs/tables.ts'
export { skills } from '../skills/tables.ts'
export { notifications } from '../notifications/tables.ts'
export { owed } from '../owed/tables.ts'
export { todos } from '../todos/tables.ts'
export { pushTargets, pushDeliveries } from '../push/tables.ts'
export {
  firstThreads,
  runs,
  threadParticipants,
  threadReads,
  threads,
  titleSource,
} from '../threads/tables.ts'
export { watches } from '../watches/tables.ts'

/** Compatibility marker retained exactly because existing databases already contain this table. */
export const schemaMigrations = pgTable('vivid_schema_migrations', {
  version: integer('version').primaryKey(),
  appliedAt: bigint('applied_at', { mode: 'number' }).notNull(),
})

export { activityTargets } from '../activity/tables.ts'
