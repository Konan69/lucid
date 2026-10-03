import {
  ShareThreadRequest,
  ThreadAudience,
  type Member,
  type PersonId,
  type Thread,
} from '@vivid/contracts'
import { Option, Result } from 'effect'
import { useState } from 'react'
import { View } from 'react-native'
import { Building2, Check, Lock, Users, type LucideIcon } from 'lucide-react-native'
import { confirm, tick } from '../../data/haptics'
import { useLiveData, useLiveValue } from '../../data/live'
import { useTheme } from '../../theme'
import { Avatar } from '../../ui/Avatar'
import { Sheet } from '../../ui/Sheet'
import { Button, HAIRLINE, Label, Notice, Press, radius } from '../../ui/ui'

/** How far a Thread reaches, as the three choices the sheet offers. */
type Reach = ThreadAudience['_tag']

/** The audience a reach and a set of chosen People make. A new reach fails to compile here. */
const audienceFor = (reach: Reach, chosen: ReadonlyArray<PersonId>): ShareThreadRequest =>
  ({
    Private: () => ShareThreadRequest.cases.Private.make({}),
    People: () => ShareThreadRequest.cases.People.make({ participants: chosen }),
    Company: () => ShareThreadRequest.cases.Company.make({}),
  })[reach]()

/**
 * Who a Thread is shared with. Three choices, said plainly: only its creator, named people, or
 * the whole Company. Sharing never widens what Vivid may do for anyone: in a shared Thread it
 * still acts for whoever is asking, with only what that Person may use.
 */
export function Share({
  thread,
  company,
  me,
  onClose,
}: {
  thread: Thread
  company: string
  me: PersonId
  onClose: () => void
}) {
  const data = useLiveData()
  const people = useLiveValue(data.live.people)
  const [reach, setReach] = useState<Reach>(thread.audience._tag)
  const [chosen, setChosen] = useState<ReadonlyArray<PersonId>>(
    ThreadAudience.guards.People(thread.audience)
      ? thread.audience.participants.map((person) => person.id)
      : [],
  )
  const [saving, setSaving] = useState(false)
  const [refused, setRefused] = useState(false)
  const others = Option.match(people, {
    onNone: (): ReadonlyArray<Member> => [],
    onSome: (value) => value.members.filter((member) => member.person.id !== me),
  })

  async function save() {
    setSaving(true)
    const audience = audienceFor(reach, chosen)
    const result = await data.change((client) => client.ShareThread({ id: thread.id, audience }))
    setSaving(false)
    setRefused(Result.isFailure(result))
    if (Result.isFailure(result)) return
    confirm()
    onClose()
  }

  const toggle = (id: PersonId) => {
    tick()
    setChosen((current) =>
      current.includes(id) ? current.filter((person) => person !== id) : [...current, id],
    )
  }
  const choose = (next: Reach) => {
    tick()
    setReach(next)
  }

  return (
    <Sheet
      title="Share this thread"
      detail="People you share with can read it and write in it. Vivid answers each person as themselves."
      onClose={onClose}
    >
      <View accessibilityRole="radiogroup" style={{ gap: 8 }}>
        <Choice
          icon={Lock}
          title="Only me"
          detail="Nobody else can see this thread."
          selected={reach === 'Private'}
          onSelect={() => choose('Private')}
        />
        <Choice
          icon={Users}
          title="People I choose"
          detail="Pick who else is in this thread."
          selected={reach === 'People'}
          onSelect={() => choose('People')}
        />
        {reach === 'People' && (
          <Picker company={company} members={others} chosen={chosen} onToggle={toggle} />
        )}
        <Choice
          icon={Building2}
          title={`Everyone in ${company}`}
          detail="Every member can find and join this thread."
          selected={reach === 'Company'}
          onSelect={() => choose('Company')}
        />
      </View>
      {refused && <Notice message="That could not be saved. Try again." />}
      <Button
        kind="primary"
        label={saving ? 'Saving…' : 'Save'}
        disabled={saving || (reach === 'People' && chosen.length === 0)}
        onPress={() => void save()}
      />
    </Sheet>
  )
}

/** One of the three reaches. The chosen one is outlined in the accent and filled softly. */
function Choice({
  icon: Icon,
  title,
  detail,
  selected,
  onSelect,
}: {
  icon: LucideIcon
  title: string
  detail: string
  selected: boolean
  onSelect: () => void
}) {
  const { colors: c } = useTheme()
  const fill = selected ? c['thread-selected'] : c.subtle
  return (
    <Press
      accessibilityRole="radio"
      accessibilityState={{ selected }}
      onPress={onSelect}
      style={({ pressed }) => ({
        minHeight: 60,
        paddingHorizontal: 14,
        paddingVertical: 10,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        borderRadius: radius.control,
        // A selected choice's border is its state, so it is a full point and not a hairline.
        borderWidth: selected ? 1 : HAIRLINE,
        borderColor: selected ? c.primary : c.border,
        backgroundColor: pressed && !selected ? c['wash-pressed'] : fill,
      })}
    >
      <Icon
        pointerEvents="none"
        size={19}
        strokeWidth={1.7}
        color={selected ? c['primary-text'] : c['foreground-secondary']}
      />
      <View style={{ flex: 1, minWidth: 0 }}>
        <Label size="footnote">{title}</Label>
        <Label size="label" tone="ink-2">
          {detail}
        </Label>
      </View>
    </Press>
  )
}

/** The Members of the Company, each a checkbox. */
function Picker({
  company,
  members,
  chosen,
  onToggle,
}: {
  company: string
  members: ReadonlyArray<Member>
  chosen: ReadonlyArray<PersonId>
  onToggle: (id: PersonId) => void
}) {
  const { colors: c } = useTheme()
  if (members.length === 0) {
    return (
      <Label size="label" tone="ink-2" style={{ paddingHorizontal: 14, paddingVertical: 6 }}>
        Nobody else is in {company} yet. Invite people in Settings.
      </Label>
    )
  }
  return (
    <View style={{ marginLeft: 12 }}>
      {members.map((member) => {
        const picked = chosen.includes(member.person.id)
        return (
          <Press
            key={member.person.id}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: picked }}
            onPress={() => onToggle(member.person.id)}
            style={({ pressed }) => ({
              minHeight: 48,
              paddingHorizontal: 10,
              flexDirection: 'row',
              alignItems: 'center',
              gap: 12,
              borderRadius: radius.row,
              backgroundColor: pressed ? c['wash-pressed'] : 'transparent',
            })}
          >
            <Avatar name={member.person.name} image={member.person.image} size={26} />
            <Label numberOfLines={1} style={{ flex: 1 }}>
              {member.person.name}
            </Label>
            <View
              style={{
                width: 22,
                height: 22,
                alignItems: 'center',
                justifyContent: 'center',
                borderRadius: 7,
                borderWidth: picked ? 0 : 1,
                borderColor: c.border,
                backgroundColor: picked ? c.primary : 'transparent',
              }}
            >
              {picked && <Check size={14} strokeWidth={2.6} color={c['primary-foreground']} />}
            </View>
          </Press>
        )
      })}
    </View>
  )
}
