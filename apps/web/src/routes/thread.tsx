import { createFileRoute } from '@tanstack/react-router'
import { ThreadId } from '@vivid/contracts'
import { Option, Schema } from 'effect'
import { pages } from '../data/pages'
import { panel } from '../data/panel'
import { warm } from '../data/warm'

/**
 * `?screen`: open the Thread with Vivid's computer beside it. The phone opens this when a step
 * Vivid handed over is finished on a screen the app cannot draw (a relayed one): the same
 * Thread, signed in on the same server, with the screen in front.
 */
const Search = Schema.Struct({ screen: Schema.optionalKey(Schema.Literal(true)) })
const decodeSearch = Schema.decodeUnknownOption(Search)

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
  // Anything but `screen` is dropped; a malformed one is as if it were not there.
  validateSearch: (search): typeof Search.Type =>
    Option.getOrElse(decodeSearch(search), () => ({})),
  loaderDeps: ({ search }) => ({ screen: search.screen === true }),
  loader: ({ params, deps }) => {
    if (deps.screen) {
      pages.toComputer()
      panel.show()
    }
    return warm.thread(params.id)
  },
})
