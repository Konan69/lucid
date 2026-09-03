import { X, Hand, Maximize2, Lock, Plus } from "lucide-react";
import { Button, IconButton } from "../ui/Button";
import { cn } from "../ui/cn";

export function Panel({ kind, onClose }: { kind: "screen" | "log"; onClose: () => void }) {
  return (
    <aside className="fixed inset-0 z-30 flex h-full w-full shrink-0 flex-col bg-surface-1 animate-fade-in sm:static sm:w-(--panel-w) sm:hairline-l">
      <header className="flex h-(--topbar-h) shrink-0 items-center gap-2 px-3 hairline-b">
        <h2 className="flex-1 text-label font-title text-ink">{kind === "screen" ? "Konan's screen" : "What Konan did"}</h2>
        {kind === "screen" && <IconButton label="Expand"><Maximize2 className="size-4" /></IconButton>}
        <IconButton label="Close" onClick={onClose}><X className="size-4" /></IconButton>
      </header>
      {kind === "screen" ? <ScreenView /> : <LogView />}
    </aside>
  );
}

const BROWSER_TABS = [
  { title: "Grand sheet — Kash Plus fee table", active: true },
  { title: "Kash Plus PRD v7 (PDF)", active: false },
  { title: "Worldstreet — sandbox access", active: false },
] as const;

const FEE_ROWS = [
  ["NG → GH", "Mobile money", "1.40%", "Worldstreet, §4.2", "drafted"],
  ["KE → TZ", "Bank transfer", "0.90%", "Worldstreet, §4.2", "drafted"],
  ["GH → NG", "Mobile money", "", "—", "filling"],
] as const;

function ScreenView() {
  return (
    <div className="flex flex-1 flex-col gap-3 p-3">
      {/* Konan's desktop: wallpaper, a floating browser window, and a dock */}
      <div
        className="relative flex aspect-[16/11] w-full flex-col overflow-hidden rounded-card ring-line"
        style={{ background: "radial-gradient(120% 90% at 20% 0%, #3a3f4b 0%, #23262e 55%, #17191f 100%)" }}
      >
        {/* Browser window, floating on the wallpaper */}
        <div className="absolute inset-x-3 top-3 bottom-10 flex flex-col overflow-hidden rounded-lg bg-well shadow-[0_12px_32px_rgba(0,0,0,0.45)] ring-1 ring-black/20">
        {/* Browser chrome: tab strip */}
        <div className="flex shrink-0 items-end gap-1 bg-surface-2 px-2 pt-1.5">
          <i className="mb-2 size-2 shrink-0 rounded-full bg-danger/70" />
          <i className="mb-2 size-2 shrink-0 rounded-full bg-attention/70" />
          <i className="mb-2 size-2 shrink-0 rounded-full bg-success/70" />
          {BROWSER_TABS.map((t) => (
            <div
              key={t.title}
              className={cn(
                "ml-1 flex min-w-0 max-w-40 flex-1 items-center gap-1.5 rounded-t-control px-2 py-1.5 text-meta",
                t.active ? "bg-well text-ink shadow-xs" : "text-ink-3",
              )}
            >
              <span className={cn("size-2 shrink-0 rounded-xs", t.active ? "bg-accent" : "bg-line-3")} />
              <span className="truncate">{t.title}</span>
            </div>
          ))}
          <span className="ml-1 mb-1.5 flex size-4 shrink-0 items-center justify-center rounded-xs text-ink-4 hover:bg-wash-hover"><Plus className="size-3" /></span>
        </div>
        {/* URL bar */}
        <div className="shrink-0 bg-well px-2 py-1.5">
          <div className="flex items-center gap-1.5 rounded-full bg-surface-3 px-2.5 py-1 shadow-xs">
            <Lock className="size-2.5 shrink-0 text-success" />
            <span className="truncate text-meta text-ink-2">northgate.procure.example.com/contracts/MSA-2025-114/review</span>
          </div>
        </div>
        {/* Page: the grand sheet — Kash Plus cross-border fee table, mid-fill */}
        <div className="relative flex-1 overflow-hidden bg-well px-4 pb-2">
          <div className="flex items-center justify-between pt-1">
            <div>
              <div className="text-label font-title text-ink">Kash Plus — cross-border fee table</div>
              <div className="text-meta text-ink-4">Grand sheet · Tab 3 of 5 · Source: PRD appendix B</div>
            </div>
            <span className="rounded-full bg-working-soft px-2 py-0.5 text-meta text-working">Filling</span>
          </div>
          <div className="mt-2 overflow-hidden rounded-card bg-surface-3 shadow-ring-xs">
            <table className="w-full text-meta">
              <thead>
                <tr className="text-left text-ink-4">
                  <th className="py-1 pl-2 font-normal">Corridor</th><th className="font-normal">Rail</th><th className="font-normal">Fee</th><th className="font-normal">Source</th><th className="pr-2 text-right font-normal">State</th>
                </tr>
              </thead>
              <tbody className="text-ink-2">
                {FEE_ROWS.map(([corridor, rail, fee, source, state]) => (
                  <tr key={corridor} className={cn("hairline-t", state === "filling" && "bg-accent-soft/60")}>
                    <td className="py-1 pl-2 text-ink">{corridor}</td>
                    <td>{rail}</td>
                    <td className="tabular-nums">{fee || <span className="inline-block h-2.5 w-10 animate-status-pulse rounded-full bg-accent/50" />}</td>
                    <td className="text-ink-4">{source}</td>
                    <td className="pr-2 text-right">
                      {state === "drafted" ? <span className="text-success">✓ drafted</span> : <span className="text-accent-ink">typing…</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-2 flex items-center gap-2 rounded-control bg-surface-3 px-2 py-1.5 shadow-ring-xs ring-line" aria-current="step">
            <i className="size-1.5 shrink-0 animate-status-pulse rounded-full bg-working" />
            <span className="text-meta text-ink-3">Filling the GH → NG row from PRD appendix B</span>
          </div>
        </div>
        <span className="absolute bottom-2 right-2 inline-flex items-center gap-1.5 rounded-full bg-surface-1/80 px-2 py-0.5 text-meta text-working">
          <i className="size-1.5 rounded-full bg-current animate-status-pulse" />Live
        </span>
        </div>
        {/* Dock: the tools Konan keeps on its desktop */}
        <div className="absolute inset-x-0 bottom-0 flex h-10 items-center justify-center gap-2.5">
          {["#EA4335", "#3B82F6", "#1FA463", "#F59E0B"].map((c, i) => (
            <i key={i} className="size-5 rounded-md shadow-[0_2px_6px_rgba(0,0,0,0.4)]" style={{ background: `linear-gradient(135deg, ${c}, ${c}CC)` }} aria-hidden />
          ))}
        </div>
      </div>
      <p className="text-label text-ink-3">Konan is filling the cross-border fee table — blocker 3 from the PRD review. You can take over at any point; it pauses until you hand back.</p>
      <div className="flex gap-2">
        <Button icon={<Hand className="size-3.5" />}>Take over</Button>
        <Button variant="ghost">Teach a task</Button>
      </div>
    </div>
  );
}

const LOG = [
  { t: "10:04", what: "Opened the grand sheet, tab: fee table", ask: null },
  { t: "10:04", what: "Read PRD appendix B for published rates", ask: "Drive · allowed this time" },
  { t: "10:05", what: "Drafted the NG → GH and KE → TZ rows", ask: null },
  { t: "10:05", what: "Flagged the GH → NG rate as missing — no source in the PRD", ask: null },
];

function LogView() {
  return (
    <ol className="flex flex-col p-3">
      {LOG.map((e, i) => (
        <li key={i} className={cn("flex gap-3 py-2.5", i < LOG.length - 1 && "hairline-b")}>
          <span className="w-10 shrink-0 text-meta text-ink-4">{e.t}</span>
          <span className="min-w-0 flex-1">
            <span className="block text-label text-ink">{e.what}</span>
            {e.ask && <span className="block text-meta text-ink-3">{e.ask}</span>}
          </span>
        </li>
      ))}
    </ol>
  );
}
