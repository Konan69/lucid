/* ── Row geometry ─────────────────────────────────────────────
   36  a full line: rows and headings that lead with a mark. Navigates → hover fill.
   32  the tool rows, only.
   28  a caption: no mark, no fill. Ink brightens on hover.
   78  a card: a Thread that needs someone or is being worked on.           */
export const FULL = 'h-(--row-h)'
export const TOOL = 'h-(--tool-row-h)'
export const CAPTION = 'h-(--caption-h)'
export const HOVER = 'hover:bg-wash-hover'
export const ROW =
  'group/row relative flex w-full cursor-pointer items-center gap-2.5 rounded-row px-2.5 text-left outline-none select-none transition-colors duration-(--dur-fast)'
