/* ── Row geometry ─────────────────────────────────────────────
   36  a full line: rows and headings that lead with a mark. Navigates → hover fill.
   32  the tool rows, only.
   28  a caption: no mark, no fill. Ink brightens on hover.                 */
export const FULL = 'h-(--row-h)'
export const TOOL = 'h-(--tool-row-h)'
export const CAPTION = 'h-(--caption-h)'
export const HOVER = 'hover:bg-wash-hover'
/* A row keeps the page's focus ring, drawn just inside its own edge so a list that clips its
   overflow does not cut it. */
export const ROW =
  'group/row relative flex w-full cursor-pointer items-center gap-2.5 rounded-row px-2.5 text-left select-none transition-colors duration-(--dur-fast) focus-visible:-outline-offset-2'
