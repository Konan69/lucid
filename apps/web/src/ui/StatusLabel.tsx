import { CircleDashed, CircleCheck, CircleAlert, CircleHelp, ShieldQuestion } from "lucide-react";
import { cn } from "./cn";

export type ConversationStatus = "ready" | "working" | "attention" | "approve" | "failed" | "done";

export const STATUS: Record<Exclude<ConversationStatus, "ready">, { text: string; dot: string; label: string; pulse?: boolean; Icon: typeof CircleDashed }> = {
  working: { text: "text-working", dot: "bg-working", label: "Working", pulse: true, Icon: CircleDashed },
  attention: { text: "text-attention", dot: "bg-attention", label: "Needs you", Icon: CircleHelp },
  approve: { text: "text-approve", dot: "bg-approve", label: "Approve", Icon: ShieldQuestion },
  failed: { text: "text-danger", dot: "bg-danger", label: "Failed", Icon: CircleAlert },
  done: { text: "text-success", dot: "bg-success", label: "Done", Icon: CircleCheck },
};

/** T3's rule: a status label is shown only when the row is not ready. */
export function StatusLabel({ status, className, children }: { status: ConversationStatus; className?: string; children?: React.ReactNode }) {
  if (status === "ready") return null;
  const s = STATUS[status];
  return (
    <span className={cn("inline-flex items-center gap-1 text-meta font-title tabular-nums", s.text, className)}>
      <s.Icon className={cn("size-3.5", s.pulse && "animate-status-pulse")} />
      {s.label}
      {children}
    </span>
  );
}

/** The mark a slim row leads with. */
export function StatusDot({ status, className }: { status: ConversationStatus; className?: string }) {
  if (status === "ready") return <i className={cn("size-1.5 rounded-full bg-line-4", className)} />;
  const s = STATUS[status];
  return <i className={cn("size-2 rounded-full", s.dot, s.pulse && "animate-status-pulse", className)} />;
}
