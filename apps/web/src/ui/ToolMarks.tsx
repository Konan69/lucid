import { cn } from "./cn";

/* Tool marks: the services Vivid is using in a conversation, drawn as
   high-fidelity brand marks so a row reads at a glance. All geometry is
   inline SVG in the brands' own colors; the tile carries the shadow. */

function GmailMark() {
  return (
    <svg viewBox="0 0 24 24" className="size-full" aria-hidden>
      <rect width="24" height="24" rx="5" fill="#fff" />
      <path fill="#EA4335" d="M3 6.5 12 13l9-6.5V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6.5Z" />
      <path fill="#C5221F" d="M3 5.6c0-1.4 1.6-2.2 2.7-1.4L12 8.9l6.3-4.7c1.1-.8 2.7 0 2.7 1.4v.9L12 13 3 6.5v-.9Z" />
    </svg>
  );
}

function CalendarMark() {
  return (
    <svg viewBox="0 0 24 24" className="size-full" aria-hidden>
      <rect width="24" height="24" rx="5" fill="#1A73E8" />
      <rect x="4.5" y="4.5" width="15" height="15" rx="2" fill="#fff" />
      <text x="12" y="15.6" textAnchor="middle" fontFamily="system-ui, sans-serif" fontSize="8.4" fontWeight="700" fill="#1A73E8">31</text>
    </svg>
  );
}

function DriveMark() {
  return (
    <svg viewBox="0 0 24 24" className="size-full" aria-hidden>
      <rect width="24" height="24" rx="5" fill="#fff" />
      <path fill="#0066DA" d="M8.6 4.5h6.8l6 10.4h-6.8z" transform="translate(-3 0)" />
      <path fill="#00AC47" d="M12 4.5 5.5 15.8l3.4 5.9L15.4 10.4z" transform="translate(0 -1) scale(0.92)" />
      <path fill="#FFBA00" d="m9 21.5 3.4-5.9h9.2l-3.4 5.9z" />
      <path fill="#00832D" d="M5.5 15.8 8.9 21.5l3.4-5.9z" />
      <path fill="#2684FC" d="M8.9 3.5 5.5 9.4l3.4 5.9 3.4-5.9z" />
      <path fill="#00AC47" d="M15.7 3.5H8.9l3.4 5.9z" />
      <path fill="#FFBA00" d="M21.9 15.3h-6.8l-3.4 5.9h6.8z" />
      <path fill="#0066DA" d="m15.7 3.5-3.4 5.9 3.4 5.9 3.4-5.9z" />
    </svg>
  );
}

function MapsMark() {
  return (
    <svg viewBox="0 0 24 24" className="size-full" aria-hidden>
      <rect width="24" height="24" rx="5" fill="#fff" />
      <path fill="#34A853" d="M4 20 10 4h4L8 20H4Z" />
      <path fill="#4285F4" d="M14 4h6v16h-3L14 4Z" />
      <path fill="#FBBC04" d="M10 4h4l-6 16H4l6-16Z" opacity=".55" />
      <path fill="#EA4335" d="M12 8.2a3.4 3.4 0 0 1 3.4 3.4c0 2.5-3.4 6-3.4 6s-3.4-3.5-3.4-6A3.4 3.4 0 0 1 12 8.2Z" />
      <circle cx="12" cy="11.5" r="1.3" fill="#7C2B22" />
    </svg>
  );
}

function ChromeMark() {
  return (
    <svg viewBox="0 0 24 24" className="size-full" aria-hidden>
      <circle cx="12" cy="12" r="11" fill="#fff" />
      <circle cx="12" cy="12" r="4.6" fill="#fff" stroke="#1A73E8" strokeWidth="2.4" />
      <path fill="#EA4335" d="M12 1a11 11 0 0 1 9.5 5.5H12a5.5 5.5 0 0 0-5.2 3.7L3.3 4.7A11 11 0 0 1 12 1Z" />
      <path fill="#FBBC05" d="M3.3 4.7 8.6 13.7a5.5 5.5 0 0 0 4.6 3.7l-3.4 6A11 11 0 0 1 3.3 4.7Z" transform="translate(0.4 0)" />
      <path fill="#34A853" d="M22.9 9.3a11 11 0 0 1-13 12.1l4.4-7.6a5.5 5.5 0 0 0 3.2-4.5h5.4Z" />
    </svg>
  );
}

function KeepMark() {
  return (
    <svg viewBox="0 0 24 24" className="size-full" aria-hidden>
      <rect width="24" height="24" rx="5" fill="#FBBC04" />
      <path fill="#fff" d="M12 5.5a4.5 4.5 0 0 1 2.5 8.2v1.8h-5v-1.8A4.5 4.5 0 0 1 12 5.5Z" />
      <rect x="10.4" y="16.6" width="3.2" height="1.6" rx="0.8" fill="#fff" />
    </svg>
  );
}

const TOOLS = new Map<string, () => React.ReactNode>([
  ["gmail", () => <GmailMark />],
  ["calendar", () => <CalendarMark />],
  ["drive", () => <DriveMark />],
  ["maps", () => <MapsMark />],
  ["browser", () => <ChromeMark />],
  ["notes", () => <KeepMark />],
]);

export function ToolMarks({ tools, size = 16, className }: { tools: string[]; size?: number; className?: string }) {
  if (tools.length === 0) return null;
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-1", className)}>
      {tools.map((t) => {
        const Mark = TOOLS.get(t);
        if (!Mark) return null;
        return (
          <span
            key={t}
            title={t}
            className="inline-flex shrink-0 items-center justify-center overflow-hidden rounded-[4px] shadow-ring-xs"
            style={{ width: size, height: size }}
          >
            <Mark />
          </span>
        );
      })}
    </span>
  );
}
