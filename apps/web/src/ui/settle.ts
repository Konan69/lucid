import { Option } from 'effect'
import { type MotionName, still, timing } from './motion'

/**
 * Lists whose contents arrive and move on their own: a Thread that starts working jumps to
 * another part of the sidebar, a new Message lands under the last. Nothing the Person did caused
 * it, so there is no event handler to animate from; these watch the list itself.
 *
 * Both are `ref` callbacks. They watch with a `MutationObserver`, which is told of a change after
 * React has made it and before the browser draws it. That is the one moment a list can be played
 * from where it was to where it now is. Neither runs on anything but an item being added or
 * taken away: text that streams into an item changes no list, so it costs nothing here.
 */

/** More than this arriving at once is a list loading, not something happening in it. */
const TOGETHER = 2

const MOVING = 'settle-move'

/** An item rising into its place as it appears: the `motion-enter` class, played by script. */
function arrive(item: Element) {
  const from = still() ? { opacity: 0 } : { opacity: 0, translate: '0 6px' }
  item.animate([from, {}], timing('enter'))
}

/**
 * Plays each new item of a list in as it arrives: `ref` it on the list, and mark the items with
 * `data-arrives`. What is in the list when it is first drawn does not move, and neither does a
 * history that loads all at once: reading back through a Thread is not an event.
 */
export function arriving(list: HTMLElement | null) {
  if (list === null) return undefined
  const watcher = new MutationObserver((changes) => {
    const added = changes
      .flatMap((change) => Array.from(change.addedNodes))
      .filter((node): node is HTMLElement => node instanceof HTMLElement)
      .filter((node) => node.dataset.arrives !== undefined && node.isConnected)
    if (added.length > 0 && added.length <= TOGETHER) added.forEach(arrive)
  })
  // Direct children only: what happens inside an item is that item's own business.
  watcher.observe(list, { childList: true })
  return () => watcher.disconnect()
}

/**
 * Where an item is and how large, from the top left of everything its list holds. The list is
 * what scrolls, so how far it is scrolled is counted in: scrolling does not change a box.
 */
interface Box {
  readonly top: number
  readonly left: number
  readonly width: number
  readonly height: number
}

const boxIn = (list: HTMLElement, item: HTMLElement): Box => {
  const within = list.getBoundingClientRect()
  const { top, left, width, height } = item.getBoundingClientRect()
  return {
    top: top - within.top + list.scrollTop,
    left: left - within.left + list.scrollLeft,
    width,
    height,
  }
}

/**
 * Where an item is laid out and where it is drawn, which differ while it is still travelling
 * from an earlier move. The move is ended here, so the next one starts from where the eye last
 * saw the item and not from where it was heading.
 */
function measure(list: HTMLElement, item: HTMLElement) {
  const travelling = item.getAnimations().filter((animation) => animation.id === MOVING)
  if (travelling.length === 0) {
    const laid = boxIn(list, item)
    return { laid, drawn: laid.top }
  }
  const drawn = boxIn(list, item).top
  for (const animation of travelling) animation.cancel()
  return { laid: boxIn(list, item), drawn }
}

// ── Folding ──────────────────────────────────────────────────────────────────
// A part of a list that the Person folds away and opens again says so with `data-folds` on the
// element that holds its items, set to a word that differs between the two (`open`, `folded`).
// When that word changes, the items that came or went in the same change did so because the
// Person asked, however many they are, and they are played as T3 Code web plays the rows of a
// shelf (`refs/t3code/apps/web/src/components/Sidebar.motion.ts`, `createSidebarListMotion`):
// a row that goes leaves a copy of itself that fades where it stood, a row that comes fades in
// where it stands, and the rows below glide over the same time to their new places.
//
// What differs from the reference, and why:
// - It moves and fades every row in 150 ms with the browser's `ease-out`. Here a fold closing is
//   `exit` (150 ms) and a fold opening is `fold` (200 ms), the app's own names, so a fold goes
//   faster than it comes like everything else that leaves.
// - Its rows are the list's direct children, and a row beside a moving one takes that one's
//   travel. Here a fold's rows sit under a caption that does not move, which in the reference's
//   own rule (`ridingDelta`) is a travel of nothing: they fade in place.
// - Its list does not scroll; this one is what scrolls. A fold near the end of a scrolled list
//   leaves less to scroll, and the browser pulls the list down by the difference before anything
//   is drawn. `settling` keeps how far the list was scrolled (`scrolled`) and counts that pull
//   in, for the copies and for every row that glides, so each starts where the eye last saw it.
// - Its copy also drops attributes its own tests and selection read. Here a copy drops `id` and
//   the `data-moves` name, so it is never taken for the row it was.

/** More rows than this coming or going at once are not faded: `MAX_FADED_ROWS_PER_UPDATE` there. */
const FADED_AT_MOST = 40

/**
 * What a row is in the middle of, kept so that a row sent away before it has finished leaves
 * from where it is and as faint as it is (the reference's `running` and `entering`): how far it
 * still had to glide, and how far its fade in had got. A row that is in neither is at rest.
 */
const gliding = new WeakMap<Element, { readonly animation: Animation; readonly from: number }>()
const fadingIn = new WeakMap<Element, Animation>()

/** How far through an animation is, from 0 to 1. One that is over is 1. */
const progressOf = (animation: Animation) => {
  if (animation.playState === 'finished' || animation.effect === null) return 1
  // No progress is an animation outside its time: this one has no delay, so it has ended.
  return Option.getOrElse(
    Option.fromNullishOr(animation.effect.getComputedTiming().progress),
    () => 1,
  )
}

/** How far a row's fade in has got. A row that was never faded in is fully there. */
const fadedIn = (row: Element) =>
  Option.match(Option.fromUndefinedOr(fadingIn.get(row)), { onNone: () => 1, onSome: progressOf })

/** How far a row still has to travel to where it is laid out. A row that is not gliding, none. */
const leftToGlide = (row: Element) =>
  Option.match(Option.fromUndefinedOr(gliding.get(row)), {
    onNone: () => 0,
    onSome: ({ animation, from }) => from * (1 - progressOf(animation)),
  })

/** Takes out every copy still fading: the rows they stood for are back, or nothing is to move. */
const retire = (list: HTMLElement) => {
  for (const ghost of list.querySelectorAll('[data-ghost]')) ghost.remove()
}

/** A copy of a row that has gone, kept only to fade. Changes that are only these are not changes. */
const isGhost = (node: Node) => node instanceof HTMLElement && node.dataset.ghost !== undefined

const rowsAmong = (nodes: NodeList) =>
  Array.from(nodes).filter(
    (node): node is HTMLElement => node instanceof HTMLElement && node.dataset.moves !== undefined,
  )

/**
 * Leaves a copy of a row that has gone where the row stood, and fades it. React owns the row and
 * has already taken it out; the copy cannot be pressed, read aloud or found by name, and takes
 * itself out when it has faded. The list must be positioned, so the copy's place is counted from
 * the same corner the row's was. `pulled` is how far the list was pulled down by the change.
 */
function fadeAway(
  list: HTMLElement,
  row: HTMLElement,
  places: ReadonlyMap<string, Box>,
  pulled: number,
) {
  const box = row.dataset.moves === undefined ? undefined : places.get(row.dataset.moves)
  const ghost = row.cloneNode(true)
  if (box === undefined || box.height === 0 || !(ghost instanceof HTMLElement)) return
  for (const element of [ghost, ...ghost.querySelectorAll('[id], [data-moves]')]) {
    // An `id` inside a drawing names a gradient or a clip that the drawing itself points at.
    if (!(element instanceof SVGElement)) element.removeAttribute('id')
    element.removeAttribute('data-moves')
  }
  ghost.dataset.ghost = ''
  ghost.setAttribute('aria-hidden', 'true')
  ghost.inert = true
  Object.assign(ghost.style, {
    position: 'absolute',
    top: `${box.top + leftToGlide(row) - pulled - list.clientTop}px`,
    left: `${box.left - list.clientLeft}px`,
    width: `${box.width}px`,
    height: `${box.height}px`,
    margin: '0',
    // A row outside its list would be given a bullet.
    listStyle: 'none',
    pointerEvents: 'none',
  })
  list.append(ghost)
  const fading = ghost.animate([{ opacity: fadedIn(row) }, { opacity: 0 }], {
    ...timing('exit'),
    fill: 'forwards',
  })
  fading.addEventListener('finish', () => ghost.remove(), { once: true })
}

/**
 * The folds whose word has changed since they were last looked at: the ones the Person has just
 * folded or opened. A fold seen for the first time has not changed; it has only arrived.
 */
function toggled(list: HTMLElement, words: WeakMap<Element, string>) {
  const changed = new Set<Node>()
  for (const fold of list.querySelectorAll<HTMLElement>('[data-folds]')) {
    const word = fold.dataset.folds
    if (word === undefined) continue
    const was = words.get(fold)
    words.set(fold, word)
    if (was !== undefined && was !== word) changed.add(fold)
  }
  return changed
}

/** The rows that came and went because a fold was opened or folded, out of everything that changed. */
function folded(changes: ReadonlyArray<MutationRecord>, folds: ReadonlySet<Node>) {
  const folding = changes.filter((change) => folds.has(change.target))
  return {
    opened: new Set(folding.flatMap((change) => rowsAmong(change.addedNodes))),
    closed: folding.flatMap((change) => rowsAmong(change.removedNodes)),
  }
}

/**
 * Fades the rows of a fold in where they stand and out where they stood. More than a screenful
 * at once is not faded: every row that goes costs a copy and an animation of its own.
 */
function fade(
  list: HTMLElement,
  rows: { readonly opened: ReadonlySet<HTMLElement>; readonly closed: ReadonlyArray<HTMLElement> },
  was: { readonly places: ReadonlyMap<string, Box>; readonly pulled: number },
) {
  if (rows.opened.size + rows.closed.length > FADED_AT_MOST) return
  for (const row of rows.opened) {
    fadingIn.set(row, row.animate([{ opacity: 0 }, { opacity: 1 }], timing('fold')))
  }
  for (const row of rows.closed) fadeAway(list, row, was.places, was.pulled)
}

/** Plays an item to where it now is from `from` pixels away, as a transform. */
function glideFrom(item: HTMLElement, from: number, how: ReturnType<typeof timing>) {
  // Under a pixel is a rounding difference; over a screen is a jump nobody can follow.
  if (Math.abs(from) < 1 || Math.abs(from) > innerHeight) return
  const animation = item.animate([{ translate: `0 ${from}px` }, { translate: '0 0' }], {
    ...how,
    id: MOVING,
  })
  gliding.set(item, { animation, from })
}

/** What the rest of the list keeps time with: the rows fading in a fold, when there are any. */
function pace(opened: number, closed: number): MotionName {
  if (closed > 0) return 'exit'
  return opened > 0 ? 'fold' : 'layout'
}

/**
 * Keeps a list settled as it changes: an item that has a new place glides to it, an item that is
 * new rises in, and everything below a gap closes up. `ref` it on the element that scrolls the
 * list, and give every item that can move a `data-moves` name that is its own for as long as it
 * lives (a Thread's id, a caption's label). An item that goes from one part of the list to
 * another is a new element with the same name, and still glides.
 *
 * It is first-last-invert-play: the places are measured once after the change, each item is put
 * back where it was with a transform, and the transform is played out. Nothing is laid out again
 * while they travel. Under reduced motion nothing travels; a new item only fades in.
 *
 * A part of the list the Person folds and opens is marked with `data-folds`; see "Folding" above.
 */
export function settling(list: HTMLElement | null) {
  if (list === null) return undefined
  /** Every item that can move, with the name it is followed by. */
  const items = () =>
    Array.from(list.querySelectorAll<HTMLElement>('[data-moves]')).flatMap((item) =>
      item.dataset.moves === undefined ? [] : [{ item, name: item.dataset.moves }],
    )
  let places = new Map(items().map(({ item, name }) => [name, boxIn(list, item)]))
  const words = new WeakMap<Element, string>()
  toggled(list, words)
  // How far the list is scrolled, as the Person last left it. A change that shortens the list
  // can pull it down; the event for that comes after the change is looked at, so until then
  // this is still where it was.
  let scrolled = list.scrollTop
  const scrolling = () => {
    scrolled = list.scrollTop
  }
  list.addEventListener('scroll', scrolling, { passive: true })

  const watcher = new MutationObserver((changes) => {
    // A copy left to fade, or taken out when it has, moves nothing: looking again would end
    // every glide under way and start it over.
    if (changes.every((change) => [...change.addedNodes, ...change.removedNodes].every(isGhost)))
      return
    const before = places
    const measured = items().map(({ item, name }) => {
      const { laid, drawn } = measure(list, item)
      return { item, name, laid, drawn }
    })
    places = new Map(measured.map(({ name, laid }) => [name, laid]))
    const pulled = scrolled - list.scrollTop
    scrolled = list.scrollTop
    const folds = toggled(list, words)
    const { opened, closed } = folded(changes, folds)
    // Rows that are back, or a change that is to be drawn at once, leave no copies fading over it.
    const instant = document.documentElement.dataset.motion === 'off'
    if (instant || opened.size > 0) retire(list)
    // A change made from the keyboard is drawn at once; see `instantly`.
    if (instant) return

    fade(list, { opened, closed }, { places: before, pulled })

    const fresh = measured.filter(({ item, name }) => !before.has(name) && !opened.has(item))
    if (fresh.length <= TOGETHER) for (const { item } of fresh) arrive(item)
    if (still()) return

    // What closes up under a fold keeps time with the rows fading in it.
    const glide = timing(pace(opened.size, closed.length))
    for (const { item, name, laid, drawn } of measured) {
      const was = before.get(name)
      // Where it was drawn before the change: its old place, plus whatever it had left to travel.
      if (was === undefined) continue
      glideFrom(item, was.top + (drawn - laid.top) - laid.top - pulled, glide)
    }
  })
  watcher.observe(list, { childList: true, subtree: true })
  return () => {
    watcher.disconnect()
    retire(list)
    list.removeEventListener('scroll', scrolling)
  }
}
