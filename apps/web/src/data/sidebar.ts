import { router } from './route'

/**
 * Whether the sidebar is showing. Kept outside React as an external store so the keyboard
 * shortcut can live at module scope rather than in an effect.
 *
 * It is two different things by width. On a wide window it is a column beside the page, and
 * hiding it is a preference: a Person who hides it means it, so it is remembered between visits.
 * On a narrow one there is no room beside the page, so it is a drawer over it: closed until asked
 * for, closed again as soon as the Person goes somewhere, and never remembered.
 */

const key = 'vivid.sidebar'
const wide = matchMedia('(min-width: 48rem)')
let pinned = localStorage.getItem(key) !== 'hidden'
let drawn = false
const listeners = new Set<() => void>()

const tell = () => {
  for (const listener of listeners) listener()
}

const set = (open: boolean) => {
  if (wide.matches) {
    pinned = open
    localStorage.setItem(key, open ? 'shown' : 'hidden')
  } else {
    drawn = open
  }
  tell()
}

export const sidebar = {
  subscribe: (listener: () => void) => {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  },
  isOpen: () => (wide.matches ? pinned : drawn),
  toggle: () => set(!sidebar.isOpen()),
  show: () => set(true),
  hide: () => set(false),
}

// Crossing the width changes which of the two it is, so whoever draws it must look again.
wide.addEventListener('change', () => {
  drawn = false
  tell()
})

// A drawer has done its job once the Person has chosen where to go.
router.subscribe(() => {
  if (!wide.matches && drawn) set(false)
})

// ⌘B / Ctrl+B toggles the sidebar, the shortcut every editor-shaped app has trained people on.
addEventListener('keydown', (event) => {
  if (event.key.toLocaleLowerCase() !== 'b' || !(event.metaKey || event.ctrlKey)) return
  event.preventDefault()
  sidebar.toggle()
})
