import { index, jsonb, pgTable, text } from 'drizzle-orm/pg-core'
import { OwedId } from '@vivid/contracts'
import { companyColumn, epoch, personColumn, threadColumn } from '../database/owner.ts'
import { threads } from '../threads/tables.ts'

/** One thing owed to one Person. JSON state owns its nudge count or closure evidence. */
export const owed = pgTable(
  'vivid_owed',
  {
    id: text('id').$type<OwedId>().primaryKey(),
    personId: personColumn().notNull(),
    companyId: companyColumn(),
    threadId: threadColumn('thread_id')
      .notNull()
      .references(() => threads.id, { onDelete: 'cascade' }),
    what: text('what').notNull(),
    from: text('from').notNull(),
    since: epoch('since').notNull(),
    due: epoch('due'),
    blockedOn: text('blocked_on'),
    nextStep: text('next_step').notNull(),
    state: jsonb('state').notNull(),
    updatedAt: epoch('updated_at').notNull(),
  },
  (table) => [index('vivid_owed_owner').on(table.personId, table.companyId)],
)
