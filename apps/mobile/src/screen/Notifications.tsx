import { useAtomValue } from '@effect/atom-react'
import type { Approval, InvitationId, NotificationId, ThreadId } from '@vivid/contracts'
import { everyNoticeRead, noticeRows, noticesRead, type NotificationList } from '@vivid/state'
import { Option } from 'effect'
import { useState } from 'react'
import { FlatList, Pressable, ScrollView, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Bell, CheckCheck } from 'lucide-react-native'
import { useWaitingApprovals } from '../data/approvals'
import { useNow } from '../data/foreground'
import { commit } from '../data/haptics'
import { LiveState, useLive, useLiveData, useLiveValue, type LiveData } from '../data/live'
import { useTheme } from '../theme'
import { Bar } from '../ui/Bar'
import { Screen } from '../ui/Screen'
import { EDGE, Empty, GUTTER, Label, Notice, styles } from '../ui/ui'
import { useOpenThread } from '../workspace'
import { Decide } from './feed/Decide'
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
  // What waits on the Person's yes is decided at the head of the list (#129), so a list with no
  // notices still has something to show while one waits.
  const asks = useWaitingApprovals()
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
  return state.value.notifications.length === 0 && asks.length === 0 ? (
    <Quiet />
  ) : (
    <Listed list={state.value} asks={asks} />
  )
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
 * is nothing. The words are the web panel's, set as every empty place of the app is (`ui/ui.tsx`
 * `Empty`): the place's mark, what is so, and one line. There is nothing to press, because
 * nothing here is made by the Person.
 */
function Quiet() {
  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={[styles.page, styles.column]}
    >
      <Empty
        icon={Bell}
        title="You’re all caught up"
        line="New notifications from Vivid appear here."
        room="page"
      />
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
function Listed({
  list,
  asks,
}: {
  list: NotificationList
  /** The Approvals waiting on the Person, decided above the notices (`Waiting`). */
  asks: ReadonlyArray<Approval>
}) {
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
        ListHeaderComponent={
          asks.length > 0 ? (
            <Waiting
              asks={asks}
              titleOf={(id) =>
                Option.match(threads, {
                  onNone: () => Option.none<string>(),
                  onSome: (answer) =>
                    Option.fromUndefinedOr(answer.threads.find((thread) => thread.id === id)).pipe(
                      Option.map((thread) => thread.title.trim()),
                      Option.filter((title) => title !== ''),
                    ),
                })
              }
              onOpen={openThread}
            />
          ) : null
        }
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

/**
 * What waits on the Person's yes, at the head of the list: each Approval in a card of its own,
 * under the title of the Thread it was asked in (which opens it), decided there (`Decide`), a
 * send as its draft. The web's panel shows the same (`Asked`, `apps/web/src/screen/Notifications.tsx`).
 */
function Waiting({
  asks,
  titleOf,
  onOpen,
}: {
  asks: ReadonlyArray<Approval>
  /** The Thread's title, once the Thread list has answered and when it has one. */
  titleOf: (id: ThreadId) => Option.Option<string>
  onOpen: (id: ThreadId) => void
}) {
  const { colors: c } = useTheme()
  return (
    <View style={{ paddingHorizontal: GUTTER, paddingTop: 12, gap: 12 }}>
      <Label accessibilityRole="header" size="label" tone="ink-2" style={{ fontWeight: '600' }}>
        Waiting on you
      </Label>
      {asks.map((approval) => (
        <View
          key={approval.id}
          style={{
            borderRadius: 24,
            borderCurve: 'continuous',
            borderWidth: EDGE,
            borderColor: c['line-2'],
            backgroundColor: c.card,
            padding: 16,
          }}
        >
          <Pressable
            accessibilityRole="link"
            accessibilityHint="Opens the conversation"
            onPress={() => onOpen(approval.threadId)}
            hitSlop={8}
            style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
          >
            <Label size="label" tone="ink-2" numberOfLines={1} style={{ fontWeight: '600' }}>
              {Option.getOrElse(titleOf(approval.threadId), () => 'Open its Thread')}
            </Label>
          </Pressable>
          <Decide approval={approval} />
        </View>
      ))}
    </View>
  )
}
