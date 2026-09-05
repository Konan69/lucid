import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { databasePath } from "./db.ts";

export type LibraryDocumentStatus = "processing" | "ready" | "failed";

export type LibraryDocument = {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  sha256: string;
  status: LibraryDocumentStatus;
  error: string | null;
  preview: string;
  chunkCount: number;
  createdAt: number;
  updatedAt: number;
  folderId: string | null;
};

export type LibraryFolder = {
  id: string;
  name: string;
  parentId: string | null;
  createdAt: number;
  updatedAt: number;
  itemCount: number;
};

export type LibrarySearchResult = {
  chunkId: string;
  documentId: string;
  filename: string;
  page: number | null;
  text: string;
  score: number;
};

type StoredLibraryDocument = LibraryDocument & {
  bytes: Uint8Array;
  extractedText: string;
};

export type IndexedChunk = {
  page: number | null;
  text: string;
};

const database = new DatabaseSync(databasePath);

database.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS konan_library_folders (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    parent_id TEXT REFERENCES konan_library_folders(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS konan_library_documents (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size INTEGER NOT NULL,
    sha256 TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL,
    bytes BLOB NOT NULL,
    extracted_text TEXT NOT NULL DEFAULT '',
    error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS konan_library_chunks (
    id TEXT PRIMARY KEY,
    document_id TEXT NOT NULL REFERENCES konan_library_documents(id) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL,
    page INTEGER,
    text TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS konan_library_chunks_document
    ON konan_library_chunks(document_id, ordinal);
  CREATE VIRTUAL TABLE IF NOT EXISTS konan_library_chunks_fts USING fts5(
    chunk_id UNINDEXED,
    text,
    tokenize = 'unicode61 remove_diacritics 2'
  );
`);

const documentColumns = database.prepare("PRAGMA table_info(konan_library_documents)").all() as Array<{ name: string }>;
if (!documentColumns.some((column) => column.name === "folder_id")) {
  database.exec("ALTER TABLE konan_library_documents ADD COLUMN folder_id TEXT");
}
database.exec("CREATE INDEX IF NOT EXISTS konan_library_documents_folder ON konan_library_documents(folder_id, created_at DESC)");

const summaryColumns = `
  d.id, d.name, d.mime_type AS mimeType, d.size, d.sha256, d.status, d.error,
  substr(d.extracted_text, 1, 320) AS preview,
  (SELECT count(*) FROM konan_library_chunks c WHERE c.document_id = d.id) AS chunkCount,
  d.created_at AS createdAt, d.updated_at AS updatedAt, d.folder_id AS folderId
`;

function mapDocument(row: unknown): LibraryDocument {
  return row as LibraryDocument;
}

export function listLibraryDocuments(folderId?: string | null): LibraryDocument[] {
  const rows = folderId === undefined
    ? database.prepare(`SELECT ${summaryColumns} FROM konan_library_documents d ORDER BY d.created_at DESC`).all()
    : folderId === null
      ? database.prepare(`SELECT ${summaryColumns} FROM konan_library_documents d WHERE d.folder_id IS NULL ORDER BY d.created_at DESC`).all()
      : database.prepare(`SELECT ${summaryColumns} FROM konan_library_documents d WHERE d.folder_id = ? ORDER BY d.created_at DESC`).all(folderId);
  return (rows as unknown[]).map(mapDocument);
}

export function listLibraryFolders(parentId: string | null): LibraryFolder[] {
  const rows = parentId === null
    ? database.prepare(`SELECT f.id, f.name, f.parent_id AS parentId, f.created_at AS createdAt, f.updated_at AS updatedAt,
        (SELECT count(*) FROM konan_library_folders child WHERE child.parent_id = f.id) +
        (SELECT count(*) FROM konan_library_documents document WHERE document.folder_id = f.id) AS itemCount
      FROM konan_library_folders f WHERE f.parent_id IS NULL ORDER BY f.name COLLATE NOCASE`).all()
    : database.prepare(`SELECT f.id, f.name, f.parent_id AS parentId, f.created_at AS createdAt, f.updated_at AS updatedAt,
        (SELECT count(*) FROM konan_library_folders child WHERE child.parent_id = f.id) +
        (SELECT count(*) FROM konan_library_documents document WHERE document.folder_id = f.id) AS itemCount
      FROM konan_library_folders f WHERE f.parent_id = ? ORDER BY f.name COLLATE NOCASE`).all(parentId);
  return rows as unknown as LibraryFolder[];
}

export function listAllLibraryFolders(): LibraryFolder[] {
  return database.prepare(`SELECT f.id, f.name, f.parent_id AS parentId, f.created_at AS createdAt, f.updated_at AS updatedAt,
      (SELECT count(*) FROM konan_library_folders child WHERE child.parent_id = f.id) +
      (SELECT count(*) FROM konan_library_documents document WHERE document.folder_id = f.id) AS itemCount
    FROM konan_library_folders f ORDER BY f.name COLLATE NOCASE`).all() as unknown as LibraryFolder[];
}

export function getLibraryFolder(id: string): LibraryFolder | null {
  const row = database.prepare(`SELECT f.id, f.name, f.parent_id AS parentId, f.created_at AS createdAt, f.updated_at AS updatedAt,
      (SELECT count(*) FROM konan_library_folders child WHERE child.parent_id = f.id) +
      (SELECT count(*) FROM konan_library_documents document WHERE document.folder_id = f.id) AS itemCount
    FROM konan_library_folders f WHERE f.id = ?`).get(id);
  return row ? row as unknown as LibraryFolder : null;
}

export function updateLibraryFolder(id: string, patch: { name?: string; parentId?: string | null }): LibraryFolder | null {
  const current = getLibraryFolder(id);
  if (!current) return null;
  const parentId = patch.parentId === undefined ? current.parentId : patch.parentId;
  if (parentId === id) throw new Error("A folder cannot contain itself");
  if (parentId) {
    const cycle = database.prepare(`WITH RECURSIVE descendants(id) AS (
      VALUES (?) UNION ALL SELECT f.id FROM konan_library_folders f JOIN descendants d ON f.parent_id = d.id
    ) SELECT 1 AS found FROM descendants WHERE id = ? LIMIT 1`).get(id, parentId);
    if (cycle) throw new Error("A folder cannot move inside one of its descendants");
  }
  database.prepare("UPDATE konan_library_folders SET name = ?, parent_id = ?, updated_at = ? WHERE id = ?")
    .run(patch.name ?? current.name, parentId, Date.now(), id);
  return getLibraryFolder(id);
}

export function createLibraryFolder(name: string, parentId: string | null): LibraryFolder {
  const id = randomUUID();
  const now = Date.now();
  database.prepare("INSERT INTO konan_library_folders (id, name, parent_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run(id, name, parentId, now, now);
  return getLibraryFolder(id)!;
}

export function deleteLibraryFolder(id: string): "deleted" | "not-found" | "not-empty" {
  const folder = getLibraryFolder(id);
  if (!folder) return "not-found";
  const children = database.prepare("SELECT (SELECT count(*) FROM konan_library_folders WHERE parent_id = ?) + (SELECT count(*) FROM konan_library_documents WHERE folder_id = ?) AS count").get(id, id) as { count: number };
  if (children.count > 0) return "not-empty";
  database.prepare("DELETE FROM konan_library_folders WHERE id = ?").run(id);
  return "deleted";
}

export function getLibraryDocument(id: string): LibraryDocument | null {
  const row = database.prepare(`SELECT ${summaryColumns} FROM konan_library_documents d WHERE d.id = ?`).get(id);
  return row ? mapDocument(row) : null;
}

export function getLibraryDocumentByDigest(sha256: string): LibraryDocument | null {
  const row = database.prepare(`SELECT ${summaryColumns} FROM konan_library_documents d WHERE d.sha256 = ?`).get(sha256);
  return row ? mapDocument(row) : null;
}

export function getStoredLibraryDocument(id: string): StoredLibraryDocument | null {
  const row = database.prepare(`
    SELECT ${summaryColumns}, d.bytes, d.extracted_text AS extractedText
    FROM konan_library_documents d WHERE d.id = ?
  `).get(id);
  return row ? row as unknown as StoredLibraryDocument : null;
}

export function getStoredLibraryDocumentByName(name: string): StoredLibraryDocument | null {
  const row = database.prepare(`
    SELECT ${summaryColumns}, d.bytes, d.extracted_text AS extractedText
    FROM konan_library_documents d WHERE d.name = ? AND d.status = 'ready'
    ORDER BY d.updated_at DESC LIMIT 1
  `).get(name);
  return row ? row as unknown as StoredLibraryDocument : null;
}

export function updateLibraryDocument(id: string, patch: { name?: string; folderId?: string | null }): LibraryDocument | null {
  const current = getLibraryDocument(id);
  if (!current) return null;
  const folderId = patch.folderId === undefined ? current.folderId : patch.folderId;
  database.prepare("UPDATE konan_library_documents SET name = ?, folder_id = ?, updated_at = ? WHERE id = ?")
    .run(patch.name ?? current.name, folderId, Date.now(), id);
  return getLibraryDocument(id);
}

export function createLibraryDocument(input: { name: string; mimeType: string; bytes: Uint8Array; sha256: string; folderId: string | null }): LibraryDocument {
  const now = Date.now();
  const id = randomUUID();
  database.prepare(`
    INSERT INTO konan_library_documents
      (id, name, mime_type, size, sha256, status, bytes, created_at, updated_at, folder_id)
    VALUES (?, ?, ?, ?, ?, 'processing', ?, ?, ?, ?)
  `).run(id, input.name, input.mimeType, input.bytes.byteLength, input.sha256, input.bytes, now, now, input.folderId);
  return getLibraryDocument(id)!;
}

export function completeLibraryDocument(id: string, extractedText: string, chunks: IndexedChunk[]) {
  database.exec("BEGIN IMMEDIATE");
  try {
    database.prepare("DELETE FROM konan_library_chunks_fts WHERE chunk_id IN (SELECT id FROM konan_library_chunks WHERE document_id = ?)").run(id);
    database.prepare("DELETE FROM konan_library_chunks WHERE document_id = ?").run(id);
    const insertChunk = database.prepare("INSERT INTO konan_library_chunks (id, document_id, ordinal, page, text) VALUES (?, ?, ?, ?, ?)");
    const insertFts = database.prepare("INSERT INTO konan_library_chunks_fts (chunk_id, text) VALUES (?, ?)");
    chunks.forEach((chunk, ordinal) => {
      const chunkId = randomUUID();
      insertChunk.run(chunkId, id, ordinal, chunk.page, chunk.text);
      insertFts.run(chunkId, chunk.text);
    });
    database.prepare(`
      UPDATE konan_library_documents
      SET status = 'ready', extracted_text = ?, error = NULL, updated_at = ?
      WHERE id = ?
    `).run(extractedText, Date.now(), id);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

export function failLibraryDocument(id: string, error: string) {
  database.prepare(`
    UPDATE konan_library_documents
    SET status = 'failed', error = ?, updated_at = ?
    WHERE id = ?
  `).run(error.slice(0, 1000), Date.now(), id);
}

export function deleteLibraryDocument(id: string): boolean {
  database.exec("BEGIN IMMEDIATE");
  try {
    database.prepare("DELETE FROM konan_library_chunks_fts WHERE chunk_id IN (SELECT id FROM konan_library_chunks WHERE document_id = ?)").run(id);
    const deleted = database.prepare("DELETE FROM konan_library_documents WHERE id = ?").run(id).changes > 0;
    database.exec("COMMIT");
    return deleted;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function ftsQuery(query: string) {
  const terms = query.toLocaleLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? [];
  return [...new Set(terms)].slice(0, 12).map((term) => `"${term.replaceAll('"', '""')}"*`).join(" OR ");
}

export function searchLibrary(query: string, limit = 6, folderId?: string | null): LibrarySearchResult[] {
  const match = ftsQuery(query);
  if (!match) return [];
  const folderClause = folderId ? "AND d.folder_id IN (SELECT id FROM folder_tree)" : "";
  const statement = database.prepare(`
    WITH RECURSIVE folder_tree(id) AS (
      SELECT ? WHERE ? IS NOT NULL
      UNION ALL
      SELECT f.id FROM konan_library_folders f JOIN folder_tree tree ON f.parent_id = tree.id
    )
    SELECT c.id AS chunkId, c.document_id AS documentId, d.name AS filename,
      c.page, c.text, bm25(konan_library_chunks_fts) AS rank
    FROM konan_library_chunks_fts
    JOIN konan_library_chunks c ON c.id = konan_library_chunks_fts.chunk_id
    JOIN konan_library_documents d ON d.id = c.document_id
    WHERE konan_library_chunks_fts MATCH ? AND d.status = 'ready' ${folderClause}
    ORDER BY rank ASC, c.ordinal ASC
    LIMIT ?
  `);
  const rows = statement.all(folderId ?? null, folderId ?? null, match, Math.max(1, Math.min(limit, 10))) as unknown as Array<Omit<LibrarySearchResult, "score"> & { rank: number }>;
  return rows.map(({ rank, ...row }) => ({ ...row, score: Number((1 / (1 + Math.abs(rank))).toFixed(4)) }));
}
