import { boolean, index, integer, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core'
import { companyTable } from '../companies/tables.ts'

const id = () => text().primaryKey()
const createdAt = () => timestamp({ withTimezone: true, mode: 'date' }).notNull().defaultNow()

export const personTable = pgTable(
  'user',
  {
    id: id(),
    name: text().notNull(),
    email: text().notNull(),
    emailVerified: boolean().notNull().default(false),
    image: text(),
    createdAt: createdAt(),
    updatedAt: createdAt(),
  },
  (table) => [uniqueIndex('user_email_idx').on(table.email)],
)

export const sessionTable = pgTable(
  'session',
  {
    id: id(),
    expiresAt: timestamp({ withTimezone: true, mode: 'date' }).notNull(),
    token: text().notNull(),
    createdAt: createdAt(),
    updatedAt: createdAt(),
    ipAddress: text(),
    userAgent: text(),
    userId: text().notNull().references(() => personTable.id, { onDelete: 'cascade' }),
    activeCompanyId: text().references(() => companyTable.id, { onDelete: 'set null' }),
  },
  (table) => [
    uniqueIndex('session_token_idx').on(table.token),
    index('session_user_idx').on(table.userId),
  ],
)

export const accountTable = pgTable(
  'account',
  {
    id: id(),
    accountId: text().notNull(),
    providerId: text().notNull(),
    userId: text().notNull().references(() => personTable.id, { onDelete: 'cascade' }),
    accessToken: text(),
    refreshToken: text(),
    idToken: text(),
    accessTokenExpiresAt: timestamp({ withTimezone: true, mode: 'date' }),
    refreshTokenExpiresAt: timestamp({ withTimezone: true, mode: 'date' }),
    scope: text(),
    password: text(),
    createdAt: createdAt(),
    updatedAt: createdAt(),
  },
  (table) => [
    index('account_user_idx').on(table.userId),
    uniqueIndex('account_provider_idx').on(table.providerId, table.accountId),
  ],
)

export const verificationTable = pgTable(
  'verification',
  {
    id: id(),
    identifier: text().notNull(),
    value: text().notNull(),
    expiresAt: timestamp({ withTimezone: true, mode: 'date' }).notNull(),
    createdAt: createdAt(),
    updatedAt: createdAt(),
  },
  (table) => [index('verification_identifier_idx').on(table.identifier)],
)

export const deviceCodeTable = pgTable(
  'deviceCode',
  {
    id: id(),
    deviceCode: text().notNull(),
    userCode: text().notNull(),
    userId: text().references(() => personTable.id, { onDelete: 'cascade' }),
    expiresAt: timestamp({ withTimezone: true, mode: 'date' }).notNull(),
    status: text().notNull(),
    lastPolledAt: timestamp({ withTimezone: true, mode: 'date' }),
    pollingInterval: integer(),
    clientId: text(),
    scope: text(),
  },
  (table) => [
    uniqueIndex('device_code_device_idx').on(table.deviceCode),
    uniqueIndex('device_code_user_idx').on(table.userCode),
  ],
)
