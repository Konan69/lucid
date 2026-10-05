import { useAtomValue } from '@effect/atom-react'
import { useAppearance } from '../data/vivid'
import type { ThreadId } from '@vivid/contracts'
import { draftPlace, workspaceKey } from '@vivid/state'
import { Option } from 'effect'
import { createRef, useCallback, useState, useSyncExternalStore } from 'react'
import { ScrollView, View } from 'react-native'
import Animated, { useAnimatedRef } from 'react-native-reanimated'
import { arrivalOf, homeShows, Showing, type HomeScreen } from '../data/arrival'
import { draft, useDraft } from '../data/drafts'
import { LiveState, useLive, useLiveData } from '../data/live'
import { Start, startThread } from '../data/threads'
import type { ComposerEditorHandle } from '../native/composer/types'
import { BarRoom, NO_ACTIONS, NOBODY, VividBar } from '../ui/Bar'
import { Composer } from '../ui/Composer'
import { AboveKeyboardBelowBar } from '../ui/Keyboard'
import { Stand, type Origin } from '../ui/Presence'
import { Label, Notice, styles } from '../ui/ui'
import { useGo, useMe } from '../workspace'
import { First, Waiting } from './home/First'
import { useScope } from './project/scope'

/**
 * Home's composer, for whatever is outside Home and sends the Person here to write: the drawer's
 * "New thread" (`screen/Side.tsx`). There is one Home on the stack and it stays mounted under
 * everything, so this holds its composer for as long as the Person can write there, and nothing
 * while Home has none (a first arrival).
 */
export const homeComposer = createRef<ComposerEditorHandle>()

/**
 * Home: Vivid's greeting and somewhere to write. It is the root of the app and the first screen,
 * and it is only that: every Thread the Person has, the places beside Threads, the workspace and
 * Settings are in the drawer, one swipe or one tap on the bar's first button away
 * (`screen/Side.tsx`).
 *
 * Someone Vivid has not met gets neither. Their first Thread is opened by the server and Vivid
 * speaks first in it (`data/arrival.ts`); Home is only Vivid's face until that Thread covers it,
 * and draws nothing under its bar for the moment before it is known which Person this is.
 *
 * It owns no data. What is local is only what the Person is in the middle of: what they have
 * typed, and whether it is on its way.
 */
export function Home() {
  // The name this Person or their Company gave Vivid, live.
  const vivid = useAppearance()
  const me = useMe()
  const data = useLiveData()
  const threads = useLive(data.live.threads)
  const origin = useAnimatedRef<Animated.View>()
  const start = useStart()
  const showing = homeShows(useArrival(), threads)
  const working =
    LiveState.$is('Ready')(threads) &&
    threads.value.threads.some((thread) => thread.attention === 'Working')
  // While a first message is on its way Vivid is thinking about what is on this screen, so the
  // capsule says so and the orb rises to it from the composer. Work in some other Thread is not
  // this screen's: it shows only in the mood of Vivid's face.
  const elsewhere = working || Showing.$is('Waiting')(showing) ? 'thinking' : 'happy'
  return (
    <AboveKeyboardBelowBar>
      <VividBar
        stand={start.sending ? Stand.Thinking() : Stand.Resting({ mood: elsewhere })}
        origin={origin}
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
 * Where this session's first arrival stands, read as Home listens to it. Listening is also how
 * the arrival reaches the stack: it is told whether Home is in front, how to open a Thread over
 * it, and when Home comes back or has been covered, all from this screen's own navigator. So the
 * server is asked from the Thread list and Home's focus, never from Home having rendered.
 */
function useArrival() {
  const arrival = arrivalOf(useLiveData())
  const go = useGo()
  const attend = useCallback(
    (watcher: () => void) => {
      const home: HomeScreen = {
        isFocused: () => go.isFocused(),
        open: (id) => go.navigate('Chat', { id }),
        onFocus: (heard) => go.addListener('focus', heard),
        // The stack says a screen's transition ended and whether it was the one going away;
        // for Home that is the Thread having finished sliding over it.
        onCovered: (heard) =>
          go.addListener('transitionEnd', (event) => {
            if (event.data.closing) heard()
          }),
      }
      return arrival.attend(home, watcher)
    },
    [arrival, go],
  )
  return useSyncExternalStore(attend, arrival.standing)
}

/** What `Writing` needs: who is writing, their words and the send, and the composer's button. */
interface WritingProps {
  me: ReturnType<typeof useMe>
  start: ReturnType<typeof useStart>
  origin: Origin
  placeholder: string
}

/**
 * What Home draws under its bar (`homeShows`): nothing yet, Vivid's face while a first Thread is
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
 * Home for someone Vivid has met: the greeting, anything the last send was refused for, and the
 * composer. The words and the send are Home's (`useStart`), because the capsule at the top thinks
 * while a first message is on its way.
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
        ref={homeComposer}
        origin={origin}
        value={start.draft}
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
 * Starting a Thread from the composer at the bottom of Home.
 *
 * The Person is taken to the Thread only once their message is with Vivid, so words they typed
 * are never dropped on the way to a screen that could not say so. If the Thread was made and the
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
  const go = useGo()
  const place = draftPlace(me.person.id, {
    workspace: workspaceKey(me.workspace),
    thread: Option.none(),
  })
  const typed = useDraft(place)
  const scoped = useScope()
  const setDraft = (text: string) => draft.keep(place, text)
  const [sending, setSending] = useState(false)
  const [last, setLast] = useState<Option.Option<Start>>(Option.none())

  /** The empty Thread an earlier attempt left behind, when there is one. */
  const resume = Option.flatMap(last, (outcome) =>
    Start.$is('NotSaid')(outcome) ? Option.some(outcome.id) : Option.none<ThreadId>(),
  )

  async function send() {
    const message = typed.trim()
    if (message.length === 0 || sending) return
    setSending(true)
    // A Thread started while the drawer is scoped to a Project is filed in that Project.
    const projectId = Option.getOrNull(Option.map(scoped, (project) => project.id))
    const outcome = await startThread(data, { message, projectId, resume })
    setSending(false)
    if (Start.$is('Started')(outcome)) {
      // Only the words that were sent leave the composer. It stays usable while the send is on
      // its way, so by now it can hold a second request; emptying it whatever it held used to
      // throw that away. Anything else is still the Person's and is here when they come back.
      if (draft.in(place).trim() === message) setDraft('')
      setLast(Option.none())
      go.navigate('Chat', { id: outcome.id })
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
