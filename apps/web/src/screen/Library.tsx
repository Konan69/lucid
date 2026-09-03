import {
  Check, ChevronRight, CircleAlert, ExternalLink, FileText, Folder, FolderPlus,
  LayoutGrid, LoaderCircle, MessageSquareText, MoreHorizontal, Rows3,
  Search, Trash2, Upload,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { cn } from "../ui/cn";

export type LibraryDocument = {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  sha256: string;
  status: "processing" | "ready" | "failed";
  error: string | null;
  preview: string;
  chunkCount: number;
  createdAt: number;
  updatedAt: number;
  folderId: string | null;
};

type LibraryFolder = { id: string; name: string; parentId: string | null; createdAt: number; updatedAt: number };
type SearchResult = { chunkId: string; documentId: string; filename: string; page: number | null; text: string; score: number };
type Tile = { id: string; kind: "folder" | "file"; name: string; meta: string; document?: LibraryDocument; folder?: LibraryFolder };

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(body?.error ?? `Request failed (${response.status})`);
  }
  return response.status === 204 ? undefined as T : response.json() as Promise<T>;
}

function buildTiles(documents: LibraryDocument[], folders: LibraryFolder[]): Tile[] {
  const folderTiles = folders.map((folder): Tile => ({ id: folder.id, kind: "folder", name: folder.name, meta: "Folder", folder }));
  const uploadedTiles = documents.map((document): Tile => ({
    id: document.id,
    kind: "file",
    name: document.name,
    meta: document.status === "ready" ? `${formatBytes(document.size)} · ${document.chunkCount} passages` : document.status === "failed" ? "Failed" : "Indexing…",
    document,
  }));
  return [...folderTiles, ...uploadedTiles];
}

export function Library({ onAsk }: { onAsk: (document: LibraryDocument) => void }) {
  const [grid, setGrid] = useState(true);
  const [folderStack, setFolderStack] = useState<LibraryFolder[]>([]);
  const [folders, setFolders] = useState<LibraryFolder[]>([]);
  const [documents, setDocuments] = useState<LibraryDocument[]>([]);
  const [selected, setSelected] = useState<LibraryDocument | null>(null);
  const [showSearch, setShowSearch] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const currentFolder = folderStack.at(-1) ?? null;
  const currentFolderId = currentFolder?.id ?? null;

  const load = useCallback(async () => {
    try {
      const path = currentFolderId ? `/api/library?folderId=${encodeURIComponent(currentFolderId)}` : "/api/library";
      const body = await request<{ documents: LibraryDocument[]; folders: LibraryFolder[] }>(path);
      setDocuments(body.documents);
      setFolders(body.folders);
      setSelected((current) => current ? body.documents.find((document) => document.id === current.id) ?? null : null);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load the Library");
    }
  }, [currentFolderId]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!documents.some((document) => document.status === "processing")) return;
    const timer = window.setInterval(() => { void load(); }, 900);
    return () => window.clearInterval(timer);
  }, [documents, load]);

  async function uploadFiles(files: File[]) {
    setUploading(true);
    setError(null);
    try {
      for (const file of files) {
        const form = new FormData();
        form.set("file", file);
        if (currentFolderId) form.set("folderId", currentFolderId);
        await request<{ document: LibraryDocument }>("/api/library", { method: "POST", body: form });
      }
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not upload the document");
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  async function createFolder() {
    const name = window.prompt("Folder name")?.trim();
    if (!name) return;
    try {
      await request("/api/library/folders", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, parentId: currentFolderId }),
      });
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not create the folder");
    }
  }

  async function search(event: FormEvent) {
    event.preventDefault();
    if (query.trim().length < 2) return;
    try {
      const body = await request<{ results: SearchResult[] }>("/api/library/search", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: query.trim(), limit: 8 }),
      });
      setResults(body.results);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Search failed");
    }
  }

  async function remove(document: LibraryDocument) {
    if (!window.confirm(`Delete “${document.name}” from the Library?`)) return;
    try {
      await request(`/api/library/${encodeURIComponent(document.id)}`, { method: "DELETE" });
      setDocuments((current) => current.filter((item) => item.id !== document.id));
      setSelected(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not delete the document");
    }
  }

  const tiles = buildTiles(documents, folders);
  const open = (tile: Tile) => {
    if (tile.document) return setSelected(tile.document);
    if (tile.folder) setFolderStack((current) => [...current, tile.folder!]);
  };
  const back = () => {
    if (selected) setSelected(null);
    else if (results) setResults(null);
    else setFolderStack((current) => current.slice(0, -1));
  };

  return (
    <section className="flex h-full min-w-0 flex-1 flex-col bg-surface-0" style={{ boxShadow: "var(--content-edge-shadow, none)" }}>
      <header className="flex h-(--topbar-h) shrink-0 items-center gap-2 px-4">
        {(currentFolder || selected || results) && <button onClick={back} aria-label="Back" className="mr-1 inline-flex size-8 items-center justify-center rounded-control text-ink-3 hover:bg-wash-hover hover:text-ink"><ChevronRight className="size-4 rotate-180" /></button>}
        <h1 className="min-w-0 flex-1 truncate text-title font-title text-ink">{selected?.name ?? (results ? "Search results" : currentFolder?.name ?? "Library")}</h1>
        {!selected && <>
          <button aria-label="New folder" onClick={() => void createFolder()} className="inline-flex size-8 items-center justify-center rounded-control text-ink-3 hover:bg-wash-hover hover:text-ink"><FolderPlus className="size-4" /></button>
          <button aria-label="Upload files" disabled={uploading} onClick={() => inputRef.current?.click()} className="inline-flex size-8 items-center justify-center rounded-control text-ink-3 hover:bg-wash-hover hover:text-ink disabled:opacity-50">{uploading ? <LoaderCircle className="size-4 animate-spin" /> : <Upload className="size-4" />}</button>
          <button aria-label="Search Library" onClick={() => { setShowSearch((value) => !value); setResults(null); }} className="inline-flex size-8 items-center justify-center rounded-control text-ink-3 hover:bg-wash-hover hover:text-ink"><Search className="size-4" /></button>
          <div className="flex items-center rounded-control bg-surface-2 p-0.5">
            <button aria-label="Grid" onClick={() => setGrid(true)} className={cn("inline-flex size-7 items-center justify-center rounded-sm", grid ? "bg-surface-3 shadow-ring-xs text-ink" : "text-ink-3 hover:text-ink")}><LayoutGrid className="size-4" /></button>
            <button aria-label="List" onClick={() => setGrid(false)} className={cn("inline-flex size-7 items-center justify-center rounded-sm", !grid ? "bg-surface-3 shadow-ring-xs text-ink" : "text-ink-3 hover:text-ink")}><Rows3 className="size-4" /></button>
          </div>
        </>}
        <input ref={inputRef} type="file" multiple accept=".pdf,.md,.markdown,.txt,application/pdf,text/markdown,text/plain" className="hidden" onChange={(event) => { const files = [...(event.currentTarget.files ?? [])]; if (files.length) void uploadFiles(files); }} />
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto scroll-fade-y">
        <div className="mx-auto w-full max-w-[920px] px-5 pb-10 pt-2 sm:px-8">
          {error && <div className="mb-3 rounded-control bg-danger-soft px-3 py-2 text-label text-danger" role="alert">{error}</div>}
          {selected ? <DocumentDetail document={selected} onAsk={() => onAsk(selected)} onDelete={() => void remove(selected)} /> : <>
            {showSearch && <form onSubmit={(event) => void search(event)} className="mb-3 flex items-center gap-2 rounded-control bg-surface-2 px-3 shadow-ring-xs"><Search className="size-4 text-ink-4" /><input autoFocus value={query} onChange={(event) => setQuery(event.currentTarget.value)} placeholder="Search files" className="h-10 min-w-0 flex-1 bg-transparent text-label text-ink outline-none placeholder:text-ink-4" /></form>}
            {results ? <SearchResults results={results} documents={documents} onOpen={setSelected} /> : <>
              {grid ? <TileGrid tiles={tiles} onOpen={open} /> : <TileList tiles={tiles} onOpen={open} />}
            </>}
          </>}
        </div>
      </div>
    </section>
  );
}

function TileGrid({ tiles, onOpen }: { tiles: Tile[]; onOpen: (tile: Tile) => void }) {
  const folderTiles = tiles.filter((tile) => tile.kind !== "file");
  const files = tiles.filter((tile) => tile.kind === "file");
  return <div className="mt-3">
    <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3">{folderTiles.map((tile) => <li key={tile.id}><button onClick={() => onOpen(tile)} className="group/row flex w-full items-center gap-2.5 rounded-card bg-surface-2 px-3 py-2.5 text-left shadow-ring-xs transition-[background-color,box-shadow] duration-(--dur-fast) hover:bg-wash-hover hover:shadow-ring-sm"><span className="inline-flex size-7 shrink-0 items-center justify-center text-ink-3"><Folder className="size-5" strokeWidth={1.7} /></span><span className="min-w-0 flex-1 truncate text-label text-ink">{tile.name}</span><span className="text-meta font-meta text-ink-4">{tile.meta}</span></button></li>)}</ul>
    <ul className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">{files.map((tile) => <li key={tile.id}><button onClick={() => onOpen(tile)} className="group/tile flex w-full flex-col overflow-hidden rounded-card bg-surface-2 p-3 text-left shadow-ring-sm ring-line transition-[background-color,box-shadow,transform] duration-(--dur-fast) hover:-translate-y-0.5 hover:bg-surface-3 hover:shadow-ring-md active:scale-[0.98]"><span className="flex items-center gap-2"><span className="shrink-0 text-ink-3"><FileText className="size-4" strokeWidth={1.6} /></span><span className="min-w-0 flex-1 truncate text-label text-ink">{tile.name}</span>{tile.document?.status === "processing" ? <LoaderCircle className="size-4 shrink-0 animate-spin text-working" /> : <MoreHorizontal className="size-4 shrink-0 text-ink-4 opacity-0 transition-opacity group-hover/tile:opacity-100" />}</span><span className="relative mt-3 block aspect-[4/3] overflow-hidden rounded-control bg-surface-1 ring-line"><Preview /></span></button></li>)}</ul>
  </div>;
}

function TileList({ tiles, onOpen }: { tiles: Tile[]; onOpen: (tile: Tile) => void }) {
  return <ul className="mt-3">{tiles.map((tile) => <li key={tile.id}><button onClick={() => onOpen(tile)} className="group/row flex w-full items-center gap-3 rounded-row px-2.5 py-2 text-left outline-none select-none transition-colors duration-(--dur-fast) hover:bg-wash-hover"><span className={cn("inline-flex size-8 shrink-0 items-center justify-center rounded-control", tile.kind === "folder" ? "bg-accent-soft text-accent-ink" : "bg-surface-2 text-ink-3 shadow-ring-xs")}>{tile.kind === "file" ? <FileText className="size-[18px]" strokeWidth={1.7} /> : <Folder className="size-[18px]" strokeWidth={1.7} />}</span><span className="min-w-0 flex-1 truncate text-title text-ink">{tile.name}</span><span className="text-meta font-meta text-ink-4">{tile.meta}</span><MoreHorizontal className="size-4 shrink-0 text-ink-4 opacity-0 transition-opacity group-hover/row:opacity-100" /></button></li>)}</ul>;
}

function DocumentDetail({ document, onAsk, onDelete }: { document: LibraryDocument; onAsk: () => void; onDelete: () => void }) {
  return <div className="mt-3"><div className="flex items-center gap-3"><span className="inline-flex size-9 items-center justify-center rounded-control bg-surface-2 text-ink-3 shadow-ring-xs"><FileText className="size-[18px]" /></span><div className="min-w-0 flex-1"><p className="truncate text-title text-ink">{document.name}</p><p className="text-meta font-meta text-ink-4">{formatBytes(document.size)} · {document.chunkCount} passages</p></div><a href={`/api/library/${encodeURIComponent(document.id)}/content`} target="_blank" rel="noreferrer" aria-label="Open original" className="inline-flex size-8 items-center justify-center rounded-control text-ink-3 hover:bg-wash-hover"><ExternalLink className="size-4" /></a><button onClick={onDelete} aria-label="Delete file" className="inline-flex size-8 items-center justify-center rounded-control text-ink-3 hover:bg-danger-soft hover:text-danger"><Trash2 className="size-4" /></button></div><div className="mt-5 rounded-card bg-surface-2 p-5 shadow-ring-xs"><Status document={document} /><p className="mt-4 whitespace-pre-wrap text-label leading-relaxed text-ink-3">{document.preview || document.error || "Extracting and indexing text…"}</p></div>{document.status === "ready" && <button onClick={onAsk} className="mt-4 inline-flex h-9 items-center gap-2 rounded-control bg-accent px-4 text-label font-title text-ink-on-accent"><MessageSquareText className="size-4" />Ask Vivid about this</button>}</div>;
}

function Status({ document }: { document: LibraryDocument }) {
  return <span className={cn("inline-flex items-center gap-1 text-meta font-meta", document.status === "ready" ? "text-success" : document.status === "failed" ? "text-danger" : "text-working")}>{document.status === "ready" ? <Check className="size-3" /> : document.status === "failed" ? <CircleAlert className="size-3" /> : <LoaderCircle className="size-3 animate-spin" />}{document.status === "ready" ? "Ready" : document.status === "failed" ? "Failed" : "Indexing"}</span>;
}

function SearchResults({ results, documents, onOpen }: { results: SearchResult[]; documents: LibraryDocument[]; onOpen: (document: LibraryDocument) => void }) {
  return <ul className="mt-3">{results.length === 0 ? <li className="py-12 text-center text-label text-ink-4">No matching files.</li> : results.map((result) => <li key={result.chunkId}><button onClick={() => { const document = documents.find((item) => item.id === result.documentId); if (document) onOpen(document); }} className="group/row flex w-full items-start gap-3 rounded-row px-2.5 py-3 text-left hover:bg-wash-hover"><span className="inline-flex size-8 shrink-0 items-center justify-center rounded-control bg-surface-2 text-ink-3 shadow-ring-xs"><FileText className="size-4" /></span><span className="min-w-0 flex-1"><span className="block truncate text-title text-ink">{result.filename}</span><span className="mt-1 line-clamp-2 block text-label text-ink-3">{result.text}</span></span>{result.page && <span className="text-meta font-meta text-ink-4">Page {result.page}</span>}</button></li>)}</ul>;
}

function Preview() {
  return <span aria-hidden className="absolute inset-x-7 inset-y-3 flex flex-col gap-1.5 rounded-sm bg-surface-3 p-2.5 shadow-ring-xs"><i className="h-2 w-1/2 rounded-full bg-ink/15" /><i className="mt-1 h-1 w-full rounded-full bg-line-1" /><i className="h-1 w-11/12 rounded-full bg-line-1" /><i className="h-1 w-4/5 rounded-full bg-line-1" /><i className="mt-auto h-1 w-2/3 rounded-full bg-line-1" /></span>;
}
