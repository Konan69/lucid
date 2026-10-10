import { startThread } from '../data/threads'
import { Library } from '../screen/Library'

/** What `/library` draws. Asking about an item starts a Thread with the question already in it. */
export function LibraryPlace() {
  return (
    <Library
      onAsk={(document) =>
        startThread(`Read “${document.name}” in the Library and tell me what matters in it.`)
      }
    />
  )
}
