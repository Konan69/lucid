import { sql } from 'drizzle-orm'
import { bytea, customType, index, integer, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core'
import type { AnyPgColumn } from 'drizzle-orm/pg-core'
import { companyColumn, epoch, personColumn } from '../database/owner.ts'

/**
 * The Library has two shelves. A row with no `company_id` is on its `person_id`'s own shelf and
 * follows them into every workspace; a row with a `company_id` is on that Company's shelf, where
 * `person_id` only records who added it. The same bytes may sit on both, so a file is unique per
 * shelf, not globally.
 */
const tsvector = customType<{ data: string; driverData: string }>({ dataType: () => 'tsvector' })

export const libraryFolders = pgTable('vivid_library_folders', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  parentId: text('parent_id').references((): AnyPgColumn => libraryFolders.id, {
    onDelete: 'cascade',
  }),
  createdAt: epoch('created_at').notNull(),
  updatedAt: epoch('updated_at').notNull(),
  personId: personColumn().notNull(),
  companyId: companyColumn(),
})

export const libraryDocuments = pgTable(
  'vivid_library_documents',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    mimeType: text('mime_type').notNull(),
    size: epoch('size').notNull(),
    sha256: text('sha256').notNull(),
    status: text('status').notNull(),
    bytes: bytea('bytes').notNull(),
    extractedText: text('extracted_text').notNull().default(''),
    error: text('error'),
    createdAt: epoch('created_at').notNull(),
    updatedAt: epoch('updated_at').notNull(),
    folderId: text('folder_id'),
    personId: personColumn().notNull(),
    companyId: companyColumn(),
  },
  (table) => [
    index('vivid_library_documents_folder').on(table.folderId, table.createdAt),
    uniqueIndex('vivid_library_documents_mine')
      .on(table.personId, table.sha256)
      .where(sql`${table.companyId} is null`),
    uniqueIndex('vivid_library_documents_company')
      .on(table.companyId, table.sha256)
      .where(sql`${table.companyId} is not null`),
  ],
)

const chunkText = text('text').notNull()
export const libraryChunks = pgTable(
  'vivid_library_chunks',
  {
    id: text('id').primaryKey(),
    documentId: text('document_id')
      .notNull()
      .references(() => libraryDocuments.id, { onDelete: 'cascade' }),
    ordinal: integer('ordinal').notNull(),
    page: integer('page'),
    text: chunkText,
    searchVector: tsvector('search_vector').generatedAlwaysAs(() =>
      sql.raw(`to_tsvector('simple', "text")`),
    ),
  },
  (table) => [
    index('vivid_library_chunks_document').on(table.documentId, table.ordinal),
    index('vivid_library_chunks_search').using('gin', table.searchVector),
  ],
)
