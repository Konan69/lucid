import type { AuditEntry } from '@vivid/contracts'
import { ScrollText } from 'lucide-react-native'
import { FlatList, ScrollView, View } from 'react-native'
import { useNow } from '../../data/foreground'
import { useLive, useLiveData } from '../../data/live'
import { auditSentence } from '../../data/record'
import { when } from '../../data/when'
import { useTheme } from '../../theme'
import { Avatar } from '../../ui/Avatar'
import { Live } from '../../ui/Live'
import { Sheet } from '../../ui/Sheet'
import { Empty, GUTTER, HAIRLINE, Label, Skeleton, TARGET } from '../../ui/ui'

/** The actor's picture beside a line, and the room between it and the words. */
const FACE = 32
const FACE_GAP = 12

/**
 * The record of what was done, and by whom, as a sheet over Settings: every action Vivid took for
 * someone, every Integration, rule and membership change. In a Company an admin reads the whole
 * Company's record and a member reads their own. It names actions and services, never the
 * contents of a Thread, an email or a file.
 *
 * The same live list and the same words as the web's Record (`apps/web/src/screen/settings/
 * Record.tsx`), which the phone used to open in the browser. Here it is one long list under the
 * sheet's own line of explanation, because a record is read by scrolling and a phone has no room
 * for the web's titled panel around it. The list is the sheet's one scroller and recycles its
 * rows, so a long record costs what is on screen and no more.
 *
 * Nothing in it can be pressed: the record cannot be edited, and it says so.
 */
export function Record({ onClose }: { onClose: () => void }) {
  const data = useLiveData()
  const audit = useLive(data.live.audit)
  return (
    <Sheet
      title="Record"
      detail="Newest first. This record cannot be edited."
      content="fill"
      onClose={onClose}
    >
      {/* The sheet sets its detail and this list in one column with no gap of its own. */}
      <View style={{ flex: 1, paddingTop: 16 }}>
        <Live state={audit} loading={<Skeleton rows={5} />}>
          {(value) =>
            value.entries.length === 0 ? (
              // A scroller of its own: the sheet gives this branch no other, and on a phone held
              // sideways with large text the words would otherwise run off the sheet's foot.
              <ScrollView>
                <Empty
                  icon={ScrollText}
                  title="Nothing recorded yet"
                  line="What Vivid does for you is written here as it happens."
                  // The sheet is the whole screen, so it is centred as a page's is.
                  room="page"
                />
              </ScrollView>
            ) : (
              <Lines entries={value.entries} />
            )
          }
        </Live>
      </View>
    </Sheet>
  )
}

/** A line between two entries, starting where the words start, as a Section's rows are ruled. */
function Divider() {
  const { colors: c } = useTheme()
  return (
    <View style={{ height: HAIRLINE, marginLeft: FACE + FACE_GAP, backgroundColor: c.separator }} />
  )
}

/**
 * Every entry, newest first, as the server sent them. The list reaches the sheet's edges so its
 * scroll indicator sits at the edge of the glass, and its rows keep the sheet's gutter.
 */
function Lines({ entries }: { entries: ReadonlyArray<AuditEntry> }) {
  // The moment the app last came to the front: "Yesterday" does not change under a finger.
  const now = useNow()
  return (
    <FlatList
      data={entries}
      keyExtractor={(entry) => entry.id}
      style={{ marginHorizontal: -GUTTER }}
      contentContainerStyle={{ paddingHorizontal: GUTTER, paddingBottom: 32 }}
      ItemSeparatorComponent={Divider}
      renderItem={({ item }) => <Line entry={item} now={now} />}
    />
  )
}

/**
 * One thing that happened: who it is about, what was done, then who did it and when. "Vivid, for
 * Ada" is Vivid acting on Ada's behalf; a bare name is the Person doing it themselves.
 *
 * The time is the app's own short form (`data/when.ts`): the phone's engine has no relative-time
 * formatter to ask. The whole line is read out as one sentence, since it is one fact.
 */
function Line({ entry, now }: { entry: AuditEntry; now: number }) {
  const sentence = auditSentence(entry.event)
  const who = entry.by === 'vivid' ? `Vivid, for ${entry.actor.name}` : entry.actor.name
  const at = when(entry.at, now)
  return (
    <View
      accessible
      accessibilityLabel={`${sentence}. ${who}, ${at}`}
      style={{
        minHeight: TARGET + 8,
        paddingVertical: 10,
        flexDirection: 'row',
        alignItems: 'center',
        gap: FACE_GAP,
      }}
    >
      <Avatar name={entry.actor.name} image={entry.actor.image} size={FACE} />
      <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
        <Label>{sentence}</Label>
        <Label size="label" tone="ink-2">
          {who} · {at}
        </Label>
      </View>
    </View>
  )
}
