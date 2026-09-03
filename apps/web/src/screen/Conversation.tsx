import { ChevronDown, ChevronRight, Mic, Paperclip, ArrowUp, Square, UserPlus, PanelRight, ScrollText, Repeat2, Check, Mail, CalendarDays, HardDrive, Globe } from "lucide-react";
import { useState } from "react";
import { activeConversation, queuedFor, threadsByConversation, type Msg } from "../data/fixtures";
import { Button, IconButton } from "../ui/Button";
import { Card } from "../ui/Card";
import { cn } from "../ui/cn";
import { Face } from "../ui/Face";

export function Conversation({
  onOpenPanel,
  panelOpen,
  working,
  conversationId = "t1",
}: {
  onOpenPanel: (kind: "screen" | "log") => void;
  panelOpen: boolean;
  working: boolean;
  conversationId?: string;
}) {
  const messages: Msg[] = threadsByConversation[conversationId] ?? threadsByConversation.t1 ?? [];
  return (
    <section className="flex h-full min-w-0 flex-1 flex-col bg-surface-0" style={{ boxShadow: "var(--content-edge-shadow, none)" }}>
      <header className="flex h-(--topbar-h) shrink-0 items-center gap-2 px-4">
        <h1 className="min-w-0 flex-1 truncate text-title font-title text-ink">{activeConversation.title}</h1>
        <Button className="hidden sm:inline-flex" variant="ghost" size="sm" icon={<UserPlus className="size-3.5" />}>Add someone</Button>
        <IconButton label="What Konan did" onClick={() => onOpenPanel("log")}>
          <ScrollText className="size-4" />
        </IconButton>
        <IconButton label="Konan's screen" active={panelOpen} onClick={() => onOpenPanel("screen")}>
          <PanelRight className="size-4" />
        </IconButton>
      </header>

      <div className="flex-1 overflow-y-auto">
        <ol className="mx-auto flex w-full max-w-(--thread-max-w) flex-col gap-5 px-4 py-5 sm:px-6 sm:py-6">
          <li className="flex items-center gap-3" aria-hidden>
            <span className="h-px flex-1 bg-line-1" />
            <span className="text-meta font-meta text-ink-4">Today</span>
            <span className="h-px flex-1 bg-line-1" />
          </li>
          {messages.map((m) => (
            <li key={m.id} className="animate-rise-in">
              <Message msg={m} />
            </li>
          ))}
        </ol>
      </div>

      <Composer working={working} queued={queuedFor(conversationId)} />
    </section>
  );
}

function Message({ msg }: { msg: Msg }) {
  switch (msg.kind) {
    case "user":
      return (
        <div className="flex justify-end">
          <div className="max-w-[78%] rounded-panel rounded-br-sm bg-surface-2 px-4 py-3 text-body text-ink">
            <p>{msg.text}</p>
            <span className="mt-1 block text-right text-meta text-ink-4">{msg.time}</span>
          </div>
        </div>
      );
    case "konan":
      return (
        <div className="flex gap-3">
          <Face size={24} className="mt-1" />
          <div className="min-w-0 flex-1 text-body text-ink">
            <p>{msg.text}</p>
            {msg.bullets && (
              <ul className="mt-3 flex flex-col gap-2">
                {msg.bullets.map((item) => (
                  <li key={item.lead} className="flex gap-2 text-label text-ink-2">
                    <span className="mt-[7px] size-1 shrink-0 rounded-full bg-ink-4" />
                    <span><strong className="font-title text-ink">{item.lead}</strong> · {item.rest}</span>
                  </li>
                ))}
              </ul>
            )}
            {msg.chip && (
              <span className={cn(
                "mt-3 inline-flex h-6 items-center rounded-full px-2.5 text-meta font-title",
                msg.chip.tone === "success" && "bg-success-soft text-success",
                msg.chip.tone === "accent" && "bg-accent-soft text-accent-ink",
                msg.chip.tone === "neutral" && "bg-surface-2 text-ink-2",
              )}>{msg.chip.label}</span>
            )}
            <span className="mt-1 block text-meta text-ink-4">{msg.time}</span>
          </div>
        </div>
      );
    case "worked":
      return <WorkingBlock summary={msg.summary} steps={msg.steps} duration={msg.duration} delta={msg.delta} initiallyOpen={msg.open} />;
    case "automation":
      return <AutomationMade title={msg.title} trigger={msg.trigger} actions={msg.actions} time={msg.time} />;
    case "connect":
      return <ConnectServices services={msg.services} />;
    case "card":
      return <InputCard title={msg.title} question={msg.question} options={msg.options} />;
  }
}

function AutomationMade({ title, trigger, actions, time }: { title: string; trigger: string; actions: string[]; time: string }) {
  return (
    <div className="flex gap-3">
      <Face size={24} mood="happy" className="mt-1" />
      <Card className="min-w-0 flex-1 p-4">
        <div className="flex items-center gap-2 text-meta text-ink-3">
          <Repeat2 className="size-3.5 text-accent-ink" />
          Konan set up a routine
        </div>
        <h3 className="mt-2 text-dialog font-title text-ink">{title}</h3>
        <p className="mt-0.5 text-meta font-meta text-ink-4">{trigger}</p>
        <ol className="mt-2.5 flex flex-col gap-1.5 border-l border-line-2 pl-4 text-label text-ink-2">
          {actions.map((a) => <li key={a}>{a}</li>)}
        </ol>
        <span className="mt-1 block text-meta text-ink-4">{time}</span>
      </Card>
    </div>
  );
}

/* Connect cards in the chat: Konan asks for access mid-conversation and
      you authorize each service in place, Grok-Bot style. */
const SERVICE_ICON: Record<string, { Icon: React.ComponentType<React.SVGProps<SVGSVGElement>>; tone: string }> = {
  gmail: { Icon: Mail, tone: "text-[#EA4335]" },
  calendar: { Icon: CalendarDays, tone: "text-[#3B82F6]" },
  drive: { Icon: HardDrive, tone: "text-[#1FA463]" },
  browser: { Icon: Globe, tone: "text-ink-2" },
  maps: { Icon: Globe, tone: "text-[#34A853]" },
};

function ConnectServices({ services }: { services: Array<{ id: string; name: string; detail: string }> }) {
  const [done, setDone] = useState<Record<string, boolean>>({});
  return (
    <div className="flex flex-col gap-2">
      {services.map((s) => {
        const { Icon, tone } = SERVICE_ICON[s.id] ?? SERVICE_ICON.browser!;
        const ok = done[s.id];
        return (
          <div key={s.id} className="flex items-center gap-3 rounded-panel bg-surface-2 p-3 shadow-ring-xs">
            <span className="inline-flex size-10 shrink-0 items-center justify-center rounded-control bg-surface-0 shadow-ring-xs">
              <Icon className={cn("size-5", tone)} strokeWidth={1.8} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-label font-title text-ink">{s.name}</span>
              <span className="block truncate text-label text-ink-3">{s.detail}</span>
            </span>
            {ok ? (
              <span className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full bg-success-soft px-3 text-label text-success"><Check className="size-3.5" />Connected</span>
            ) : (
              <button onClick={() => setDone((d) => ({ ...d, [s.id]: true }))} className="inline-flex h-8 shrink-0 items-center rounded-full bg-surface-3 px-4 text-label text-ink shadow-ring-xs ring-line transition-colors duration-(--dur-fast) hover:bg-wash-hover active:scale-[0.97]">Authorize</button>
            )}
          </div>
        );
      })}
    </div>
  );
}

function WorkingBlock({ summary, steps, duration, delta, initiallyOpen }: { summary: string; steps: string[]; duration: string; delta?: string; initiallyOpen?: boolean }) {
  const [open, setOpen] = useState(!!initiallyOpen);
  return (
    <div className="flex gap-3">
      <span className="mt-1 flex size-6 items-center justify-center">
        <i className="size-2 rounded-full bg-working animate-status-pulse" />
      </span>
      <div className="min-w-0 flex-1">
        <button onClick={() => setOpen((v) => !v)} className="flex w-full items-center gap-2 rounded-row py-1 text-left hover:bg-wash-hover">
          {open ? <ChevronDown className="size-3.5 text-ink-3" /> : <ChevronRight className="size-3.5 text-ink-3" />}
          <span className="text-label font-title text-ink-2">{summary}</span>
          <span className="text-meta font-meta text-ink-4">{duration}</span>
          {delta && <span className="text-meta font-meta text-success">{delta}</span>}
        </button>
        {open && (
          <ol className="ml-1.5 mt-1 flex flex-col gap-1.5 border-l border-line-2 pl-4 text-label text-ink-2">
            {steps.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}

function InputCard({ title, question, options }: { title: string; question: string; options: Array<{ label: string; note: string }> }) {
  const [picked, setPicked] = useState<number | null>(null);
  return (
    <div className="flex gap-3">
      <Face size={24} mood="thinking" className="mt-1" />
      <Card className="min-w-0 flex-1 p-4">
        <div className="flex items-center gap-2 text-meta text-ink-3">
          <i className="size-1.5 rounded-full bg-attention" />
          Konan needs you
          <span className="text-ink-4">·</span>
          {title}
        </div>
        <h3 className="mt-2 text-dialog font-title text-ink">{question}</h3>
        <ul className="mt-3 flex flex-col gap-1.5">
          {options.map((o, i) => (
            <li key={o.label}>
              <button
                onClick={() => setPicked(i)}
                className={cn(
                  "flex w-full items-start gap-3 rounded-control px-3 py-2.5 text-left transition-colors duration-(--dur-fast) ring-line",
                  picked === i ? "bg-accent-soft ring-accent" : "bg-surface-3 hover:bg-wash-hover",
                )}
              >
                <span className="mt-0.5 w-4 text-meta text-ink-4">{String.fromCharCode(65 + i)}</span>
                <span className="min-w-0 flex-1">
                  <span className="block text-title font-title text-ink">{o.label}</span>
                  <span className="block text-label text-ink-3">{o.note}</span>
                </span>
                <i className={cn("mt-1 size-4 rounded-full ring-1 ring-line-4", picked === i && "bg-accent ring-accent")} />
              </button>
            </li>
          ))}
        </ul>
        <input
          placeholder="Or type your own answer"
          className="mt-2 h-9 w-full rounded-control bg-surface-3 px-3 text-label text-ink placeholder:text-ink-4 ring-line"
        />
        <div className="mt-3 flex justify-end">
          <Button variant="primary" disabled={picked === null}>Answer</Button>
        </div>
      </Card>
    </div>
  );
}

function Composer({ working, queued }: { working: boolean; queued: string }) {
  return (
    <div className="shrink-0 px-3 pb-3 pt-2 sm:px-6 sm:pb-5">
      <div className="mx-auto w-full max-w-(--thread-max-w)">
        {working && (
          <div className="mx-4 flex items-center gap-2 rounded-t-control bg-surface-2 px-3 py-2 text-meta text-ink-3 ring-line">
            <span className="size-1.5 shrink-0 rounded-full bg-working" />
            <span className="truncate"><span className="font-title text-ink-2">Next:</span> {queued}</span>
          </div>
        )}
        <div className="relative rounded-composer bg-surface-3 shadow-composer ring-line">
        <textarea
          rows={1}
          placeholder={working ? "Queue for when Konan finishes" : "Message Konan"}
          className="block w-full resize-none bg-transparent px-5 pt-4 pb-2 text-body text-ink placeholder:text-ink-4 outline-none"
        />
        <div className="flex items-center gap-1 px-3 pb-3">
          <IconButton label="Attach"><Paperclip className="size-4" /></IconButton>
          <span className="flex-1" />
          <IconButton label="Talk"><Mic className="size-4" /></IconButton>
          <button
            aria-label={working ? "Stop" : "Send"}
            className={cn(
              "inline-flex size-8 items-center justify-center rounded-full text-ink-on-accent shadow-control transition-colors duration-(--dur-fast)",
              working ? "bg-danger" : "bg-accent hover:bg-accent-hover",
              "transition-[transform,background-color] duration-(--dur-fast) active:scale-[0.96]",
            )}
          >
            {working ? <Square className="size-3.5 fill-current" /> : <ArrowUp className="size-4" />}
          </button>
        </div>
        </div>
      </div>
    </div>
  );
}
