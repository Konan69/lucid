import { create } from 'zustand'

/**
 * Whether the panel beside the Thread is open. It is a store and not a screen's own state because
 * more than one place opens it: the Thread's header, the panel around Vivid, and a link in a reply
 * that the desktop app shows in a page of its own.
 *
 * A Zustand store, as T3 Code web keeps its interface state (`apps/web/src/rightPanelStore.ts`):
 * a component reads it with `usePanel` and a selector, and re-renders only when what it selected
 * changes. What changes it is `panel` below, plain functions over the store, so a module that is
 * not a component (a keyboard shortcut, `data/pages.ts`) calls the same thing a button does.
 */
export const usePanel = create(() => ({ open: false }))

export const panel = {
  show: () => usePanel.setState({ open: true }),
  hide: () => usePanel.setState({ open: false }),
  toggle: () => usePanel.setState((was) => ({ open: !was.open })),
}
