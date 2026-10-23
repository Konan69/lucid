import type { NavigationHelpers } from '@react-navigation/native'
import type { Thread } from '@vivid/contracts'
import { Data, Effect, Option } from 'effect'
import { useState } from 'react'
import { useWindowDimensions } from 'react-native'
import { closeDrawer } from '../../data/drawer'
import { refusalOf, useLiveData } from '../../data/live'
import { patchThread } from '../../data/threads'
import { drawerWidth } from '../../ui/Drawer'
import { NameSheet } from '../../ui/Sheet'
import { useFront, useMe, type Routes } from '../../workspace'
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
 * Choosing a Thread puts it in the first screen's place (`data/front.ts`); nothing is pushed.
 * It owns no data. What is local is which sheet is up, and a row's action the server refused.
 */
export function Panel({ go }: { go: NavigationHelpers<Routes> }) {
  const me = useMe()
  const front = useFront()
  const width = drawerWidth(useWindowDimensions().width)
  const [over, setOver] = useState<Over>(Over.Nothing())
  // A swipe or a menu choice on a row that the server refused. The row has nowhere to say it.
  const [refused, setRefused] = useState<Option.Option<string>>(Option.none())
  const close = () => setOver(Over.Nothing())

  /** Leaves the menu for somewhere else. It closes behind whatever is shown. */
  const leave = (travel: () => void) => {
    travel()
    closeDrawer()
  }

  return (
    <>
      <Menu
        me={me}
        width={width}
        refused={refused}
        onSwitch={() => setOver(Over.Switching())}
        onFresh={() => leave(() => front.fresh())}
        onGo={(place) => leave(() => go.navigate(place))}
        onProject={(id) => leave(() => go.navigate('Project', { id }))}
        onOpen={(thread) => leave(() => front.open(thread.id, false))}
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
