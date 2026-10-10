import { createFileRoute } from '@tanstack/react-router'
import { ThreadId } from '@vivid/contracts'
import { warm } from '../data/warm'

/**
 * `/t/$id`: one Thread. `main.tsx` gives it its screen (`place/Thread`).
 *
 * The loader fetches nothing and never holds the screen back: it opens the Thread's live query
 * and its conversation (`data/warm.ts`), and the screen reads the same two. The router runs it
 * when a pointer rests on a link to the Thread (`defaultPreload: 'intent'` in `src/router.ts`)
 * and again when the Person goes there, so the screen mounts onto what is already here.
 */
export const Route = createFileRoute('/t/$id')({
  // The address is where an id comes in from outside; it is branded here and typed from here on.
  params: {
    parse: ({ id }) => ({ id: ThreadId.make(id) }),
    stringify: ({ id }) => ({ id }),
  },
  loader: ({ params }) => warm.thread(params.id),
})
