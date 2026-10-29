import type { ThreadId } from '@vivid/contracts'
import { thisReader, todos } from '@vivid/state'
import { Check, Ellipsis } from 'lucide-react'
import { Option } from 'effect'
import { closeTodo, useTodoStandings } from '../../data/todos'
import { Button } from '../../ui/button'
import { cn } from '../../ui/cn'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '../../ui/contextmenu'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../../ui/dropdownmenu'

const words = todos.makeTodoWords(thisReader())

const done = todos.Closing.cases.Complete.make({})
const drop = todos.Closing.cases.Drop.make({})

/**
 * The Person's own to-do list: one row per open to-do, soonest date first, under the waiting-on
 * list and built as its rows are (`Owed.tsx`): the same row, spacing, slot and menus, without the
 * time track, since a to-do has no waiting to draw.
 *
 * A row opens the Thread the to-do was added in. Its right slot says when it is due at rest; a
 * check (done) and a menu (done, remove, open) sit beside it and show on hover, on focus and
 * always on a touch screen. The same menu is on a right click. A row a press has closed folds
 * away where it stood (`motion-fold`) until the list drops it.
 */
export function Todos({
  open,
  now,
  onOpen,
}: {
  open: ReadonlyArray<todos.Open>
  now: number
  onOpen: (thread: ThreadId) => void
}) {
  const standings = useTodoStandings()
  return (
    // The rows' fill runs past the page's text edge, so their words line up with the head's.
    <section aria-labelledby="todos-heading" className="-mx-4">
      <h2 id="todos-heading" className="px-4 pb-1 text-label font-title text-ink-3">
        To do
      </h2>
      <ul className="flex flex-col">
        {open.map((todo) => (
          <Row
            key={todo.id}
            todo={todo}
            standing={Option.getOrElse(
              Option.fromUndefinedOr(standings.get(todo.id)),
              (): todos.Standing => 'shown',
            )}
            now={now}
            onOpen={() => onOpen(todo.threadId)}
          />
        ))}
      </ul>
    </section>
  )
}

/**
 * One to-do. The whole row opens its Thread (the words' button covers it), and the actions sit
 * above that cover. A press folds the row while it is on its way and after the server took it;
 * a press that did not get through brings the row back with one line saying so.
 */
function Row({
  todo,
  standing,
  now,
  onOpen,
}: {
  todo: todos.Open
  standing: todos.Standing
  now: number
  onOpen: () => void
}) {
  const folded = standing === 'folded'
  const due = Option.getOrUndefined(words.due(todo, now))
  return (
    <li data-folded={folded ? '' : undefined} inert={folded} className="motion-fold">
      <div>
        {standing === 'failed' && (
          <p className="px-3 pt-2 text-label text-danger">
            That did not reach Vivid. Press it again.
          </p>
        )}
        <ContextMenu>
          <ContextMenuTrigger
            render={
              <div className="group/todo relative rounded-row px-4 py-3 transition-colors duration-(--dur-fast) hover:bg-wash-hover has-focus-visible:bg-wash-hover" />
            }
          >
            <div className="flex items-start gap-3">
              <p className="line-clamp-2 min-w-0 flex-1 text-body text-pretty wrap-break-word">
                <button
                  type="button"
                  onClick={onOpen}
                  className="cursor-pointer font-meta text-ink outline-none after:absolute after:inset-0 after:rounded-row"
                >
                  {todo.what}
                </button>
              </p>
              {/* The slot yields (docs/08): the date at rest, the actions on hover or focus, in
                  the same place, so nothing in the row moves. Where there is no hover, both. With
                  no date the actions keep their own room, so they never cover the words. */}
              <div className="relative flex shrink-0 items-center justify-end gap-1 pt-px">
                <Actions todo={todo} over={due !== undefined} onOpen={onOpen} />
                {due !== undefined && (
                  <span
                    className={cn(
                      'text-label whitespace-nowrap tabular-nums group-hover/todo:invisible group-has-focus-visible/todo:invisible group-has-aria-expanded/todo:invisible pointer-coarse:visible',
                      due.late ? 'text-danger' : 'text-ink-2',
                    )}
                  >
                    {due.words}
                  </span>
                )}
              </div>
            </div>
          </ContextMenuTrigger>
          <ContextMenuContent>
            <ContextMenuItem onClick={() => closeTodo(todo.id, done)}>Done</ContextMenuItem>
            <ContextMenuItem onClick={() => closeTodo(todo.id, drop)}>
              Remove from list
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem onClick={onOpen}>Open the thread</ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      </div>
    </li>
  )
}

/**
 * The check and the menu in a row's slot. Hidden at rest so the list stays quiet; shown in place
 * of the date (`over`) while the row is hovered or something in it has focus, and beside it where
 * there is no hover. They sit above the row's open cover (`z-10`), so pressing them does not open
 * it.
 */
function Actions({ todo, over, onOpen }: { todo: todos.Open; over: boolean; onOpen: () => void }) {
  return (
    <span
      className={cn(
        'z-10 flex items-center opacity-0 group-hover/todo:opacity-100 group-has-focus-visible/todo:opacity-100 has-aria-expanded:opacity-100 pointer-coarse:opacity-100',
        over ? 'absolute inset-e-0 -top-1 pointer-coarse:static' : 'relative -my-1',
      )}
    >
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={`Done: ${todo.what}`}
        onClick={() => closeTodo(todo.id, done)}
      >
        <Check strokeWidth={2.25} />
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={<Button variant="ghost" size="icon-sm" aria-label={`More for ${todo.what}`} />}
        >
          <Ellipsis />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={() => closeTodo(todo.id, done)}>Done</DropdownMenuItem>
          <DropdownMenuItem onClick={() => closeTodo(todo.id, drop)}>
            Remove from list
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={onOpen}>Open the thread</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </span>
  )
}
