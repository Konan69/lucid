import { bigint, integer, pgTable } from 'drizzle-orm/pg-core'
import {
  accountTable,
  deviceCodeTable,
  personTable,
  sessionTable,
  verificationTable,
} from '../auth/tables.ts'
import { companyTable, invitationTable, membershipTable } from '../companies/tables.ts'
import { libraryChunks, libraryDocuments, libraryFolders } from '../library/tables.ts'
import { projectTable } from '../projects/tables.ts'
import { occurrences, routines } from '../routines/tables.ts'
import { settingsTable } from '../settings/tables.ts'
import { followUps, notifications, tasks } from '../tasks/tables.ts'
import { threads } from '../threads/tables.ts'

/** Compatibility marker retained exactly because existing databases already contain this table. */
export const schemaMigrations = pgTable('vivid_schema_migrations', {
  version: integer('version').primaryKey(),
  appliedAt: bigint('applied_at', { mode: 'number' }).notNull(),
})

export {
  accountTable,
  companyTable,
  deviceCodeTable,
  followUps,
  invitationTable,
  libraryChunks,
  libraryDocuments,
  libraryFolders,
  membershipTable,
  notifications,
  occurrences,
  personTable,
  projectTable,
  routines,
  sessionTable,
  settingsTable,
  tasks,
  threads,
  verificationTable,
}

export const authSchema = {
  user: personTable,
  session: sessionTable,
  account: accountTable,
  verification: verificationTable,
  company: companyTable,
  membership: membershipTable,
  organization: companyTable,
  member: membershipTable,
  invitation: invitationTable,
  deviceCode: deviceCodeTable,
} as const

export const drizzleSchema = {
  ...authSchema,
  project: projectTable,
  settings: settingsTable,
  schemaMigrations,
  threads,
  tasks,
  followUps,
  notifications,
  routines,
  occurrences,
  libraryFolders,
  libraryDocuments,
  libraryChunks,
} as const
