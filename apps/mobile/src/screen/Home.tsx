import { useAppearance } from '../data/vivid'
import { attaching, draftPlace, workspaceKey } from '@vivid/state'
import { Option } from 'effect'
import { useCallback, useSyncExternalStore } from 'react'
import { Keyboard, ScrollView, View } from 'react-native'
import { arrivalOf, homeShows, Showing, type HomeScreen } from '../data/arrival'
import { clearTray, pastePictures, removeFile, useTray } from '../data/attach'
import { useMicrophone } from '../data/dictation'
import { draft, useDraft } from '../data/drafts'
import { again, begin, startedWith } from '../data/first'
import { Front } from '../data/front'
import { LiveState, useLive, useLiveData } from '../data/live'
import { firstWay } from '../data/threads'
import { BarRoom, NO_ACTIONS, NOBODY, VividBar } from '../ui/Bar'
import { Composer, type Attachments } from '../ui/Composer'
import { AboveKeyboardBelowBar } from '../ui/Keyboard'
import { styles } from '../ui/ui'
import { useFront, useGo, useMe, useShowing } from '../workspace'
import { Chat } from './Chat'
import { First, Waiting } from './home/First'
import { useScope } from './project/scope'
import { start } from '../data/app'

/**
 * The first screen, and the root of the app: somewhere to start a new Thread, or one Thread, in
 * the same place (`data/front.ts`).
 *
 * A Thread used to be a second screen pushed over this one, so a first message ended with the
 * Thread sliding in over the words just typed. Now the greeting is replaced by the conversation
 * where it stands: no screen is pushed, and the bar and the composer are in the same places
 * before and after. It is replaced the moment a first message is sent, with those words already
 * in the conversation (`useStart`). Choosing a Thread in the menu, or anywhere else in the app,
 * puts it here the same way.
 *
 * Every Thread the Person has, the places beside Threads, the workspace and Settings are in the
 * menu (`screen/home/Panel.tsx`), one swipe or one tap on the bar's first button away. The menu
 * is drawn by the shell, over the stack and its bar, not by this screen.
 */
export function Home() {
  return Front.$match(useShowing(), {
    Fresh: () => <Fresh />,
    Thread: ({ id, writing }) => <Chat id={id} writing={writing} />,
  })
}

/**
 * Somewhere to start a new Thread: Vivid's greeting and the composer.
 *
 * Someone Vivid has not met gets neither. Their first Thread is opened by the server and Vivid
 * speaks first in it (`data/arrival.ts`); this is only Vivid's face until that Thread takes its
 * place, and draws nothing under its bar for the moment before it is known which Person this is.
 *
 * It owns no data. What is local is only what the Person is in the middle of: what they have
 * typed or attached.
 */
function Fresh() {
  // The name this Person or their Company gave Vivid, live.
  const vivid = useAppearance()
  const me = useMe()
  const data = useLiveData()
  const threads = useLive(data.live.threads)
  const starting = useStart()
  const showing = homeShows(useArrival(), threads)
  const working =
    LiveState.$is('Ready')(threads) &&
    threads.value.threads.some((thread) => thread.attention === 'Working')
  // Vivid's face thinks while it is at work anywhere: on a first Thread being opened, or in some
  // other Thread.
  const mood = working || Showing.$is('Waiting')(showing) ? 'thinking' : 'happy'

  return (
    <AboveKeyboardBelowBar>
      {/* No avatar at the top here: it is in the middle of the page, over the greeting. */}
      <VividBar conversation={false} present={NOBODY} actions={NO_ACTIONS} />
      <BarRoom />
      <Under
        showing={showing}
        me={me}
        mood={mood}
        starting={starting}
        placeholder={`Message ${vivid.name}`}
      />
    </AboveKeyboardBelowBar>
  )
}

/**
 * Where this session's first arrival stands, read as the first screen listens to it. Listening
 * is also how the arrival reaches the app: it is told whether the first screen is in front, how
 * to put a Thread there, and when the Person comes back to it. So the server is asked from the
 * Thread list and the screen's focus, never from the screen having rendered.
 */
function useArrival() {
  const arrival = arrivalOf(useLiveData())
  const go = useGo()
  const front = useFront()
  const attend = useCallback(
    (watcher: () => void) => {
      const home: HomeScreen = {
        isFocused: () => go.isFocused(),
        open: (id) => front.open(id, false),
        onFocus: (heard) => go.addListener('focus', heard),
      }
      return arrival.attend(home, watcher)
    },
    [arrival, go, front],
  )
  return useSyncExternalStore(attend, arrival.standing)
}

/** What `Writing` needs: who is writing, how Vivid's face looks, their words and the send. */
interface WritingProps {
  me: ReturnType<typeof useMe>
  mood: 'happy' | 'thinking'
  starting: ReturnType<typeof useStart>
  placeholder: string
}

/**
 * What is drawn under the bar before anything is said (`homeShows`): nothing yet, Vivid's face while a first Thread is
 * being opened, or the greeting and the composer.
 */
function Under({ showing, ...writing }: WritingProps & { showing: Showing }) {
  return Showing.$match(showing, {
    // The room is kept, so the bar does not move when what goes here arrives.
    Nothing: () => <View style={{ flex: 1 }} />,
    Waiting: () => <Waiting />,
    Ordinary: () => <Writing {...writing} />,
  })
}

/**
 * For someone Vivid has met: the greeting in the middle of the page, and the composer. The words
 * and the send are `Fresh`'s (`useStart`), which also decides the mood of the face.
 */
function Writing({ me, mood, starting, placeholder }: WritingProps) {
  return (
    <View style={{ flex: 1 }}>
      <ScrollView
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        contentContainerStyle={[styles.column, { flexGrow: 1 }]}
      >
        <First me={me} mood={mood} />
      </ScrollView>
      <View>
        <Composer
          value={starting.draft}
          autoFocus={false}
          placeholder={placeholder}
          working={false}
          disabled={false}
          attachments={Option.some(starting.attachments)}
          dictation={starting.microphone}
          onChange={starting.setDraft}
          onSend={starting.send}
          onStop={() => undefined}
        />
      </View>
    </View>
  )
}

/**
 * Starting a Thread from the composer under the greeting.
 *
 * The Thread takes the greeting's place at once, with the words already in its conversation, and
 * the server is told while it is drawn (`begin`, `data/first.ts`). It used to take the greeting's
 * place only once the server had made it and taken the message, which left the greeting standing
 * still for two calls and then brought the Thread in as an outline: the owner asked for the first
 * message to be mounted at once and to rise into place (7 October 2026). The Thread takes the
 * keyboard too when the keyboard was up (`Front.Thread.writing`), so sending does not put it away.
 *
 * Words are never dropped on the way. They stay kept on the phone under this composer until they
 * are with Vivid (`firstWay`, `data/threads.ts`), so an app closed mid-send still has them. If
 * they do not arrive, the Thread says so beside them with the way to send them again, and
 * sending them from this composer goes on as that same Thread (`startedWith`).
 *
 * The words are kept on the phone as they are typed (`data/drafts.ts`), under the Person's own
 * place for a new Thread, so they are still in the composer after visiting another screen and
 * after the app is closed.
 */
export function useStart() {
  const me = useMe()
  const data = useLiveData()
  const front = useFront()
  const go = useGo()
  const id = useSyncExternalStore(front.subscribe, front.draft)
  const tray = useTray(id)
  const place = draftPlace(me.person.id, {
    workspace: workspaceKey(me.workspace),
    thread: Option.none(),
  })
  const typed = useDraft(place)
  // The microphone writes into this same draft.
  const microphone = useMicrophone(place)
  const scoped = useScope()
  const setDraft = (text: string) => draft.keep(place, text)

  function send() {
    // A second press from the consumed draft cannot start its first message again.
    if (front.draft() !== id || tray.preparing || tray.choosing) return
    const words = typed.trim()
    const carried = attaching.carriedBy(tray)
    const message = {
      words: [words, ...carried.lines].filter((line) => line.length > 0).join('\n'),
      pictures: carried.pictures,
    }
    if (message.words.length === 0 && message.pictures.length === 0) return
    const way = firstWay(data)
    // Words that are already a Thread's first, and not yet with Vivid, go on as that Thread:
    // sending them again from here must not start a second one.
    // Newly chosen files are a new message, even when its text matches a failed send.
    const begun = tray.items.some(attaching.isKept)
      ? Option.none()
      : startedWith(front.firsts.all(), words, place)
    if (Option.isSome(begun)) {
      void start(again(way, front.firsts, begun.value))
      front.open(begun.value, Keyboard.isVisible())
      return
    }
    // The draft's reserved id lets it be drawn before the server has made it. The words
    // stay kept on the phone until they are with Vivid (`taken`), so closing the app before then
    // does not lose them; the composer they were typed in is not on screen meanwhile.
    void start(
      begin(way, front.firsts, id, {
        words,
        message,
        // A Thread started while the drawer is scoped to a Project is filed in that Project.
        projectId: Option.getOrNull(Option.map(scoped, (project) => project.id)),
        at: Date.now(),
        place,
      }),
    )
    clearTray(data, id, false)
    front.open(id, Keyboard.isVisible())
  }

  const attachments: Attachments = {
    tray,
    onAttach: () => go.navigate('Add', { thread: id, shared: false }),
    onRemove: (key) => removeFile(data, id, false, key),
    onPaste: (uris) => pastePictures(data, id, false, uris),
  }
  return { draft: typed, setDraft, send, microphone, attachments }
}
