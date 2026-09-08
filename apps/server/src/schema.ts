import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex
} from "drizzle-orm/pg-core"
import type { AnyPgColumn } from "drizzle-orm/pg-core"

const id = () => text().primaryKey()
const createdAt = () => timestamp({ withTimezone: true, mode: "date" }).notNull().defaultNow()

export const personTable = pgTable("user", {
  id: id(),
  name: text().notNull(),
  email: text().notNull(),
  emailVerified: boolean().notNull().default(false),
  image: text(),
  createdAt: createdAt(),
  updatedAt: createdAt()
}, (table) => [uniqueIndex("user_email_idx").on(table.email)])

export const companyTable = pgTable("company", {
  id: id(),
  name: text().notNull(),
  slug: text().notNull(),
  logo: text(),
  metadata: jsonb(),
  createdAt: createdAt()
}, (table) => [uniqueIndex("company_slug_idx").on(table.slug)])

export const sessionTable = pgTable("session", {
  id: id(),
  expiresAt: timestamp({ withTimezone: true, mode: "date" }).notNull(),
  token: text().notNull(),
  createdAt: createdAt(),
  updatedAt: createdAt(),
  ipAddress: text(),
  userAgent: text(),
  userId: text().notNull().references(() => personTable.id, { onDelete: "cascade" }),
  activeCompanyId: text().references(() => companyTable.id, { onDelete: "set null" })
}, (table) => [uniqueIndex("session_token_idx").on(table.token), index("session_user_idx").on(table.userId)])

export const accountTable = pgTable("account", {
  id: id(),
  accountId: text().notNull(),
  providerId: text().notNull(),
  userId: text().notNull().references(() => personTable.id, { onDelete: "cascade" }),
  accessToken: text(),
  refreshToken: text(),
  idToken: text(),
  accessTokenExpiresAt: timestamp({ withTimezone: true, mode: "date" }),
  refreshTokenExpiresAt: timestamp({ withTimezone: true, mode: "date" }),
  scope: text(),
  password: text(),
  createdAt: createdAt(),
  updatedAt: createdAt()
}, (table) => [index("account_user_idx").on(table.userId), uniqueIndex("account_provider_idx").on(table.providerId, table.accountId)])

export const verificationTable = pgTable("verification", {
  id: id(),
  identifier: text().notNull(),
  value: text().notNull(),
  expiresAt: timestamp({ withTimezone: true, mode: "date" }).notNull(),
  createdAt: createdAt(),
  updatedAt: createdAt()
}, (table) => [index("verification_identifier_idx").on(table.identifier)])

export const membershipTable = pgTable("membership", {
  id: id(),
  companyId: text().notNull().references(() => companyTable.id, { onDelete: "cascade" }),
  userId: text().notNull().references(() => personTable.id, { onDelete: "cascade" }),
  role: text().notNull(),
  createdAt: createdAt()
}, (table) => [
  uniqueIndex("membership_company_user_idx").on(table.companyId, table.userId),
  index("membership_user_idx").on(table.userId),
  index("membership_company_idx").on(table.companyId)
])

export const invitationTable = pgTable("invitation", {
  id: id(),
  companyId: text().notNull().references(() => companyTable.id, { onDelete: "cascade" }),
  email: text().notNull(),
  role: text().notNull(),
  status: text().notNull(),
  expiresAt: timestamp({ withTimezone: true, mode: "date" }).notNull(),
  inviterId: text().notNull().references(() => personTable.id, { onDelete: "cascade" }),
  createdAt: createdAt()
}, (table) => [index("invitation_company_idx").on(table.companyId), index("invitation_email_idx").on(table.email)])

export const deviceCodeTable = pgTable("deviceCode", {
  id: id(),
  deviceCode: text().notNull(),
  userCode: text().notNull(),
  userId: text().references(() => personTable.id, { onDelete: "cascade" }),
  expiresAt: timestamp({ withTimezone: true, mode: "date" }).notNull(),
  status: text().notNull(),
  lastPolledAt: timestamp({ withTimezone: true, mode: "date" }),
  pollingInterval: integer(),
  clientId: text(),
  scope: text()
}, (table) => [uniqueIndex("device_code_device_idx").on(table.deviceCode), uniqueIndex("device_code_user_idx").on(table.userCode)])

export const projectTable = pgTable("project", {
  id: id(),
  companyId: text().notNull().references(() => companyTable.id, { onDelete: "cascade" }),
  name: text().notNull(),
  parentProjectId: text().references((): AnyPgColumn => projectTable.id, { onDelete: "cascade" }),
  createdBy: text().notNull().references(() => personTable.id, { onDelete: "restrict" }),
  createdAt: createdAt()
}, (table) => [
  index("project_company_idx").on(table.companyId),
  index("project_parent_idx").on(table.parentProjectId),
  index("project_company_parent_idx").on(table.companyId, table.parentProjectId)
])

export const settingsTable = pgTable("settings", {
  personId: text().primaryKey().references(() => personTable.id, { onDelete: "cascade" }),
  theme: text().notNull().default("system"),
  updatedAt: createdAt()
})

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
  deviceCode: deviceCodeTable
} as const

export const drizzleSchema = {
  ...authSchema,
  project: projectTable,
  settings: settingsTable
} as const
