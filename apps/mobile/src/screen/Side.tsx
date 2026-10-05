import { StackActions } from '@react-navigation/native'
import type { Thread } from '@vivid/contracts'
import { Data, Option, Result } from 'effect'
import { useState, type ReactNode } from 'react'
import { useWindowDimensions } from 'react-native'
import { closeDrawer } from '../data/drawer'
import type { Reach } from '../data/lead'
import { useLiveData } from '../data/live'
import { patchThread } from '../data/threads'
import { Drawer, drawerWidth } from '../ui/Drawer'
import { NameSheet } from '../ui/Sheet'
import { useGo, useMe } from '../workspace'
import { homeComposer } from './Home'
import { Filing } from './home/Filing'
import { Menu } from './home/Menu'
import { Switcher } from './home/Switcher'

/**
 * What is open over the drawer. It is one thing at a time, so the workspace sheet and a Thread
 * being renamed can never be up together.
 */
type Over = Data.TaggedEnum<{
  Nothing: {}
  Switching: {}
  Renaming: { readonly thread: Thread }
  Filing: { readonly thread: Thread }
}>
const Over = Data.taggedEnum<Over>()

/**
 * The drawer around the app: every Thread the Person has, the places beside Threads, the
 * workspace and Settings, and the sheets its rows open.
 *
 * It used to be inside Home. It is around the whole stack now for two reasons. Home has the
 * system's bar, which is drawn over a screen's content, so a drawer inside Home would slide
 * under the bar's own buttons. And a Thread opened from Home is beside Home, not under it
 * (`data/lead.ts`): its bar opens the same drawer, and choosing another Thread there swaps the
 * one in front.
 *
 * It is outside every screen, so `useGo` here is the stack's own container and not a screen's
 * navigation: it goes to places and nothing more is asked of it. Going to a Thread from a Thread
 * changes which Thread that screen shows; from Home it puts the Thread beside it.
 *
 * It owns no data. What is local is only what the Person is in the middle of here: which sheet
 * is up, and a row's action the server refused.
 */
export function Side({ reach, children }: { reach: Reach; children: ReactNode }) {
  const me = useMe()
  const go = useGo()
  const width = drawerWidth(useWindowDimensions().width)
  const [over, setOver] = useState<Over>(Over.Nothing())
  // A swipe or a menu choice on a row that the server refused. The row has nowhere to say it.
  const [refused, setRefused] = useState<Option.Option<string>>(Option.none())
  const close = () => setOver(Over.Nothing())

  /** Leaves the drawer for somewhere on the stack. It closes behind the screen that covers it. */
  const leave = (travel: () => void) => {
    travel()
    closeDrawer()
  }

  /**
   * A new Thread is Home: back to it from wherever the drawer was opened, and straight into its
   * composer. `popTo` is the stack's own way back to a screen already on it; from Home itself it
   * changes nothing.
   */
  const fresh = () => {
    leave(() => go.dispatch(StackActions.popTo('Home')))
    if (homeComposer.current !== null) homeComposer.current.focus()
  }

  return (
    <Drawer
      reach={reach}
      panel={
        <Menu
          me={me}
          width={width}
          refused={refused}
          onSwitch={() => setOver(Over.Switching())}
          onFresh={fresh}
          onGo={(place) => leave(() => go.navigate(place))}
          onProject={(id) => leave(() => go.navigate('Project', { id }))}
          onOpen={(thread) => leave(() => go.navigate('Chat', { id: thread.id }))}
          onRename={(thread) => setOver(Over.Renaming({ thread }))}
          onFile={(thread) => setOver(Over.Filing({ thread }))}
          onRefused={setRefused}
        />
      }
    >
      {children}
      {Over.$is('Switching')(over) && <Switcher me={me} onClose={close} />}
      {Over.$is('Renaming')(over) && <Rename thread={over.thread} onClose={close} />}
      {Over.$is('Filing')(over) && <Filing thread={over.thread} onClose={close} />}
    </Drawer>
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
      onSave={async (title) => {
        if (title === thread.title) return Option.none()
        const result = await patchThread(data, thread.id, { title })
        return Result.isFailure(result) ? Option.some(result.failure.message) : Option.none()
      }}
    />
  )
}
