/**
 * Whether the sidebar is showing. Kept outside React as an external store so the keyboard
 * shortcut can live at module scope rather than in an effect, and remembered between visits
 * because a Person who hides the sidebar means it.
 */

const key = 'vivid.sidebar'
let open = localStorage.getItem(key) !== 'hidden'
const listeners = new Set<() => void>()

const publish = () => {
  localStorage.setItem(key, open ? 'shown' : 'hidden')
  for (const listener of listeners) listener()
}

export const sidebar = {
  subscribe: (listener: () => void) => {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  },
  isOpen: () => open,
  toggle: () => {
    open = !open
    publish()
  },
  show: () => {
    open = true
    publish()
  },
}

// ⌘B / Ctrl+B toggles the sidebar, the shortcut every editor-shaped app has trained people on.
addEventListener('keydown', (event) => {
  if (event.key.toLocaleLowerCase() !== 'b' || !(event.metaKey || event.ctrlKey)) return
  event.preventDefault()
  sidebar.toggle()
})
