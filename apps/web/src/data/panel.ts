/**
 * Whether the panel beside the Thread is open. It is a store and not a screen's own state because
 * more than one place opens it: the Thread's header, the panel around Vivid, and a link in a reply
 * that the desktop app shows in a page of its own.
 */
const listeners = new Set<() => void>()
let open = false

const set = (next: boolean) => {
  if (next === open) return
  open = next
  for (const listener of listeners) listener()
}

export const panel = {
  isOpen: () => open,
  subscribe: (listener: () => void) => {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  },
  show: () => set(true),
  hide: () => set(false),
  toggle: () => set(!open),
}
