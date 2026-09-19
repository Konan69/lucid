import { cn } from "./cn";

export function Avatar({ name, size = 24, className }: { name: string; size?: number; className?: string }) {
  const initial = name.trim().charAt(0).toUpperCase();
  // SAFETY: React forwards these validated CSS custom properties to the element.
  const avatarStyle = {
    "--avatar-size": `${size}px`,
    "--avatar-font-size": `${Math.round(size * 0.46)}px`,
  } as React.CSSProperties;
  return (
    <span
      aria-hidden
      className={cn("inline-flex size-(--avatar-size) shrink-0 items-center justify-center rounded-full bg-surface-3 text-(length:--avatar-font-size) font-title text-ink-2 ring-line", className)}
      style={avatarStyle}
    >
      {initial}
    </span>
  );
}
