import { Check, ChevronRight, Plus, Repeat2, Search, ShieldCheck, Star, Store } from "lucide-react";
import { useState } from "react";
import { routines, templates, type RoutineTemplate } from "../data/routines";
import { cn } from "../ui/cn";

const brandText: Record<RoutineTemplate["brandColor"], string> = {
  accent: "text-accent-ink bg-accent-soft",
  working: "text-working bg-working-soft",
  approve: "text-approve bg-approve-soft",
  success: "text-success bg-success-soft",
};

/* Routines: what Konan repeats. Your routines first; below, the gallery —
   templates from Konan and from other teams, bought once and owned. */
export function Routines() {
  const [inGallery, setInGallery] = useState<string | null>(null);
  const open = templates.find((t) => t.id === inGallery);

  return (
    <section className="flex h-full min-w-0 flex-1 flex-col bg-surface-0" style={{ boxShadow: "var(--content-edge-shadow, none)" }}>
      <header className="flex h-(--topbar-h) shrink-0 items-center gap-2 px-4">
        {open ? (
          <button onClick={() => setInGallery(null)} aria-label="Back" className="mr-1 inline-flex size-8 items-center justify-center rounded-control text-ink-3 hover:bg-wash-hover hover:text-ink"><ChevronRight className="size-4 rotate-180" /></button>
        ) : null}
        <h1 className="min-w-0 flex-1 truncate text-title font-title text-ink">{open ? open.name : "Routines"}</h1>
        <button aria-label="Search routines" className="inline-flex size-8 items-center justify-center rounded-control text-ink-3 hover:bg-wash-hover hover:text-ink"><Search className="size-4" /></button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto scroll-fade-y">
        <div className="mx-auto w-full max-w-[920px] px-5 pb-10 pt-1 sm:px-8">
          {open ? <TemplateDetail template={open} /> : (
            <>
              <p className="px-0.5 text-meta font-meta text-ink-4">What Konan repeats, so you don't have to.</p>

              <Section title="Running" note={`${routines.length} routines · ${routines.reduce((n, r) => n + r.runs, 0)} runs all-time`}>
                <ul className="flex flex-col gap-px">
                  {routines.map((r) => (
                    <li key={r.id}>
                      <div className="group/row flex w-full items-center gap-2.5 rounded-row px-2.5 py-2.5 transition-colors duration-(--dur-fast) hover:bg-wash-hover">
                        <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-control bg-accent-soft text-accent-ink"><Repeat2 className="size-4" strokeWidth={1.7} /></span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-title text-ink">{r.name}</span>
                          <span className="block truncate text-meta font-meta text-ink-4">{r.trigger}</span>
                        </span>
                        <span className="hidden text-meta font-meta text-ink-4 sm:block">{r.runs} runs · {r.lastRun}</span>
                        <i className="size-1.5 shrink-0 rounded-full bg-success" aria-label="Running" />
                      </div>
                    </li>
                  ))}
                </ul>
                <button className="mt-1 flex w-full items-center gap-2.5 rounded-row px-2.5 py-2.5 text-left text-ink-3 transition-colors duration-(--dur-fast) hover:bg-wash-hover hover:text-ink">
                  <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-control bg-surface-2"><Plus className="size-4" /></span>
                  <span className="text-title">New routine</span>
                  <span className="ml-auto text-meta font-meta text-ink-4">or start from a template below</span>
                </button>
              </Section>

              <Section title="Template gallery" note="Buy once, run forever. Authors keep 70% of every sale.">
                <ul className="grid gap-2.5 sm:grid-cols-2">
                  {templates.map((t) => <TemplateCard key={t.id} template={t} onOpen={() => setInGallery(t.id)} />)}
                </ul>
                <div className="mt-4 flex items-center gap-2 rounded-card bg-surface-2 p-4 shadow-ring-xs">
                  <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-control bg-accent-soft text-accent-ink"><Store className="size-[18px]" strokeWidth={1.7} /></span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-label font-title text-ink">Sell your own</span>
                    <span className="block text-meta font-meta text-ink-4">Turn any routine you own into a template. You keep 70% of every sale.</span>
                  </span>
                  <ChevronRight className="size-4 shrink-0 text-ink-4" />
                </div>
              </Section>
            </>
          )}
        </div>
      </div>
    </section>
  );
}

function TemplateCard({ template: t, onOpen }: { template: RoutineTemplate; onOpen: () => void }) {
  return (
    <button onClick={onOpen} className="group/card flex h-full flex-col rounded-card bg-surface-2 p-4 text-left shadow-ring-xs transition-[background-color,box-shadow] duration-(--dur-fast) hover:bg-wash-hover hover:shadow-ring-sm">
      <span className="flex h-6 items-center gap-2">
        <span className={cn("inline-flex items-center rounded-full px-2 py-0.5 text-meta font-title", brandText[t.brandColor])}>{t.publisher}</span>
        <span className="flex-1" />
        <span className="text-meta font-title text-ink">{t.price}</span>
      </span>
      <span className="mt-2.5 block text-title text-ink">{t.name}</span>
      <span className="mt-0.5 line-clamp-2 text-label text-ink-3">{t.summary}</span>
      <span className="mt-auto flex items-center gap-2 pt-3 text-meta font-meta text-ink-4">
        <Star className="size-3.5 fill-current text-approve" />{t.rating}
        <span>·</span>{t.installs} using it
        <ChevronRight className="ml-auto size-3.5 transition-transform duration-(--dur-fast) group-hover/card:translate-x-0.5" />
      </span>
    </button>
  );
}

function TemplateDetail({ template: t }: { template: RoutineTemplate }) {
  return (
    <div className="pt-2">
      <div className="flex items-start gap-3">
        <span className={cn("inline-flex size-12 shrink-0 items-center justify-center rounded-control", brandText[t.brandColor])}><Repeat2 className="size-6" strokeWidth={1.7} /></span>
        <div className="min-w-0 flex-1">
          <h2 className="text-page font-title text-ink">{t.name}</h2>
          <p className="text-label text-ink-3">{t.summary}</p>
          <p className="mt-1 text-meta font-meta text-ink-4">by {t.publisher} · {t.installs} using it · ★ {t.rating}</p>
        </div>
        <div className="text-right">
          <p className="text-title font-title text-ink">{t.price}</p>
          <button className="mt-1.5 inline-flex h-8 items-center rounded-control bg-accent px-3 text-label font-title text-ink-on-accent shadow-control transition-colors duration-(--dur-fast) hover:bg-accent-hover">Use template</button>
        </div>
      </div>

      <div className="mt-6 border-t border-line-1 pt-4">
        <h3 className="text-label font-title text-ink-2">What it does</h3>
        <p className="mt-1 px-0.5 text-meta font-meta text-ink-4">{t.trigger}</p>
        <ol className="mt-2 flex flex-col gap-2">
          {t.actions.map((a, i) => (
            <li key={a} className="flex items-center gap-3 rounded-row bg-surface-2 px-3 py-2.5 shadow-ring-xs">
              <span className="inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-surface-3 text-meta font-meta text-ink-2">{i + 1}</span>
              <span className="min-w-0 flex-1 text-label text-ink">{a}</span>
              {i === t.actions.length - 1 && <Check className="size-4 shrink-0 text-success" />}
            </li>
          ))}
        </ol>
      </div>

      <div className="mt-5 flex items-start gap-3 rounded-card bg-surface-2 p-4 shadow-ring-xs">
        <ShieldCheck className="mt-0.5 size-4 shrink-0 text-success" />
        <p className="text-meta text-ink-3">Runs inside your Konan. The author never sees your data — templates ship the instructions, not the access. Authors keep {t.authorCut ?? "100% (Konan originals are free)"} of every sale.</p>
      </div>
    </div>
  );
}

function Section({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <div className="mt-7">
      <div className="mb-1 flex items-baseline gap-2.5 border-t border-line-1 px-0.5 pt-4">
        <h2 className="text-label font-title text-ink-2">{title}</h2>
        {note && <p className="truncate text-meta font-meta text-ink-4">{note}</p>}
      </div>
      {children}
    </div>
  );
}
