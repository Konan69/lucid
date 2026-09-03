import { ChevronDown, ChevronRight, Mic, Paperclip, ArrowUp, Square, UserPlus, PanelRight, ScrollText, Repeat2, Check, Mail, CalendarDays, HardDrive, Globe } from "lucide-react";
import { useFlueAgent, type FlueConversationMessage } from "@flue/react";
import { createFlueClient } from "@flue/sdk";
import { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { conversations, threadsByConversation, type Msg } from "../data/fixtures";
import { Button, IconButton } from "../ui/Button";
import { Card } from "../ui/Card";
import { cn } from "../ui/cn";
import { Face } from "../ui/Face";

export function Conversation({
  onOpenPanel,
  panelOpen,
  conversationId = "t1",
  title,
  onMessageSent,
}: {
  onOpenPanel: (kind: "screen" | "log") => void;
  panelOpen: boolean;
  conversationId?: string;
  title: string;
  onMessageSent: (message: string) => void;
}) {
  const client = useMemo(
    () => createFlueClient({ url: `/api/konan/${encodeURIComponent(conversationId)}` }),
    [conversationId],
  );
  const agent = useFlueAgent({ client });
  const endRef = useRef<HTMLLIElement>(null);
  const working = agent.status === "submitted" || agent.status === "streaming";
  const hasStreamingAssistant = agent.messages.some((message) =>
    message.role === "assistant" && message.parts.some((part) => "state" in part && part.state === "streaming"),
  );

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: working ? "smooth" : "auto" });
  }, [agent.messages, working]);

  return (
    <section className="flex h-full min-w-0 flex-1 flex-col bg-surface-0" style={{ boxShadow: "var(--content-edge-shadow, none)" }}>
      <header className="flex h-(--topbar-h) shrink-0 items-center gap-2 px-4">
        <h1 className="min-w-0 flex-1 truncate text-title font-title text-ink">{title}</h1>
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
          {!agent.historyReady && agent.messages.length === 0 && (
            <li className="py-12 text-center text-label text-ink-4">Loading conversation…</li>
          )}
          {agent.historyReady && agent.messages.length === 0 && (
            <li className="py-12 text-center">
              <Face size={36} mood="happy" className="mx-auto" />
              <p className="mt-3 text-title font-title text-ink">Konan is ready</p>
              <p className="mt-1 text-label text-ink-3">What should I take off your plate?</p>
            </li>
          )}
          {agent.messages.filter((message) => message.display !== "hidden").map((message) => (
            <li key={message.id} className="animate-rise-in">
              <LiveMessage message={message} />
            </li>
          ))}
          {working && !hasStreamingAssistant && (
            <li className="flex gap-3 animate-rise-in" aria-live="polite">
              <Face size={24} mood="thinking" className="mt-1" />
              <p className="pt-1 text-body text-ink-4">Thinking…</p>
            </li>
          )}
          {agent.error && (
            <li className="rounded-panel bg-danger-soft px-4 py-3 text-label text-danger ring-line">
              <div className="flex items-center gap-3">
                <span className="min-w-0 flex-1">{agent.error.message}</span>
                <button className="font-title underline" onClick={agent.refresh}>Retry connection</button>
              </div>
            </li>
          )}
          <li ref={endRef} aria-hidden />
        </ol>
      </div>

      <Composer
        working={working}
        onSend={async (message) => {
          await agent.sendMessage(message);
          onMessageSent(message);
        }}
        onStop={() => client.abort().then(() => undefined)}
      />
    </section>
  );
}

export function DemoConversation({ conversationId }: { conversationId: string }) {
  const conversation = conversations.find((item) => item.id === conversationId);
  const messages = threadsByConversation[conversationId] ?? [];

  return (
    <section className="flex h-full min-w-0 flex-1 flex-col bg-surface-0">
      <header className="flex h-(--topbar-h) shrink-0 items-center gap-2 px-4">
        <h1 className="min-w-0 flex-1 truncate text-title font-title text-ink">{conversation?.title ?? "Demo conversation"}</h1>
        <span className="rounded-full bg-surface-2 px-2.5 py-1 text-meta font-title text-ink-3 ring-line">Read-only demo</span>
      </header>
      <div className="flex-1 overflow-y-auto">
        <ol className="mx-auto flex w-full max-w-(--thread-max-w) flex-col gap-5 px-4 py-6 sm:px-6">
          {messages.map((message) => (
            <li key={message.id}><FixtureMessage msg={message} /></li>
          ))}
        </ol>
      </div>
    </section>
  );
}

function LiveMessage({ message }: { message: FlueConversationMessage }) {
  const text = message.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n\n");
  const tools = message.parts.filter((part) => part.type === "dynamic-tool");
  const timestamp = typeof message.metadata?.finishedAt === "number"
    ? message.metadata.finishedAt
    : typeof message.metadata?.startedAt === "number"
      ? message.metadata.startedAt
      : undefined;
  const time = timestamp
    ? new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(timestamp)
    : "";

  if (message.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[78%] rounded-panel rounded-br-sm bg-surface-2 px-4 py-3 text-body text-ink">
          <p className="whitespace-pre-wrap">{text}</p>
          {time && <span className="mt-1 block text-right text-meta text-ink-4">{time}</span>}
        </div>
      </div>
    );
  }

  if (message.role === "system") {
    return (
      <div className="rounded-panel bg-surface-2 px-4 py-3 text-label text-ink-3 ring-line">
        {message.settlement?.outcome === "failed" ? "Konan could not complete that response. " : ""}
        {text}
      </div>
    );
  }

  return (
    <div className="flex gap-3">
      <Face size={24} className="mt-1" />
      <div className="min-w-0 flex-1 text-body text-ink">
        {text ? <Markdown content={text} /> : <p className="text-ink-4">Thinking…</p>}
        {tools.map((tool) => (
          <div key={tool.toolCallId} className="mt-2 rounded-control bg-surface-2 px-3 py-2 text-label text-ink-3 ring-line">
            <span className="font-title text-ink-2">{tool.toolName}</span>
            <span className="ml-2">{tool.state === "input-available" ? "Running" : tool.state === "output-error" ? "Failed" : "Complete"}</span>
          </div>
        ))}
        {time && <span className="mt-1 block text-meta text-ink-4">{time}</span>}
      </div>
    </div>
  );
}

function Markdown({ content }: { content: string }) {
  return (
    <div className="min-w-0 text-body text-ink">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ children, ...props }) => <a {...props} target="_blank" rel="noreferrer" className="text-accent-ink underline underline-offset-2">{children}</a>,
          blockquote: ({ children }) => <blockquote className="my-3 border-l-2 border-line-3 pl-3 text-ink-3">{children}</blockquote>,
          code: ({ children, className, ...props }) => <code {...props} className={cn("rounded-xs bg-surface-2 px-1 py-0.5 font-mono text-[0.9em]", className)}>{children}</code>,
          h1: ({ children }) => <h1 className="mb-2 mt-4 text-page font-title first:mt-0">{children}</h1>,
          h2: ({ children }) => <h2 className="mb-2 mt-4 text-dialog font-title first:mt-0">{children}</h2>,
          h3: ({ children }) => <h3 className="mb-1.5 mt-3 text-title font-title first:mt-0">{children}</h3>,
          hr: () => <hr className="my-4 border-line-2" />,
          li: ({ children }) => <li className="ml-5 pl-1 marker:text-ink-4">{children}</li>,
          ol: ({ children }) => <ol className="my-2 list-decimal space-y-1">{children}</ol>,
          p: ({ children }) => <p className="my-2 whitespace-pre-wrap first:mt-0 last:mb-0">{children}</p>,
          pre: ({ children }) => <pre className="my-3 overflow-x-auto rounded-control bg-surface-2 p-3 text-label ring-line [&_code]:bg-transparent [&_code]:p-0">{children}</pre>,
          table: ({ children }) => <div className="my-3 overflow-x-auto rounded-control ring-line"><table className="w-full border-collapse text-label">{children}</table></div>,
          td: ({ children }) => <td className="border-t border-line-2 px-3 py-2 align-top">{children}</td>,
          th: ({ children }) => <th className="bg-surface-2 px-3 py-2 text-left font-title">{children}</th>,
          ul: ({ children }) => <ul className="my-2 list-disc space-y-1">{children}</ul>,
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

export function FixtureMessage({ msg }: { msg: Msg }) {
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

function Composer({
  working,
  onSend,
  onStop,
}: {
  working: boolean;
  onSend: (message: string) => Promise<void>;
  onStop: () => Promise<void>;
}) {
  const [message, setMessage] = useState("");

  async function submit() {
    const body = message.trim();
    if (!body) return;
    setMessage("");

    try {
      await onSend(body);
    } catch {
      // The Flue hook retains failed optimistic sends and exposes the error.
    }
  }

  return (
    <div className="shrink-0 px-3 pb-3 pt-2 sm:px-6 sm:pb-5">
      <div className="mx-auto w-full max-w-(--thread-max-w)">
        <div className="relative rounded-composer bg-surface-3 shadow-composer ring-line">
        <textarea
          rows={1}
          placeholder="Message Konan"
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void submit();
            }
          }}
          className="block w-full resize-none bg-transparent px-5 pt-4 pb-2 text-body text-ink placeholder:text-ink-4 outline-none"
        />
        <div className="flex items-center gap-1 px-3 pb-3">
          <IconButton label="Attach"><Paperclip className="size-4" /></IconButton>
          <span className="flex-1" />
          <IconButton label="Talk"><Mic className="size-4" /></IconButton>
          <button
            aria-label={working ? "Stop" : "Send"}
            disabled={!working && !message.trim()}
            onClick={() => void (working ? onStop() : submit())}
            className={cn(
              "inline-flex size-8 items-center justify-center rounded-full text-ink-on-accent shadow-control transition-colors duration-(--dur-fast)",
              working ? "bg-danger" : "bg-accent hover:bg-accent-hover",
              !working && !message.trim() && "cursor-not-allowed opacity-40",
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
