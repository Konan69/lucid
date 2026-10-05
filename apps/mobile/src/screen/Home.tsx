import { useAtomValue } from '@effect/atom-react'
import { useAppearance } from '../data/vivid'
import { draftPlace, workspaceKey } from '@vivid/state'
import { Option } from 'effect'
import { useCallback, useState, useSyncExternalStore } from 'react'
import { Keyboard, ScrollView, View } from 'react-native'
import { arrivalOf, homeShows, Showing, type HomeScreen } from '../data/arrival'
import { draft, useDraft } from '../data/drafts'
import { Front } from '../data/front'
import { LiveState, useLive, useLiveData } from '../data/live'
import { Stand } from '../data/stand'
import { Start, startThread } from '../data/threads'
import { BarRoom, NO_ACTIONS, NOBODY, VividBar } from '../ui/Bar'
import { Composer } from '../ui/Composer'
import { AboveKeyboardBelowBar } from '../ui/Keyboard'
import { useOrigin, type Origin } from '../ui/Presence'
import { Label, Notice, styles } from '../ui/ui'
import { useFront, useGo, useMe, useShowing } from '../workspace'
import { Chat } from './Chat'
import { First, Waiting } from './home/First'
import { useScope } from './project/scope'

/**
 * The first screen, and the root of the app: somewhere to start a new Thread, or one Thread, in
 * the same place (`data/front.ts`).
 *
 * A Thread used to be a second screen pushed over this one, so a first message ended with the
 * Thread sliding in over the words just typed. Now the greeting is replaced by the conversation
 * where it stands: no screen is pushed, nothing moves, and the bar and the composer are in the
 * same places before and after. Choosing a Thread in the menu, or anywhere else in the app, puts
 * it here the same way.
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
 * typed, and a send the server refused.
 */
function Fresh() {
  // The name this Person or their Company gave Vivid, live.
  const vivid = useAppearance()
  const me = useMe()
  const data = useLiveData()
  const threads = useLive(data.live.threads)
  const origin = useOrigin()
  const start = useStart()
  const showing = homeShows(useArrival(), threads)
  const working =
    LiveState.$is('Ready')(threads) &&
    threads.value.threads.some((thread) => thread.attention === 'Working')
  // While a first message is on its way Vivid is thinking about what is on this screen, so the
  // capsule says so and what was sent rises to it from the composer. Work in some other Thread
  // is not this screen's: it shows only in the mood of Vivid's face.
  const elsewhere = working || Showing.$is('Waiting')(showing) ? 'thinking' : 'happy'

  return (
    <AboveKeyboardBelowBar>
      <VividBar
        stand={start.sending ? Stand.Thinking() : Stand.Resting({ mood: elsewhere })}
        origin={origin}
        inverted={false}
        present={NOBODY}
        actions={NO_ACTIONS}
      />
      <BarRoom />
      <Reconnecting />
      <Under
        showing={showing}
        me={me}
        start={start}
        origin={origin}
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

/** What `Writing` needs: who is writing, their words and the send, and where a send leaves from. */
interface WritingProps {
  me: ReturnType<typeof useMe>
  start: ReturnType<typeof useStart>
  origin: Origin
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
 * For someone Vivid has met: the greeting, anything the last send was refused for, and the
 * composer. The words and the send are `Fresh`'s (`useStart`), because Vivid's capsule at the top
 * thinks while a first message is on its way.
 */
function Writing({ me, start, origin, placeholder }: WritingProps) {
  return (
    <>
      <ScrollView
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        contentContainerStyle={[styles.column, { flexGrow: 1, justifyContent: 'flex-end' }]}
      >
        <First me={me} />
      </ScrollView>
      {Option.isSome(start.refusal) && (
        <View style={{ paddingHorizontal: 12, paddingBottom: 4 }}>
          <Notice message={start.refusal.value} />
        </View>
      )}
      <Composer
        origin={origin}
        value={start.draft}
        autoFocus={false}
        placeholder={placeholder}
        working={false}
        disabled={start.sending}
        onChange={start.setDraft}
        onSend={() => void start.send()}
        onStop={() => undefined}
      />
    </>
  )
}

/**
 * Said under the top bar while the phone cannot reach Vivid. The client is already trying again,
 * so there is nothing here to press.
 */
function Reconnecting() {
  const data = useLiveData()
  const reach = useAtomValue(data.link)
  if (reach !== 'lost') return null
  return (
    <View
      accessibilityRole="alert"
      accessibilityLiveRegion="polite"
      style={{ alignItems: 'center', paddingVertical: 6 }}
    >
      <Label size="label" tone="ink-2">
        Reconnecting…
      </Label>
    </View>
  )
}

/**
 * Starting a Thread from the composer under the greeting.
 *
 * The Thread takes the greeting's place only once the message is with Vivid, so words the Person
 * typed are never dropped on the way to a conversation that could not say so. It takes the
 * keyboard too when the keyboard was up (`Front.Thread.writing`), so sending does not put it away. If the Thread was made and the
 * message did not arrive, sending again speaks into that Thread instead of making a second one.
 *
 * The words are kept on the phone as they are typed (`data/drafts.ts`), under the Person's own
 * place for a new Thread, and are only removed once the Thread has started with them. So they are
 * still in the composer after visiting another screen, after the app is closed, and after a send
 * that was refused. Words typed while a send was on its way were not sent, and stay too.
 */
function useStart() {
  const me = useMe()
  const data = useLiveData()
  const front = useFront()
  const place = draftPlace(me.person.id, {
    workspace: workspaceKey(me.workspace),
    thread: Option.none(),
  })
  const typed = useDraft(place)
  const scoped = useScope()
  const setDraft = (text: string) => draft.keep(place, text)
  const [sending, setSending] = useState(false)
  const [last, setLast] = useState<Option.Option<Start>>(Option.none())

  async function send() {
    const message = typed.trim()
    if (message.length === 0 || sending) return
    setSending(true)
    // A Thread started while the drawer is scoped to a Project is filed in that Project.
    const projectId = Option.getOrNull(Option.map(scoped, (project) => project.id))
    // The empty Thread an earlier attempt left behind is spoken into, not made again. It is the
    // shell's to remember (`front.unsaid`): this screen is taken down between the two attempts
    // whenever the Person looks at another Thread first.
    const outcome = await startThread(data, { message, projectId, resume: front.unsaid() })
    setSending(false)
    // A Thread that was made and not reached is owed these words; one that started owes nothing.
    // A refusal to make one changes neither.
    if (Start.$is('NotSaid')(outcome)) front.owe(Option.some(outcome.id))
    if (Start.$is('Started')(outcome)) front.owe(Option.none())
    if (Start.$is('Started')(outcome)) {
      // Only the words that were sent leave the composer. It stays usable while the send is on
      // its way, so by now it can hold a second request; emptying it whatever it held used to
      // throw that away. Anything else is still the Person's and is here when they come back.
      if (draft.in(place).trim() === message) setDraft('')
      setLast(Option.none())
      front.open(outcome.id, Keyboard.isVisible())
      return
    }
    setLast(Option.some(outcome))
  }

  return {
    draft: typed,
    sending,
    setDraft,
    send,
    refusal: Option.flatMap(last, (outcome) =>
      Start.$match(outcome, {
        Started: () => Option.none<string>(),
        NotCreated: ({ message }) => Option.some(message),
        NotSaid: ({ message }) => Option.some(message),
      }),
    ),
  }
}
