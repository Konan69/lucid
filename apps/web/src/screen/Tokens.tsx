import type { ReactNode } from "react";
import { Face, type FaceColor } from "../ui/Face";
import { Button } from "../ui/Button";
import { StatusLabel, type ConversationStatus } from "../ui/StatusLabel";

const SURFACES = [["surface-0","bg-surface-0"],["surface-1","bg-surface-1"],["surface-2","bg-surface-2"],["surface-3","bg-surface-3"],["well","bg-well"]] as const;
const INKS = [["ink","text-ink"],["ink-2","text-ink-2"],["ink-3","text-ink-3"],["ink-4","text-ink-4"]] as const;
const LINES = [["line-1","ring-line-1"],["line-2","ring-line-2"],["line-3","ring-line-3"],["line-4","ring-line-4"]] as const;
const STATUS: ConversationStatus[] = ["working", "attention", "approve", "done", "failed"];
const FACES: FaceColor[] = ["accent", "brown", "red", "orange", "yellow", "green", "cyan", "blue", "violet", "magenta", "gray"];
const TYPE = [["meta","text-meta"],["label","text-label"],["title","text-title"],["body","text-body"],["dialog","text-dialog"],["section","text-section"],["page","text-page"],["hero","text-hero"]] as const;
const RADII = [["xs","rounded-xs"],["sm","rounded-sm"],["row","rounded-row"],["control","rounded-control"],["card","rounded-card"],["panel","rounded-panel"],["composer","rounded-composer"]] as const;

/** The token sheet. Everything the product is allowed to use, on one page. */
export function Tokens() {
  return (
    <div className="h-full overflow-y-auto bg-surface-0 p-8">
      <div className="mx-auto max-w-4xl space-y-10">
        <header>
          <h1 className="text-page font-title text-ink">Vivid tokens</h1>
          <p className="mt-1 text-label text-ink-3">One language. Surfaces step one way, ink and lines are alpha, accent is Vivid&apos;s alone.</p>
        </header>

        <Section title="Surfaces">
          <div className="flex gap-2">
            {SURFACES.map(([n, c]) => (
              <Swatch key={n} name={n} className={c} />
            ))}
          </div>
        </Section>

        <Section title="Ink">
          <div className="flex gap-6">
            {INKS.map(([n, c]) => (
              <span key={n} className={`text-body ${c}`}>{n}</span>
            ))}
          </div>
        </Section>

        <Section title="Hairlines and washes">
          <div className="flex gap-2">
            {LINES.map(([n, c]) => (
              <div key={n} className={`flex h-16 w-24 items-end rounded-card bg-surface-2 p-2 ring-1 ${c}`}><span className="text-meta text-ink-3">{n}</span></div>
            ))}
            <div className="flex h-16 w-24 items-end rounded-card bg-wash-hover p-2"><span className="text-meta text-ink-3">hover</span></div>
            <div className="flex h-16 w-24 items-end rounded-card bg-wash-selected p-2"><span className="text-meta text-ink-3">selected</span></div>
            <div className="flex h-16 w-24 items-end rounded-card bg-wash-pressed p-2"><span className="text-meta text-ink-3">pressed</span></div>
          </div>
        </Section>

        <Section title="Accent and status">
          <div className="flex flex-wrap items-center gap-4">
            <Swatch name="accent" className="bg-accent" />
            <Swatch name="accent-soft" className="bg-accent-soft" />
            {STATUS.map((s) => (
              <StatusLabel key={s} status={s} />
            ))}
          </div>
        </Section>

        <Section title="Faces">
          <div className="flex gap-3">
            {FACES.map((c) => (
              <Face key={c} color={c} size={32} label={c} />
            ))}
            <Face color="accent" mood="thinking" size={32} />
            <Face color="accent" mood="happy" size={32} />
            <Face color="accent" mood="asleep" size={32} />
          </div>
        </Section>

        <Section title="Type">
          <div className="flex flex-col gap-2">
            {TYPE.map(([n, c]) => (
              <p key={n} className={`${c} text-ink`}>
                {n} <span className="text-ink-4">·</span> <span className="text-ink-2">The quick brown fox jumps over the lazy dog</span>
              </p>
            ))}
            <p className="font-mono text-label text-ink-2">mono · pnpm dev --port 5178</p>
          </div>
        </Section>

        <Section title="Radius">
          <div className="flex items-end gap-2">
            {RADII.map(([n, c]) => (
              <div key={n} className={`flex size-16 items-end justify-center ${c} bg-surface-3 pb-1 ring-line`}><span className="text-meta text-ink-3">{n}</span></div>
            ))}
          </div>
        </Section>

        <Section title="Controls">
          <div className="flex items-center gap-2">
            <Button variant="primary">Answer</Button>
            <Button>Take over</Button>
            <Button variant="ghost">Teach a task</Button>
            <Button variant="quiet">Archived</Button>
            <Button size="sm">Add someone</Button>
          </div>
        </Section>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h2 className="mb-3 text-meta font-title tracking-[0.06em] text-ink-4 uppercase">{title}</h2>
      {children}
    </section>
  );
}

function Swatch({ name, className }: { name: string; className: string }) {
  return (
    <div className={`flex h-16 w-24 items-end rounded-card p-2 ring-line ${className}`}>
      <span className="text-meta text-ink-3">{name}</span>
    </div>
  );
}
