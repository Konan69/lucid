import { ChevronRight, Search, LayoutGrid, Rows3, Folder, Brain, FileText, Table2, CalendarCheck2, Receipt, ListChecks, Image as ImageIcon, MoreHorizontal } from "lucide-react";
import { useState } from "react";
import { folders, memoryFolders, recentFiles, memoryFiles, type ItemKind, type LibraryItem, type LibraryFolder } from "../data/library";
import { cn } from "../ui/cn";

const kindIcon: Record<ItemKind, React.ReactNode> = {
  doc: <FileText className="size-4" strokeWidth={1.6} />,
  sheet: <Table2 className="size-4" strokeWidth={1.6} />,
  booking: <CalendarCheck2 className="size-4" strokeWidth={1.6} />,
  receipt: <Receipt className="size-4" strokeWidth={1.6} />,
  list: <ListChecks className="size-4" strokeWidth={1.6} />,
  image: <ImageIcon className="size-4" strokeWidth={1.6} />,
  memory: <Brain className="size-4" strokeWidth={1.6} />,
};

/* Real names with real extensions, Drive-style. No obfuscation. */
const ext: Partial<Record<ItemKind, string>> = { doc: "pdf", sheet: "xlsx", receipt: "pdf", booking: "pdf", list: "txt" };

function fileName(it: LibraryItem, memory: boolean) {
  if (memory) return it.name;
  const e = ext[it.kind];
  return e ? `${it.name}.${e}` : it.name;
}

type Tile = { id: string; kind: "folder" | "memory" | "file"; name: string; meta: string; file?: LibraryItem };

function buildTiles(inMemory: boolean): Tile[] {
  const fs: Tile[] = (inMemory ? memoryFolders : folders).map((f) => ({
    id: f.id,
    kind: f.memory ? "memory" : "folder",
    name: f.name,
    meta: f.memory ? `${f.count} notes` : `${f.count} files`,
  }));
  const items = inMemory ? memoryFiles : recentFiles;
  return [
    ...fs,
    ...items.map((it): Tile => ({ id: it.id, kind: "file", name: fileName(it, !!it.size && it.size.includes("notes")), meta: `${it.size} · ${it.time}`, file: it })),
  ];
}

/* ── Flat library: folders and files together, iOS Files style ── */
export function Library() {
  const [inMemory, setInMemory] = useState(false);
  const [grid, setGrid] = useState(true);
  const [crumb, setCrumb] = useState<LibraryFolder | null>(null);
  const tiles = buildTiles(inMemory);

  const open = (t: Tile) => {
    if (t.kind === "folder") {
      setInMemory(false);
      setCrumb(folders.find((f) => f.id === t.id) ?? null);
    } else if (t.kind === "memory") {
      setInMemory(true);
      setCrumb(memoryFolders.find((f) => f.id === t.id) ?? null);
    }
  };

  return (
    <section className="flex h-full min-w-0 flex-1 flex-col bg-surface-0" style={{ boxShadow: "var(--content-edge-shadow, none)" }}>
      <header className="flex h-(--topbar-h) shrink-0 items-center gap-2 px-4">
        {crumb ? (
          <button onClick={() => setCrumb(null)} aria-label="Back" className="mr-1 inline-flex size-8 items-center justify-center rounded-control text-ink-3 hover:bg-wash-hover hover:text-ink"><ChevronRight className="size-4 rotate-180" /></button>
        ) : null}
        <h1 className="min-w-0 flex-1 truncate text-title font-title text-ink">{crumb ? crumb.name : inMemory ? "What Konan keeps" : "Library"}</h1>
        <button aria-label="Search Library" className="inline-flex size-8 items-center justify-center rounded-control text-ink-3 hover:bg-wash-hover hover:text-ink"><Search className="size-4" /></button>
        <div className="flex items-center rounded-control bg-surface-2 p-0.5">
          <button aria-label="Grid" onClick={() => setGrid(true)} className={cn("inline-flex size-7 items-center justify-center rounded-sm", grid ? "bg-surface-3 shadow-ring-xs text-ink" : "text-ink-3 hover:text-ink")}><LayoutGrid className="size-4" /></button>
          <button aria-label="List" onClick={() => setGrid(false)} className={cn("inline-flex size-7 items-center justify-center rounded-sm", !grid ? "bg-surface-3 shadow-ring-xs text-ink" : "text-ink-3 hover:text-ink")}><Rows3 className="size-4" /></button>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto scroll-fade-y">
        <div className="mx-auto w-full max-w-[920px] px-5 pb-10 pt-2 sm:px-8">
          {crumb ? (
            <p className="px-0.5 text-meta font-meta text-ink-4">{crumb.preview}</p>
          ) : inMemory ? (
            <p className="px-0.5 text-meta font-meta text-ink-4">Memory, as files. Ask Konan to forget anything.</p>
          ) : null}

          {grid ? <TileGrid tiles={tiles} onOpen={open} /> : <TileList tiles={tiles} onOpen={open} />}
        </div>
      </div>
    </section>
  );
}

/* ── Grid, Drive-style: folders as slim name rows, files as cards with
      a name header and the preview filling the body ───────────── */

function TileGrid({ tiles, onOpen }: { tiles: Tile[]; onOpen: (t: Tile) => void }) {
  const foldersOnly = tiles.filter((t) => t.kind !== "file");
  const files = tiles.filter((t) => t.kind === "file");
  return (
    <div className="mt-3">
      <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {foldersOnly.map((t) => (
          <li key={t.id}>
            <button onClick={() => onOpen(t)} className="group/row flex w-full items-center gap-2.5 rounded-card bg-surface-2 px-3 py-2.5 text-left shadow-ring-xs transition-[background-color,box-shadow] duration-(--dur-fast) hover:bg-wash-hover hover:shadow-ring-sm">
              <span className={cn("inline-flex size-7 shrink-0 items-center justify-center", t.kind === "memory" ? "text-working" : "text-ink-3")}>
                {t.kind === "memory" ? <Brain className="size-5" strokeWidth={1.7} /> : <Folder className="size-5" strokeWidth={1.7} />}
              </span>
              <span className="min-w-0 flex-1 truncate text-label text-ink">{t.name}</span>
              <span className="text-meta font-meta text-ink-4">{t.meta}</span>
            </button>
          </li>
        ))}
      </ul>

      <ul className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
        {files.map((t) => (
          <li key={t.id}>
            <button onClick={() => onOpen(t)} className="group/tile flex w-full flex-col overflow-hidden rounded-card bg-surface-2 p-3 text-left shadow-ring-sm ring-line transition-[background-color,box-shadow,transform] duration-(--dur-fast) hover:-translate-y-0.5 hover:bg-surface-3 hover:shadow-ring-md active:scale-[0.98]">
              <span className="flex items-center gap-2">
                <span className="shrink-0 text-ink-3">{kindIcon[t.file!.kind]}</span>
                <span className="min-w-0 flex-1 truncate text-label text-ink">{t.name}</span>
                <MoreHorizontal className="size-4 shrink-0 text-ink-4 opacity-0 transition-opacity group-hover/tile:opacity-100" />
              </span>
              <span className="relative mt-3 block aspect-[4/3] overflow-hidden rounded-control bg-surface-1 ring-line">
                <Preview kind={t.file!.kind} />
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ── List: icon, name, meta — Finder list view ─────────────── */

function TileList({ tiles, onOpen }: { tiles: Tile[]; onOpen: (t: Tile) => void }) {
  return (
    <ul className="mt-3">
      {tiles.map((t) => (
        <li key={t.id}>
          <button onClick={() => onOpen(t)} className="group/row flex w-full items-center gap-3 rounded-row px-2.5 py-2 text-left outline-none select-none transition-colors duration-(--dur-fast) hover:bg-wash-hover">
            <span className={cn("inline-flex size-8 shrink-0 items-center justify-center rounded-control", t.kind === "memory" ? "bg-working-soft text-working" : t.kind === "folder" ? "bg-accent-soft text-accent-ink" : "bg-surface-2 text-ink-3 shadow-ring-xs")}>
              {t.kind === "file" ? kindIcon[t.file!.kind] : t.kind === "memory" ? <Brain className="size-[18px]" strokeWidth={1.7} /> : <Folder className="size-[18px]" strokeWidth={1.7} />}
            </span>
            <span className="min-w-0 flex-1 truncate text-title text-ink">{t.name}</span>
            <span className="text-meta font-meta text-ink-4">{t.meta}</span>
            <MoreHorizontal className="size-4 shrink-0 text-ink-4 opacity-0 transition-opacity group-hover/row:opacity-100" />
          </button>
        </li>
      ))}
    </ul>
  );
}

/* ── File previews: a miniature of the actual content ──────── */

function Preview({ kind }: { kind: ItemKind }) {
  if (kind === "sheet") {
    return (
      <span aria-hidden className="absolute inset-4 flex overflow-hidden rounded-sm bg-surface-3 shadow-ring-xs">
        <span className="grid w-full grid-cols-[1.4fr_1fr_1fr] grid-rows-[repeat(6,1fr)]">
          <i className="border-b border-r border-line-1 bg-surface-2" />
          {Array.from({ length: 17 }).map((_, i) => <i key={i} className="border-b border-r border-line-1 last:border-r-0 odd:bg-surface-1" />)}
        </span>
      </span>
    );
  }
  if (kind === "receipt") {
    return (
      <span aria-hidden className="absolute inset-x-6 inset-y-3 flex flex-col gap-1.5 rounded-sm bg-surface-3 p-2.5 shadow-ring-xs" style={{ maskImage: "radial-gradient(4px at 50% 100%, transparent 97%, black) 50% 100% / 10px 6px repeat-x" }}>
        <span className="text-center font-meta text-[9px] font-medium text-ink-3">RECEIPT</span>
        {[0.9, 0.6, 0.75].map((w, i) => <i key={i} className="h-1 rounded-full bg-line-1" style={{ width: `${w * 100}%` }} />)}
        <i className="mt-auto h-1.5 w-1/2 self-end rounded-full bg-ink/20" />
      </span>
    );
  }
  if (kind === "list") {
    return (
      <span aria-hidden className="absolute inset-x-5 inset-y-3 flex flex-col justify-center gap-2.5">
        {[0.8, 0.65, 0.72, 0.5].map((w, i) => (
          <span key={i} className="flex items-center gap-1.5">
            <i className="size-2.5 shrink-0 rounded-full border border-accent/50 bg-accent-soft" />
            <i className="h-1.5 rounded-full bg-line-1" style={{ width: `${w * 100}%` }} />
          </span>
        ))}
      </span>
    );
  }
  if (kind === "booking") {
    return (
      <span aria-hidden className="absolute inset-x-6 inset-y-4 flex flex-col gap-1.5 rounded-sm bg-surface-3 p-2.5 shadow-ring-xs">
        <span className="flex items-center gap-1.5"><i className="size-1.5 rounded-full bg-success" /><i className="h-1.5 w-2/3 rounded-full bg-line-1" /></span>
        <span className="font-meta text-[10px] font-medium tabular-nums text-ink-2">Thu 3:30pm</span>
        <i className="h-1 w-3/4 rounded-full bg-line-1" />
        <i className="mt-auto h-px w-full bg-line-1" style={{ maskImage: "repeating-linear-gradient(90deg, black 4px, transparent 4px, transparent 8px)" }} />
      </span>
    );
  }
  if (kind === "image") {
    return <span aria-hidden className="absolute inset-4 rounded-sm bg-linear-to-br from-accent-soft via-surface-2 to-working-soft shadow-ring-xs" />;
  }
  if (kind === "memory") {
    return (
      <span aria-hidden className="absolute inset-0 flex items-center justify-center">
        <Brain className="size-10 text-working/40" strokeWidth={1.4} />
      </span>
    );
  }
  /* doc: a page with a title line and paragraphs */
  return (
    <span aria-hidden className="absolute inset-x-7 inset-y-3 flex flex-col gap-1.5 rounded-sm bg-surface-3 p-2.5 shadow-ring-xs">
      <i className="h-2 w-1/2 rounded-full bg-ink/15" />
      <i className="mt-1 h-1 w-full rounded-full bg-line-1" />
      <i className="h-1 w-11/12 rounded-full bg-line-1" />
      <i className="h-1 w-4/5 rounded-full bg-line-1" />
      <i className="mt-auto h-1 w-2/3 rounded-full bg-line-1" />
    </span>
  );
}
