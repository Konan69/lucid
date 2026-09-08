import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import { db, schemaReady } from "./runtime-db.ts";
import { libraryChunks, libraryDocuments, libraryFolders } from "./runtime-schema.ts";
import {
  LibraryDocumentSchema,
  LibraryFolderSchema,
  LibrarySearchResultSchema,
  StoredLibraryDocumentSchema,
  decode
} from "./runtime-codecs.ts";

export type LibraryDocumentStatus = "processing" | "ready" | "failed";
export type LibraryDocument = { id: string; name: string; mimeType: string; size: number; sha256: string; status: LibraryDocumentStatus; error: string | null; preview: string; chunkCount: number; createdAt: number; updatedAt: number; folderId: string | null };
export type LibraryFolder = { id: string; name: string; parentId: string | null; createdAt: number; updatedAt: number; itemCount: number };
export type LibrarySearchResult = { chunkId: string; documentId: string; filename: string; page: number | null; text: string; score: number };
type StoredLibraryDocument = LibraryDocument & { bytes: Uint8Array; extractedText: string };
export type IndexedChunk = { page: number | null; text: string };

const documentSelection = {
  id: libraryDocuments.id,
  name: libraryDocuments.name,
  mimeType: libraryDocuments.mimeType,
  size: libraryDocuments.size,
  sha256: libraryDocuments.sha256,
  status: libraryDocuments.status,
  error: libraryDocuments.error,
  preview: sql<string>`substring(${libraryDocuments.extractedText} from 1 for 320)`,
  chunkCount: sql<number>`(select count(*) from ${libraryChunks} where ${libraryChunks.documentId} = ${libraryDocuments.id})`,
  createdAt: libraryDocuments.createdAt,
  updatedAt: libraryDocuments.updatedAt,
  folderId: libraryDocuments.folderId
};
const storedDocumentSelection = {
  ...documentSelection,
  bytes: libraryDocuments.bytes,
  extractedText: libraryDocuments.extractedText
};
const folderSelection = {
  id: libraryFolders.id,
  name: libraryFolders.name,
  parentId: libraryFolders.parentId,
  createdAt: libraryFolders.createdAt,
  updatedAt: libraryFolders.updatedAt,
  itemCount: sql<number>`(
    (select count(*) from ${libraryFolders} child where child.parent_id = ${libraryFolders.id}) +
    (select count(*) from ${libraryDocuments} document where document.folder_id = ${libraryFolders.id})
  )`
};

function decodeDocument<T extends { size: unknown; chunkCount: unknown }>(row: T): LibraryDocument {
  return decode(LibraryDocumentSchema, { ...row, size: Number(row.size), chunkCount: Number(row.chunkCount) });
}

function decodeStoredDocument<T extends { size: unknown; chunkCount: unknown; bytes: Uint8Array; extractedText: string }>(row: T): StoredLibraryDocument {
  return decode(StoredLibraryDocumentSchema, { ...row, bytes: new Uint8Array(row.bytes), size: Number(row.size), chunkCount: Number(row.chunkCount) });
}

function decodeFolder<T extends { itemCount: unknown }>(row: T): LibraryFolder {
  return decode(LibraryFolderSchema, { ...row, itemCount: Number(row.itemCount) });
}

export async function listLibraryDocuments(folderId?: string | null): Promise<LibraryDocument[]> {
  await schemaReady;
  const condition = folderId === undefined ? undefined : folderId === null ? isNull(libraryDocuments.folderId) : eq(libraryDocuments.folderId, folderId);
  return (await db.select(documentSelection).from(libraryDocuments).where(condition).orderBy(desc(libraryDocuments.createdAt))).map(decodeDocument);
}

export async function listLibraryFolders(parentId: string | null): Promise<LibraryFolder[]> {
  await schemaReady;
  const condition = parentId === null ? isNull(libraryFolders.parentId) : eq(libraryFolders.parentId, parentId);
  return (await db.select(folderSelection).from(libraryFolders).where(condition).orderBy(asc(sql`lower(${libraryFolders.name})`))).map(decodeFolder);
}

export async function listAllLibraryFolders(): Promise<LibraryFolder[]> {
  await schemaReady;
  return (await db.select(folderSelection).from(libraryFolders).orderBy(asc(sql`lower(${libraryFolders.name})`))).map(decodeFolder);
}

export async function getLibraryFolder(id: string): Promise<LibraryFolder | null> {
  await schemaReady;
  const rows = await db.select(folderSelection).from(libraryFolders).where(eq(libraryFolders.id, id));
  return rows[0] ? decodeFolder(rows[0]) : null;
}

export async function updateLibraryFolder(id: string, patch: { name?: string; parentId?: string | null }): Promise<LibraryFolder | null> {
  const current = await getLibraryFolder(id); if (!current) return null;
  const parentId = patch.parentId === undefined ? current.parentId : patch.parentId;
  if (parentId === id) throw new Error("A folder cannot contain itself");
  if (parentId) {
    const parents = await db.select({ id: libraryFolders.id, parentId: libraryFolders.parentId }).from(libraryFolders);
    const parentById = new Map(parents.map((folder) => [folder.id, folder.parentId]));
    let candidate: string | null = parentId;
    while (candidate) {
      if (candidate === id) throw new Error("A folder cannot move inside one of its descendants");
      candidate = parentById.get(candidate) ?? null;
    }
  }
  await db.update(libraryFolders).set({ name: patch.name ?? current.name, parentId, updatedAt: Date.now() }).where(eq(libraryFolders.id, id));
  return getLibraryFolder(id);
}

export async function createLibraryFolder(name: string, parentId: string | null): Promise<LibraryFolder> {
  await schemaReady; const id = randomUUID(); const now = Date.now();
  await db.insert(libraryFolders).values({ id, name, parentId, createdAt: now, updatedAt: now });
  return (await getLibraryFolder(id))!;
}

export async function deleteLibraryFolder(id: string): Promise<"deleted" | "not-found" | "not-empty"> {
  const folder = await getLibraryFolder(id); if (!folder) return "not-found";
  const [children, documents] = await Promise.all([
    db.select({ id: libraryFolders.id }).from(libraryFolders).where(eq(libraryFolders.parentId, id)),
    db.select({ id: libraryDocuments.id }).from(libraryDocuments).where(eq(libraryDocuments.folderId, id))
  ]);
  if (children.length + documents.length > 0) return "not-empty";
  await db.delete(libraryFolders).where(eq(libraryFolders.id, id)); return "deleted";
}

export async function getLibraryDocument(id: string): Promise<LibraryDocument | null> {
  await schemaReady;
  const rows = await db.select(documentSelection).from(libraryDocuments).where(eq(libraryDocuments.id, id));
  return rows[0] ? decodeDocument(rows[0]) : null;
}

export async function getLibraryDocumentByDigest(sha256: string): Promise<LibraryDocument | null> {
  await schemaReady;
  const rows = await db.select(documentSelection).from(libraryDocuments).where(eq(libraryDocuments.sha256, sha256));
  return rows[0] ? decodeDocument(rows[0]) : null;
}

export async function getStoredLibraryDocument(id: string): Promise<StoredLibraryDocument | null> {
  await schemaReady;
  const rows = await db.select(storedDocumentSelection).from(libraryDocuments).where(eq(libraryDocuments.id, id));
  return rows[0] ? decodeStoredDocument(rows[0]) : null;
}

export async function getStoredLibraryDocumentByName(name: string): Promise<StoredLibraryDocument | null> {
  await schemaReady;
  const rows = await db.select(storedDocumentSelection).from(libraryDocuments)
    .where(and(eq(libraryDocuments.name, name), eq(libraryDocuments.status, "ready")))
    .orderBy(desc(libraryDocuments.updatedAt)).limit(1);
  return rows[0] ? decodeStoredDocument(rows[0]) : null;
}

export async function updateLibraryDocument(id: string, patch: { name?: string; folderId?: string | null }): Promise<LibraryDocument | null> {
  const current = await getLibraryDocument(id); if (!current) return null;
  await db.update(libraryDocuments).set({ name: patch.name ?? current.name, folderId: patch.folderId === undefined ? current.folderId : patch.folderId, updatedAt: Date.now() }).where(eq(libraryDocuments.id, id));
  return getLibraryDocument(id);
}

export async function createLibraryDocument(input: { name: string; mimeType: string; bytes: Uint8Array; sha256: string; folderId: string | null }): Promise<LibraryDocument> {
  await schemaReady; const now = Date.now(); const id = randomUUID();
  await db.insert(libraryDocuments).values({ id, name: input.name, mimeType: input.mimeType, size: input.bytes.byteLength, sha256: input.sha256, status: "processing", bytes: Buffer.from(input.bytes), createdAt: now, updatedAt: now, folderId: input.folderId });
  return (await getLibraryDocument(id))!;
}

export async function completeLibraryDocument(id: string, extractedText: string, chunks: IndexedChunk[]): Promise<void> {
  await schemaReady;
  await db.transaction(async (tx) => {
    await tx.delete(libraryChunks).where(eq(libraryChunks.documentId, id));
    for (const [ordinal, chunk] of chunks.entries()) {
      await tx.insert(libraryChunks).values({ id: randomUUID(), documentId: id, ordinal, page: chunk.page, text: chunk.text });
    }
    await tx.update(libraryDocuments).set({ status: "ready", extractedText, error: null, updatedAt: Date.now() }).where(eq(libraryDocuments.id, id));
  });
}

export async function failLibraryDocument(id: string, error: string): Promise<void> {
  await db.update(libraryDocuments).set({ status: "failed", error: error.slice(0, 1000), updatedAt: Date.now() }).where(eq(libraryDocuments.id, id));
}

export async function deleteLibraryDocument(id: string): Promise<boolean> {
  await schemaReady;
  return (await db.delete(libraryDocuments).where(eq(libraryDocuments.id, id)).returning({ id: libraryDocuments.id })).length > 0;
}

/**
 * PostgreSQL full-text retrieval is intentionally raw: Drizzle's query builder cannot express the
 * recursive folder CTE together with websearch_to_tsquery/ts_rank_cd without changing semantics.
 * All values are still bound by Drizzle's sql template and every row is decoded below.
 */
export async function searchLibrary(search: string, limit = 6, folderId?: string | null): Promise<LibrarySearchResult[]> {
  await schemaReady;
  const boundedLimit = Math.max(1, Math.min(limit, 10));
  const folderFilter = folderId ? sql`AND d.folder_id IN (SELECT id FROM folder_tree)` : sql``;
  const result = await db.execute(sql`
    WITH RECURSIVE folder_tree(id) AS (
      SELECT ${folderId ?? null}::text UNION ALL SELECT f.id FROM vivid_library_folders f JOIN folder_tree tree ON f.parent_id = tree.id
    )
    SELECT c.id AS "chunkId", c.document_id AS "documentId", d.name AS filename, c.page, c.text,
      ts_rank_cd(c.search_vector, websearch_to_tsquery('simple', ${search})) AS score
    FROM vivid_library_chunks c JOIN vivid_library_documents d ON d.id = c.document_id
    WHERE d.status = 'ready' AND c.search_vector @@ websearch_to_tsquery('simple', ${search}) ${folderFilter}
    ORDER BY score DESC, c.ordinal ASC LIMIT ${boundedLimit}
  `);
  return result.rows.map((row) => {
    const parsed = decode(LibrarySearchResultSchema, { ...row, score: Number(row.score) });
    return { ...parsed, score: Number(parsed.score.toFixed(4)) };
  });
}
