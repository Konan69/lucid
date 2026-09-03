import { cn } from "./cn";

export function Avatar({ name, size = 24, className }: { name: string; size?: number; className?: string }) {
  const initial = name.trim().charAt(0).toUpperCase();
  return (
    <span
      aria-hidden
      className={cn("inline-flex shrink-0 items-center justify-center rounded-full bg-surface-3 text-ink-2 ring-line font-title", className)}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.46) }}
    >
      {initial}
    </span>
  );
}
