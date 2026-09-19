import { cn } from "./cn";

export type FaceColor =
  | "accent" | "brown" | "red" | "orange" | "yellow" | "green"
  | "cyan" | "blue" | "violet" | "magenta" | "gray";

export type FaceMood = "neutral" | "happy" | "thinking" | "asleep";

const COLOR_CLASS = {
  accent: "bg-accent",
  brown: "bg-face-brown",
  red: "bg-face-red",
  orange: "bg-face-orange",
  yellow: "bg-face-yellow",
  green: "bg-face-green",
  cyan: "bg-face-cyan",
  blue: "bg-face-blue",
  violet: "bg-face-violet",
  magenta: "bg-face-magenta",
  gray: "bg-face-gray",
} satisfies Record<FaceColor, string>;

/** Vivid's face: a disc with two eyes. Same family as Grok Bot's blobs, its own shape. */
export function Face({
  color = "accent",
  mood = "neutral",
  size = 28,
  className,
  label,
  style,
}: {
  color?: FaceColor;
  mood?: FaceMood;
  size?: number;
  className?: string;
  label?: string;
  style?: React.CSSProperties;
}) {
  const eye = Math.max(2, Math.round(size * 0.11));
  const eyeH = mood === "asleep" ? Math.max(1.5, eye * 0.35) : Math.round(size * 0.24);
  const gap = Math.round(size * 0.22);
  const tilt = mood === "thinking" ? "rotate(-8deg)" : mood === "happy" ? "rotate(4deg)" : undefined;
  return (
    <span
      role="img"
      aria-label={label ?? "Vivid"}
      className={cn("relative inline-flex shrink-0 items-center justify-center rounded-full", COLOR_CLASS[color], className)}
      style={{
        ...style,
        width: size,
        height: size,
        transform: tilt,
        backgroundImage: "radial-gradient(circle at 32% 28%, rgb(255 255 255 / 0.28), transparent 55%)",
        boxShadow: "inset 0 -1px 2px rgb(0 0 0 / 0.25), 0 1px 2px rgb(0 0 0 / 0.18)",
      }}
    >
      <span className="absolute flex items-center" style={{ gap, top: "38%" }}>
        <i className="block rounded-full bg-[#0f0f0f]" style={{ width: eye, height: eyeH, transform: "rotate(-6deg)" }} />
        <i className="block rounded-full bg-[#0f0f0f]" style={{ width: eye, height: eyeH, transform: "rotate(6deg)" }} />
      </span>
    </span>
  );
}
