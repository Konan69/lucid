import {
  Check, ChevronRight, CircleAlert, ExternalLink, FileInput, FileText, Folder,
  FolderInput, FolderPlus, LayoutGrid, LoaderCircle, MessageSquareText,
  MoreHorizontal, Pencil, Rows3, Search, Trash2, Upload, X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState, type DragEvent, type FormEvent } from "react";
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

export type LibraryFolder = {
  id: string;
  name: string;
  parentId: string | null;
  createdAt: number;
  updatedAt: number;
  itemCount: number;
};

type SearchResult = { chunkId: string; documentId: string; filename: string; page: number | null; text: string; score: number };
type Tile = { id: string; kind: "folder" | "file"; name: string; meta: string; document?: LibraryDocument; folder?: LibraryFolder };
type UploadState = { id: string; name: string; progress: number; status: "uploading" | "indexing" | "failed"; error?: string };
type DialogState =
  | { kind: "new-folder" }
  | { kind: "rename-folder"; folder: LibraryFolder }
  | { kind: "move-folder"; folder: LibraryFolder }
  | { kind: "rename-file"; document: LibraryDocument }
  | { kind: "move-file"; document: LibraryDocument };

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
  return [
    ...folders.map((folder): Tile => ({
      id: folder.id,
      kind: "folder",
      name: folder.name,
      meta: `${folder.itemCount} ${folder.itemCount === 1 ? "item" : "items"}`,
      folder,
    })),
    ...documents.map((document): Tile => ({
      id: document.id,
      kind: "file",
      name: document.name,
      meta: document.status === "ready"
        ? `${formatBytes(document.size)} · ${document.chunkCount} passages`
        : document.status === "failed" ? "Failed" : "Indexing…",
      document,
    })),
  ];
}

function uploadWithProgress(file: File, folderId: string | null, onProgress: (progress: number) => void) {
  return new Promise<LibraryDocument>((resolve, reject) => {
    const form = new FormData();
    form.set("file", file);
    if (folderId) form.set("folderId", folderId);
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/library");
    xhr.responseType = "json";
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(Math.round((event.loaded / event.total) * 100));
    };
    xhr.onerror = () => reject(new Error("Upload failed"));
    xhr.onload = () => {
      const body = xhr.response as { document?: LibraryDocument; error?: string } | null;
      if (xhr.status >= 200 && xhr.status < 300 && body?.document) resolve(body.document);
      else reject(new Error(body?.error ?? `Upload failed (${xhr.status})`));
    };
    xhr.send(form);
  });
}

export function Library({ onAsk }: { onAsk: (document: LibraryDocument) => void }) {
  const [grid, setGrid] = useState(true);
  const [folderStack, setFolderStack] = useState<LibraryFolder[]>([]);
  const [folders, setFolders] = useState<LibraryFolder[]>([]);
  const [allFolders, setAllFolders] = useState<LibraryFolder[]>([]);
  const [documents, setDocuments] = useState<LibraryDocument[]>([]);
  const [selected, setSelected] = useState<LibraryDocument | null>(null);
  const [showSearch, setShowSearch] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [uploads, setUploads] = useState<UploadState[]>([]);
  const [dragging, setDragging] = useState(false);
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);
  const currentFolder = folderStack.at(-1) ?? null;
  const currentFolderId = currentFolder?.id ?? null;

  const load = useCallback(async () => {
    try {
      const path = currentFolderId ? `/api/library?folderId=${encodeURIComponent(currentFolderId)}` : "/api/library";
      const [body, folderBody] = await Promise.all([
        request<{ documents: LibraryDocument[]; folders: LibraryFolder[] }>(path),
        request<{ folders: LibraryFolder[] }>("/api/library/folders"),
      ]);
      setDocuments(body.documents);
      setFolders(body.folders);
      setAllFolders(folderBody.folders);
      setSelected((current) => current ? body.documents.find((document) => document.id === current.id) ?? current : null);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load the Library");
    }
  }, [currentFolderId]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!documents.some((document) => document.status === "processing") && !uploads.some((upload) => upload.status === "indexing")) return;
    const timer = window.setInterval(() => { void load(); }, 900);
    return () => window.clearInterval(timer);
  }, [documents, load, uploads]);

  async function uploadFiles(files: File[]) {
    const states = files.map((file) => ({ id: `${file.name}-${file.size}-${file.lastModified}`, name: file.name, progress: 0, status: "uploading" as const }));
    setUploads((current) => [...states, ...current].slice(0, 8));
    setError(null);
    await Promise.all(files.map(async (file, index) => {
      const id = states[index]!.id;
      try {
        await uploadWithProgress(file, currentFolderId, (progress) => setUploads((current) => current.map((item) => item.id === id ? { ...item, progress } : item)));
        setUploads((current) => current.map((item) => item.id === id ? { ...item, progress: 100, status: "indexing" } : item));
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : "Upload failed";
        setUploads((current) => current.map((item) => item.id === id ? { ...item, status: "failed", error: message } : item));
      }
    }));
    if (inputRef.current) inputRef.current.value = "";
    await load();
    window.setTimeout(() => setUploads((current) => current.filter((item) => item.status === "failed")), 1800);
  }

  async function search(event: FormEvent) {
    event.preventDefault();
    if (query.trim().length < 2) return;
    try {
      const body = await request<{ results: SearchResult[] }>("/api/library/search", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: query.trim(), limit: 8, folderId: currentFolderId }),
      });
      setResults(body.results);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Search failed");
    }
  }

  async function removeDocument(document: LibraryDocument) {
    if (!window.confirm(`Delete “${document.name}” from the Library?`)) return;
    try {
      await request(`/api/library/${encodeURIComponent(document.id)}`, { method: "DELETE" });
      setSelected(null);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not delete the file");
    }
  }

  async function removeCurrentFolder() {
    if (!currentFolder || !window.confirm(`Delete the empty folder “${currentFolder.name}”?`)) return;
    try {
      await request(`/api/library/folders/${encodeURIComponent(currentFolder.id)}`, { method: "DELETE" });
      setFolderStack((current) => current.slice(0, -1));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not delete the folder");
    }
  }

  async function openSearchResult(result: SearchResult) {
    try {
      const body = await request<{ document: LibraryDocument }>(`/api/library/${encodeURIComponent(result.documentId)}`);
      setSelected(body.document);
      setResults(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not open the file");
    }
  }

  const tiles = buildTiles(documents, folders);
  const open = (tile: Tile) => {
    if (tile.document) setSelected(tile.document);
    else if (tile.folder) setFolderStack((current) => [...current, tile.folder!]);
  };
  const back = () => {
    if (selected) setSelected(null);
    else if (results) setResults(null);
    else setFolderStack((current) => current.slice(0, -1));
  };
  const handleDragEnter = (event: DragEvent) => { event.preventDefault(); dragDepth.current += 1; setDragging(true); };
  const handleDragLeave = (event: DragEvent) => { event.preventDefault(); dragDepth.current -= 1; if (dragDepth.current <= 0) setDragging(false); };
  const handleDrop = (event: DragEvent) => {
    event.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    const files = [...event.dataTransfer.files];
    if (files.length) void uploadFiles(files);
  };

  return (
    <section onDragEnter={handleDragEnter} onDragOver={(event) => event.preventDefault()} onDragLeave={handleDragLeave} onDrop={handleDrop} className="relative flex h-full min-w-0 flex-1 flex-col bg-surface-0" style={{ boxShadow: "var(--content-edge-shadow, none)" }}>
      <header className="flex h-(--topbar-h) shrink-0 items-center gap-2 px-4">
        {(currentFolder || selected || results) && <button onClick={back} aria-label="Back" className="mr-1 inline-flex size-8 items-center justify-center rounded-control text-ink-3 hover:bg-wash-hover hover:text-ink"><ChevronRight className="size-4 rotate-180" /></button>}
        <h1 className="min-w-0 flex-1 truncate text-title font-title text-ink">{selected?.name ?? (results ? "Search results" : currentFolder?.name ?? "Library")}</h1>
        {!selected && <>
          {currentFolder && <>
            <button aria-label="Rename folder" onClick={() => setDialog({ kind: "rename-folder", folder: currentFolder })} className="inline-flex size-8 items-center justify-center rounded-control text-ink-3 hover:bg-wash-hover hover:text-ink"><Pencil className="size-4" /></button>
            <button aria-label="Move folder" onClick={() => setDialog({ kind: "move-folder", folder: currentFolder })} className="inline-flex size-8 items-center justify-center rounded-control text-ink-3 hover:bg-wash-hover hover:text-ink"><FolderInput className="size-4" /></button>
            <button aria-label="Delete folder" onClick={() => void removeCurrentFolder()} className="inline-flex size-8 items-center justify-center rounded-control text-ink-3 hover:bg-danger-soft hover:text-danger"><Trash2 className="size-4" /></button>
          </>}
          <button aria-label="New folder" onClick={() => setDialog({ kind: "new-folder" })} className="inline-flex size-8 items-center justify-center rounded-control text-ink-3 hover:bg-wash-hover hover:text-ink"><FolderPlus className="size-4" /></button>
          <button aria-label="Upload files" onClick={() => inputRef.current?.click()} className="inline-flex size-8 items-center justify-center rounded-control text-ink-3 hover:bg-wash-hover hover:text-ink"><Upload className="size-4" /></button>
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
          {uploads.length > 0 && <UploadProgress uploads={uploads} />}
          {selected ? <DocumentDetail document={selected} onAsk={() => onAsk(selected)} onDelete={() => void removeDocument(selected)} onRename={() => setDialog({ kind: "rename-file", document: selected })} onMove={() => setDialog({ kind: "move-file", document: selected })} /> : <>
            {showSearch && <form onSubmit={(event) => void search(event)} className="mb-3 flex items-center gap-2 rounded-control bg-surface-2 px-3 shadow-ring-xs"><Search className="size-4 text-ink-4" /><input autoFocus value={query} onChange={(event) => setQuery(event.currentTarget.value)} placeholder={currentFolder ? `Search ${currentFolder.name}` : "Search all files"} className="h-10 min-w-0 flex-1 bg-transparent text-label text-ink outline-none placeholder:text-ink-4" /></form>}
            {results ? <SearchResults results={results} onOpen={(result) => void openSearchResult(result)} /> : grid ? <TileGrid tiles={tiles} onOpen={open} /> : <TileList tiles={tiles} onOpen={open} />}
          </>}
        </div>
      </div>
      {dragging && <div className="pointer-events-none absolute inset-3 z-20 flex items-center justify-center rounded-card border-2 border-dashed border-accent bg-surface-0/90 text-center"><div><Upload className="mx-auto size-7 text-accent-ink" /><p className="mt-2 text-title font-title text-ink">Drop files into {currentFolder?.name ?? "Library"}</p><p className="mt-1 text-meta font-meta text-ink-4">PDF, Markdown, or text · up to 10 MB each</p></div></div>}
      {dialog && <LibraryDialog state={dialog} folders={allFolders} currentFolderId={currentFolderId} onClose={() => setDialog(null)} onSaved={async (result) => {
        if (result.folder && dialog.kind === "rename-folder") setFolderStack((current) => current.map((folder) => folder.id === result.folder!.id ? result.folder! : folder));
        if (result.document) setSelected(result.document.folderId === currentFolderId ? result.document : null);
        if (dialog.kind === "move-folder") setFolderStack([]);
        setDialog(null);
        await load();
      }} />}
    </section>
  );
}

function UploadProgress({ uploads }: { uploads: UploadState[] }) {
  return <ul className="mb-3 space-y-1">{uploads.map((upload) => <li key={upload.id} className="flex items-center gap-3 rounded-row bg-surface-2 px-3 py-2 shadow-ring-xs"><FileText className="size-4 shrink-0 text-ink-3" /><span className="min-w-0 flex-1"><span className="block truncate text-label text-ink">{upload.name}</span><span className="mt-1 block h-1 overflow-hidden rounded-full bg-line-2"><i className={cn("block h-full rounded-full transition-[width]", upload.status === "failed" ? "bg-danger" : "bg-accent")} style={{ width: `${upload.progress}%` }} /></span></span><span className={cn("text-meta font-meta", upload.status === "failed" ? "text-danger" : "text-ink-4")}>{upload.status === "uploading" ? `${upload.progress}%` : upload.status === "indexing" ? "Indexing" : upload.error}</span></li>)}</ul>;
}

function LibraryDialog({ state, folders, currentFolderId, onClose, onSaved }: { state: DialogState; folders: LibraryFolder[]; currentFolderId: string | null; onClose: () => void; onSaved: (result: { folder?: LibraryFolder; document?: LibraryDocument }) => Promise<void> }) {
  const moving = state.kind === "move-file" || state.kind === "move-folder";
  const originalName = "folder" in state ? state.folder.name : "document" in state ? state.document.name : "";
  const [name, setName] = useState(originalName);
  const [destination, setDestination] = useState<string>(moving ? "" : currentFolderId ?? "");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const unavailable = state.kind === "move-folder" ? new Set([state.folder.id]) : new Set<string>();

  async function submit(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      if (state.kind === "new-folder") {
        const body = await request<{ folder: LibraryFolder }>("/api/library/folders", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, parentId: currentFolderId }) });
        await onSaved({ folder: body.folder });
      } else if (state.kind === "rename-folder" || state.kind === "move-folder") {
        const body = await request<{ folder: LibraryFolder }>(`/api/library/folders/${encodeURIComponent(state.folder.id)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(state.kind === "rename-folder" ? { name } : { parentId: destination || null }) });
        await onSaved({ folder: body.folder });
      } else {
        const body = await request<{ document: LibraryDocument }>(`/api/library/${encodeURIComponent(state.document.id)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(state.kind === "rename-file" ? { name } : { folderId: destination || null }) });
        await onSaved({ document: body.document });
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save changes");
      setPending(false);
    }
  }

  const title = state.kind === "new-folder" ? "New folder" : state.kind === "rename-folder" ? "Rename folder" : state.kind === "move-folder" ? "Move folder" : state.kind === "rename-file" ? "Rename file" : "Move file";
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/20 p-4 backdrop-blur-[2px]" role="dialog" aria-modal="true" aria-label={title}><form onSubmit={(event) => void submit(event)} className="w-full max-w-sm rounded-panel bg-surface-1 p-4 shadow-ring-md"><div className="flex items-center gap-2"><h2 className="flex-1 text-dialog font-title text-ink">{title}</h2><button type="button" onClick={onClose} aria-label="Close" className="inline-flex size-8 items-center justify-center rounded-control text-ink-3 hover:bg-wash-hover"><X className="size-4" /></button></div>{moving ? <label className="mt-4 block"><span className="mb-1.5 block text-label font-title text-ink-2">Destination</span><select value={destination} onChange={(event) => setDestination(event.currentTarget.value)} className="h-10 w-full rounded-control bg-surface-2 px-3 text-label text-ink shadow-ring-xs"><option value="">Library</option>{folders.filter((folder) => !unavailable.has(folder.id)).map((folder) => <option key={folder.id} value={folder.id}>{folder.name}</option>)}</select></label> : <label className="mt-4 block"><span className="mb-1.5 block text-label font-title text-ink-2">Name</span><input autoFocus required maxLength={state.kind === "rename-file" ? 180 : 120} value={name} onChange={(event) => setName(event.currentTarget.value)} className="h-10 w-full rounded-control bg-surface-2 px-3 text-label text-ink shadow-ring-xs outline-none focus:shadow-ring-sm" /></label>}{error && <p className="mt-3 text-label text-danger">{error}</p>}<div className="mt-5 flex justify-end gap-2"><button type="button" onClick={onClose} className="h-9 rounded-control px-3 text-label text-ink-3 hover:bg-wash-hover">Cancel</button><button disabled={pending} className="inline-flex h-9 items-center gap-2 rounded-control bg-accent px-4 text-label font-title text-ink-on-accent disabled:opacity-50">{pending && <LoaderCircle className="size-3.5 animate-spin" />}{moving ? "Move" : "Save"}</button></div></form></div>;
}

function TileGrid({ tiles, onOpen }: { tiles: Tile[]; onOpen: (tile: Tile) => void }) {
  const folderTiles = tiles.filter((tile) => tile.kind === "folder");
  const files = tiles.filter((tile) => tile.kind === "file");
  return <div className="mt-3"><ul className="grid grid-cols-2 gap-2 sm:grid-cols-3">{folderTiles.map((tile) => <li key={tile.id}><button onClick={() => onOpen(tile)} className="group/row flex w-full items-center gap-2.5 rounded-card bg-surface-2 px-3 py-2.5 text-left shadow-ring-xs transition-[background-color,box-shadow] duration-(--dur-fast) hover:bg-wash-hover hover:shadow-ring-sm"><span className="inline-flex size-7 shrink-0 items-center justify-center text-ink-3"><Folder className="size-5" strokeWidth={1.7} /></span><span className="min-w-0 flex-1 truncate text-label text-ink">{tile.name}</span><span className="text-meta font-meta text-ink-4">{tile.meta}</span></button></li>)}</ul><ul className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">{files.map((tile) => <li key={tile.id}><button onClick={() => onOpen(tile)} className="group/tile flex w-full flex-col overflow-hidden rounded-card bg-surface-2 p-3 text-left shadow-ring-sm ring-line transition-[background-color,box-shadow,transform] duration-(--dur-fast) hover:-translate-y-0.5 hover:bg-surface-3 hover:shadow-ring-md active:scale-[0.98]"><span className="flex items-center gap-2"><FileText className="size-4 shrink-0 text-ink-3" strokeWidth={1.6} /><span className="min-w-0 flex-1 truncate text-label text-ink">{tile.name}</span>{tile.document?.status === "processing" ? <LoaderCircle className="size-4 shrink-0 animate-spin text-working" /> : <MoreHorizontal className="size-4 shrink-0 text-ink-4 opacity-0 transition-opacity group-hover/tile:opacity-100" />}</span><span className="relative mt-3 block aspect-[4/3] overflow-hidden rounded-control bg-surface-1 ring-line"><Preview /></span></button></li>)}</ul></div>;
}

function TileList({ tiles, onOpen }: { tiles: Tile[]; onOpen: (tile: Tile) => void }) {
  return <ul className="mt-3">{tiles.map((tile) => <li key={tile.id}><button onClick={() => onOpen(tile)} className="group/row flex w-full items-center gap-3 rounded-row px-2.5 py-2 text-left outline-none select-none transition-colors duration-(--dur-fast) hover:bg-wash-hover"><span className={cn("inline-flex size-8 shrink-0 items-center justify-center rounded-control", tile.kind === "folder" ? "bg-accent-soft text-accent-ink" : "bg-surface-2 text-ink-3 shadow-ring-xs")}>{tile.kind === "file" ? <FileText className="size-[18px]" /> : <Folder className="size-[18px]" />}</span><span className="min-w-0 flex-1 truncate text-title text-ink">{tile.name}</span><span className="text-meta font-meta text-ink-4">{tile.meta}</span><MoreHorizontal className="size-4 shrink-0 text-ink-4 opacity-0 transition-opacity group-hover/row:opacity-100" /></button></li>)}</ul>;
}

function DocumentDetail({ document, onAsk, onDelete, onRename, onMove }: { document: LibraryDocument; onAsk: () => void; onDelete: () => void; onRename: () => void; onMove: () => void }) {
  return <div className="mt-3"><div className="flex items-center gap-3"><span className="inline-flex size-9 items-center justify-center rounded-control bg-surface-2 text-ink-3 shadow-ring-xs"><FileText className="size-[18px]" /></span><div className="min-w-0 flex-1"><p className="truncate text-title text-ink">{document.name}</p><p className="text-meta font-meta text-ink-4">{formatBytes(document.size)} · {document.chunkCount} passages</p></div><button onClick={onRename} aria-label="Rename file" className="inline-flex size-8 items-center justify-center rounded-control text-ink-3 hover:bg-wash-hover"><Pencil className="size-4" /></button><button onClick={onMove} aria-label="Move file" className="inline-flex size-8 items-center justify-center rounded-control text-ink-3 hover:bg-wash-hover"><FileInput className="size-4" /></button><a href={`/api/library/${encodeURIComponent(document.id)}/content`} target="_blank" rel="noreferrer" aria-label="Open original" className="inline-flex size-8 items-center justify-center rounded-control text-ink-3 hover:bg-wash-hover"><ExternalLink className="size-4" /></a><button onClick={onDelete} aria-label="Delete file" className="inline-flex size-8 items-center justify-center rounded-control text-ink-3 hover:bg-danger-soft hover:text-danger"><Trash2 className="size-4" /></button></div><div className="mt-5 rounded-card bg-surface-2 p-5 shadow-ring-xs"><Status document={document} /><p className="mt-4 whitespace-pre-wrap text-label leading-relaxed text-ink-3">{document.preview || document.error || "Extracting and indexing text…"}</p></div>{document.status === "ready" && <button onClick={onAsk} className="mt-4 inline-flex h-9 items-center gap-2 rounded-control bg-accent px-4 text-label font-title text-ink-on-accent"><MessageSquareText className="size-4" />Ask Vivid about this</button>}</div>;
}

function Status({ document }: { document: LibraryDocument }) {
  return <span className={cn("inline-flex items-center gap-1 text-meta font-meta", document.status === "ready" ? "text-success" : document.status === "failed" ? "text-danger" : "text-working")}>{document.status === "ready" ? <Check className="size-3" /> : document.status === "failed" ? <CircleAlert className="size-3" /> : <LoaderCircle className="size-3 animate-spin" />}{document.status === "ready" ? "Ready" : document.status === "failed" ? "Failed" : "Indexing"}</span>;
}

function SearchResults({ results, onOpen }: { results: SearchResult[]; onOpen: (result: SearchResult) => void }) {
  return <ul className="mt-3">{results.length === 0 ? <li className="py-12 text-center text-label text-ink-4">No matching files.</li> : results.map((result) => <li key={result.chunkId}><button onClick={() => onOpen(result)} className="group/row flex w-full items-start gap-3 rounded-row px-2.5 py-3 text-left hover:bg-wash-hover"><span className="inline-flex size-8 shrink-0 items-center justify-center rounded-control bg-surface-2 text-ink-3 shadow-ring-xs"><FileText className="size-4" /></span><span className="min-w-0 flex-1"><span className="block truncate text-title text-ink">{result.filename}</span><span className="mt-1 line-clamp-2 block text-label text-ink-3">{result.text}</span></span>{result.page && <span className="text-meta font-meta text-ink-4">Page {result.page}</span>}</button></li>)}</ul>;
}

function Preview() {
  return <span aria-hidden className="absolute inset-x-7 inset-y-3 flex flex-col gap-1.5 rounded-sm bg-surface-3 p-2.5 shadow-ring-xs"><i className="h-2 w-1/2 rounded-full bg-ink/15" /><i className="mt-1 h-1 w-full rounded-full bg-line-1" /><i className="h-1 w-11/12 rounded-full bg-line-1" /><i className="h-1 w-4/5 rounded-full bg-line-1" /><i className="mt-auto h-1 w-2/3 rounded-full bg-line-1" /></span>;
}
