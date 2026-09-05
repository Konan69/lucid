import { useTheme } from "../theme";
const map = {
  "--color-foreground": "ink",
  "--color-placeholder": "ink-3",
  "--color-subtle": "wash-hover",
  "--color-border": "line-2",
  "--color-inline-skill-background": "accent-soft",
  "--color-inline-skill-border": "line-2",
  "--color-inline-skill-foreground": "accent-ink",
  "--color-icon-muted": "ink-2",
} as const;
export function useThemeColor(key: keyof typeof map) {
  return useTheme().colors[map[key]];
}
