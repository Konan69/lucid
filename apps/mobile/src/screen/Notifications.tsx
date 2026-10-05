import { useAtomValue } from '@effect/atom-react'
import type { InvitationId, NotificationId } from '@vivid/contracts'
import { everyNoticeRead, noticeRows, noticesRead, type NotificationList } from '@vivid/state'
import { Option } from 'effect'
import { useState } from 'react'
import { FlatList, ScrollView, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Bell, CheckCheck } from 'lucide-react-native'
import { useNow } from '../data/foreground'
import { commit } from '../data/haptics'
import { LiveState, useLive, useLiveData, useLiveValue, type LiveData } from '../data/live'
import { useTheme } from '../theme'
import { Bar } from '../ui/Bar'
import { Screen } from '../ui/Screen'
import { GUTTER, Label, Notice, radius, styles } from '../ui/ui'
import { useOpenThread } from '../workspace'
import { Destination } from './notifications/destination'
import { Invitation } from './notifications/Invitation'
import { Item, itemKey, itemsOf } from './notifications/list'
import { NoticeLine, NoticeOutline } from './notifications/Row'

/**
 * Notifications: what finished or needs the Person while they were somewhere else.
 *
 * It is a screen on the app's one stack, pushed from the drawer and left by the system's back
 * swipe, under the system's bar every screen has (`ui/Bar.tsx`); the web hangs a panel from a
 * bell, and a phone has no corner to hang one from. What is listed, in what order and in what words is the
 * web's, from the same shared model (`@vivid/state` `notices.ts`). How it is drawn is the
 * phone's: an inbox under day headings, like the Thread list, with "Mark all read" where a
 * screen's one action goes, at the trailing end of the bar.
 *
 * It owns no data. The list is the live query, which starts from what the phone kept
 * (`data/snapshot.ts`): on a cold start the kept list is drawn at once, with no outline and no
 * spinner over it, and corrected when the server answers. A press is shown at once and taken
 * back if the server refuses it.
 *
 * Nothing here is pulled to refresh or swiped: no other screen of the app refreshes by hand
 * (every list is live), and the only swipe in the app files a Thread.
 */
export function Notifications() {
  const data = useLiveData()
  const state = useLive(data.live.notifications)
  // What is unread is the server's count of everything, which can be more than the notices
  // listed: "Mark all read" stays offered while anything, listed or not, is unread.
  const unread = LiveState.$is('Ready')(state) ? state.value.unreadCount : 0
  return (
    <Screen>
      <Bar
        title="Notifications"
        actions={[
          {
            symbol: 'checkmark.circle',
            icon: CheckCheck,
            label: 'Mark all read',
            disabled: unread === 0,
            onPress: () => readAll(data),
          },
        ]}
      />
      <Body state={state} />
    </Screen>
  )
}

/**
 * What is under the bar, one drawing for each state of the live query so none can be mistaken
 * for another: the list's outline only when the phone kept nothing to draw (a kept list is
 * `Ready` from the first frame), the server's own sentence when the list cannot be read at all
 * (a live query fails only for good; a dropped connection keeps the last list on screen), and
 * otherwise the list, or the sentence that says there is nothing in it.
 *
 * Every one of them is a scroller, the short ones included: under a glass bar the system keeps a
 * scroller's content clear of the bar (`contentInsetAdjustmentBehavior`), and a plain view would
 * start beneath it (`ui/Bar.tsx`).
 */
function Body({ state }: { state: LiveState<NotificationList> }) {
  if (LiveState.$is('Loading')(state)) {
    return (
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={[styles.column, { paddingTop: 4 }]}
      >
        <NoticeOutline />
      </ScrollView>
    )
  }
  if (LiveState.$is('Failed')(state)) {
    return (
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={[styles.page, styles.column]}
      >
        <Notice message={state.failure.message} />
      </ScrollView>
    )
  }
  return state.value.notifications.length === 0 ? <Quiet /> : <Listed list={state.value} />
}

/** Shows these notices as read at once, sends that, and takes it back if the server refuses. */
function read(data: LiveData, ids: ReadonlyArray<NotificationId>) {
  // Nothing unread is nothing to send; a request with no ids would also not mean "none".
  if (ids.length === 0) return
  const at = Date.now()
  void data.change(
    (client) => client.ReadNotifications({ ids }),
    () => data.live.notifications.expect(noticesRead(ids, at)),
  )
}

/** Marks every notice read, shown at once the same way, and felt as the press that did it. */
function readAll(data: LiveData) {
  commit()
  const at = Date.now()
  void data.change(
    (client) => client.ReadNotifications({}),
    () => data.live.notifications.expect(everyNoticeRead(at)),
  )
}

/**
 * Nothing to list, said once the server (or what the phone kept of it) has answered that there
 * is nothing. The words are the web panel's. It is set where every empty screen of the app sets
 * its sentence, at the top of the page on the gutter, under the mark of the place; Vivid's face
 * is not drawn, because an empty list is not Vivid speaking (`ui/ui.tsx` `Empty`).
 */
function Quiet() {
  const { colors: c } = useTheme()
  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={[styles.page, styles.column, { paddingTop: 24, gap: 14 }]}
    >
      <View
        pointerEvents="none"
        style={{
          width: 44,
          height: 44,
          alignItems: 'center',
          justifyContent: 'center',
          borderRadius: radius.control,
          borderCurve: 'continuous',
          backgroundColor: c['wash-hover'],
        }}
      >
        <Bell size={21} strokeWidth={1.7} color={c['ink-3']} />
      </View>
      <View style={{ gap: 4 }}>
        <Label accessibilityRole="header" size="headline">
          You’re all caught up
        </Label>
        <Label tone="ink-2" style={{ maxWidth: 340 }}>
          Vivid will tell you here.
        </Label>
      </View>
    </ScrollView>
  )
}

/** A day band's heading, in the place and the type a Section's title is set (`ui/List.tsx`). */
function Caption({ label }: { label: string }) {
  return (
    <Label
      accessibilityRole="header"
      size="label"
      tone="ink-2"
      style={{ fontWeight: '600', paddingHorizontal: GUTTER, paddingTop: 18, paddingBottom: 4 }}
    >
      {label}
    </Label>
  )
}

/**
 * The list itself: a row for each place to go, newest first, under the day it happened.
 *
 * It holds the one thing that opens over it: the invitation a row is about, as a sheet
 * (`notifications/Invitation.tsx`). An invitation used to be handed to the phone's browser; the
 * server answers it over the app's own connection, so it is read and accepted here.
 */
function Listed({ list }: { list: NotificationList }) {
  const data = useLiveData()
  const openThread = useOpenThread()
  const insets = useSafeAreaInsets()
  const threads = useLiveValue(data.live.threads)
  // The Threads the server has said are not there for this Person; nothing else makes a row
  // read as unavailable (`destinationOf`).
  const gone = useAtomValue(data.gone)
  // The moment the app last came to the front: times do not tick under a finger.
  const now = useNow()
  // The invitation whose sheet is open over the list, if one is.
  const [invited, setInvited] = useState<Option.Option<InvitationId>>(Option.none())

  /** Goes to what a row is about, marking all of it read on the way. */
  const open = (unread: ReadonlyArray<NotificationId>, leads: Destination) => {
    read(data, unread)
    Destination.$match(leads, {
      Thread: ({ id }) => openThread(id),
      // Read and answered in a sheet over this list; nothing leaves the app.
      Invitation: ({ id }) => setInvited(Option.some(id)),
      // Reading it is all a press on these does, and all that is left to do with them.
      Gone: () => undefined,
      Nowhere: () => undefined,
    })
  }

  const items = itemsOf(
    noticeRows(
      list.notifications,
      // Until the Thread list has answered, a row leads with its notice's own title.
      Option.match(threads, { onNone: () => [], onSome: (answer) => answer.threads }),
    ),
    gone,
    now,
  )

  return (
    <>
      <FlatList
        data={items}
        keyExtractor={itemKey}
        contentInsetAdjustmentBehavior="automatic"
        renderItem={({ item }) =>
          Item.$match(item, {
            Heading: ({ label }) => <Caption label={label} />,
            Entry: ({ face, leads, unread }) => (
              <NoticeLine face={face} leads={leads} now={now} onPress={() => open(unread, leads)} />
            ),
          })
        }
        contentContainerStyle={[styles.column, { paddingBottom: insets.bottom + 24 }]}
      />
      {/* Keyed by the invitation: a second one is asked about afresh, never shown as the first. */}
      {Option.isSome(invited) && (
        <Invitation
          key={invited.value}
          id={invited.value}
          onClose={() => setInvited(Option.none())}
        />
      )}
    </>
  )
}
