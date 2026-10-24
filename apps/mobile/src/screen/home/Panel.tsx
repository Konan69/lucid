import { StackActions, type NavigationHelpers, type NavigationState } from '@react-navigation/native'
import type { Thread } from '@vivid/contracts'
import { Data, Effect, Option } from 'effect'
import { useState } from 'react'
import { closeDrawer } from '../../data/drawer'
import { refusalOf, useLiveData } from '../../data/live'
import { patchThread } from '../../data/threads'
import { NameSheet } from '../../ui/Sheet'
import { openPage, useFront, useMe, type DrawerOpening, type Routes } from '../../workspace'
import { Filing } from './Filing'
import { Menu } from './Menu'
import { Switcher } from './Switcher'

/**
 * What is open over the menu. It is one thing at a time, so the workspace sheet and a Thread being
 * renamed can never be up together.
 */
type Over = Data.TaggedEnum<{
  Nothing: {}
  Switching: {}
  Renaming: { readonly thread: Thread }
  Filing: { readonly thread: Thread }
}>
const Over = Data.taggedEnum<Over>()

/**
 * The menu's panel: every Thread, the places beside Threads, the workspace and Settings, with the
 * sheets its rows open.
 *
 * It used to be drawn by Home, inside Home's screen. The first screen now has the system's bar,
 * which belongs to the stack and stands over every screen's content, so a menu inside the screen
 * would slide in under the bar's buttons. The shell draws it over the whole stack instead
 * (`Shell` in `App.tsx`), and so it is handed the stack's navigation (`go`) and cannot ask for a
 * screen's own.
 *
 * Choosing a Thread puts it in the first screen's place (`data/front.ts`); nothing is pushed. A
 * page the menu opens stands in Home's place too (`openPage`), never over a Thread.
 * It owns no data. What is local is which sheet is up, and a row's action the server refused.
 */
export function Panel({ go, stack }: { go: NavigationHelpers<Routes>; stack: NavigationState }) {
  const me = useMe()
  const front = useFront()
  const [over, setOver] = useState<Over>(Over.Nothing())
  // A menu choice on a row that the server refused. The row has nowhere to say it.
  const [refused, setRefused] = useState<Option.Option<string>>(Option.none())
  const close = () => setOver(Over.Nothing())

  /**
   * Leaves the menu for Home, showing what `show` puts there. The drawer may have been opened over
   * one of its own pages (`DRAWER_PAGES`), which is taken down, so the Thread chosen is what is seen.
   */
  const home = (show: () => void) => {
    show()
    go.dispatch(StackActions.popTo('Home'))
    closeDrawer()
  }
  /** Leaves the menu for one of its pages, which takes the place of whatever was in front. */
  const page = (opening: DrawerOpening) => {
    go.dispatch(openPage(stack, opening))
    closeDrawer()
  }

  return (
    <>
      <Menu
        me={me}
        refused={refused}
        onSwitch={() => setOver(Over.Switching())}
        onFresh={() => home(() => front.fresh())}
        onGo={(place) => page({ name: place })}
        onProject={(id) => page({ name: 'Project', params: { id } })}
        onOpen={(thread) => home(() => front.open(thread.id, false))}
        onRename={(thread) => setOver(Over.Renaming({ thread }))}
        onFile={(thread) => setOver(Over.Filing({ thread }))}
        onRefused={setRefused}
      />
      {Over.$is('Switching')(over) && <Switcher me={me} onClose={close} />}
      {Over.$is('Renaming')(over) && <Rename thread={over.thread} onClose={close} />}
      {Over.$is('Filing')(over) && <Filing thread={over.thread} onClose={close} />}
    </>
  )
}

/** A Thread's title, changed in a sheet. The list shows the new title before the server answers. */
function Rename({ thread, onClose }: { thread: Thread; onClose: () => void }) {
  const data = useLiveData()
  return (
    <NameSheet
      title="Rename thread"
      label="Title"
      initial={thread.title}
      placeholder="What this thread is about"
      action="Save"
      maxLength={120}
      onClose={onClose}
      onSave={(title) =>
        title === thread.title
          ? Effect.succeedNone
          : patchThread(data, thread.id, { title }).pipe(Effect.map(refusalOf))
      }
    />
  )
}
