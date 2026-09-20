import { sql } from 'drizzle-orm'
import { bigint, bytea, customType, index, integer, pgTable, text } from 'drizzle-orm/pg-core'
import type { AnyPgColumn } from 'drizzle-orm/pg-core'

const epoch = (name: string) => bigint(name, { mode: 'number' })
const tsvector = customType<{ data: string; driverData: string }>({ dataType: () => 'tsvector' })

export const libraryFolders = pgTable('vivid_library_folders', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  parentId: text('parent_id').references((): AnyPgColumn => libraryFolders.id, {
    onDelete: 'cascade',
  }),
  createdAt: epoch('created_at').notNull(),
  updatedAt: epoch('updated_at').notNull(),
})

export const libraryDocuments = pgTable(
  'vivid_library_documents',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    mimeType: text('mime_type').notNull(),
    size: epoch('size').notNull(),
    sha256: text('sha256').notNull().unique(),
    status: text('status').notNull(),
    bytes: bytea('bytes').notNull(),
    extractedText: text('extracted_text').notNull().default(''),
    error: text('error'),
    createdAt: epoch('created_at').notNull(),
    updatedAt: epoch('updated_at').notNull(),
    folderId: text('folder_id'),
  },
  (table) => [index('vivid_library_documents_folder').on(table.folderId, table.createdAt)],
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
