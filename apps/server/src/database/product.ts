import { bigint, integer, pgTable } from 'drizzle-orm/pg-core'

/**
 * The product owner's schema: every table `product-drizzle.config.ts` generates `./product-drizzle`
 * from. It migrates after the identity owner in `schema.ts`.
 */
export { artifacts, artifactVersions } from '../artifacts/tables.ts'
export { approvals } from '../approvals/tables.ts'
export { channelLinks, channelMessages, channelReplies } from '../channels/tables.ts'
export { auditEntries } from '../audit/tables.ts'
export { computers, machineBindings, devices, deviceRequests } from '../computers/tables.ts'
export { connections, credentials } from '../connections/tables.ts'
export { draftGenerations, drafts } from '../drafts/tables.ts'
export { feedCards } from '../feed/tables.ts'
export { inputRequests } from '../inputs/tables.ts'
export { libraryChunks, libraryDocuments, libraryFolders } from '../library/tables.ts'
export { rules } from '../rules/tables.ts'
export { skills } from '../skills/tables.ts'
export { notifications } from '../notifications/tables.ts'
export { pushTargets, pushDeliveries } from '../push/tables.ts'
export {
  firstThreads,
  runs,
  threadParticipants,
  threadReads,
  threads,
  titleSource,
} from '../threads/tables.ts'
export { watchArrivals, watches } from '../watches/tables.ts'

/** Compatibility marker retained exactly because existing databases already contain this table. */
export const schemaMigrations = pgTable('vivid_schema_migrations', {
  version: integer('version').primaryKey(),
  appliedAt: bigint('applied_at', { mode: 'number' }).notNull(),
})
