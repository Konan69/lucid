import {
  Workspace,
  type Invitation,
  type Member,
  type PeopleResponse,
  type Role,
} from '@vivid/contracts'
import { Data, Option, Result } from 'effect'
import { useState } from 'react'
import { ScrollView, Share as SystemShare, View } from 'react-native'
import { UserPlus, Users } from 'lucide-react-native'
import { commit, warn } from '../../data/haptics'
import { refusalOf, useLive, useLiveData } from '../../data/live'
import { invitationAddress } from '../../data/server'
import { Avatar } from '../../ui/Avatar'
import { Bar, NO_ACTIONS, type BarAction } from '../../ui/Bar'
import { Screen } from '../../ui/Screen'
import { Row, Section } from '../../ui/List'
import { Live } from '../../ui/Live'
import { Sheet } from '../../ui/Sheet'
import {
  Button,
  confirmDestructive,
  Empty,
  GUTTER,
  Field,
  Label,
  Labelled,
  Notice,
  Segmented,
  Skeleton,
  styles,
} from '../../ui/ui'
import { ROLE_NAME, useGo, useMe } from '../../workspace'

/** The two roles an admin can give. Ownership is not handed over here. */
const ROLES = [
  { value: 'member', label: 'Member' },
  { value: 'admin', label: 'Admin' },
] as const

const manages = (role: Role) => role === 'owner' || role === 'admin'

/** What is open over the list of People. One thing at a time. */
type Over = Data.TaggedEnum<{
  Nothing: {}
  Inviting: {}
  Member: { readonly member: Member }
  Invitation: { readonly invitation: Invitation }
}>
const Over = Data.taggedEnum<Over>()

/**
 * Who is in the Company. Admins invite people, change roles and remove people; everyone sees who
 * their colleagues are. Nobody here reads anyone else's private Threads, whatever their role.
 *
 * The screen is reached only from a Company workspace. If the session leaves the Company while
 * it is open (the Person left, or was removed), it says so instead of listing nobody.
 */
export function People() {
  const me = useMe()
  const data = useLiveData()
  const people = useLive(data.live.people)
  const [over, setOver] = useState<Over>(Over.Nothing())
  if (!Workspace.guards.Company(me.workspace)) {
    return (
      <Screen>
        <Bar title="People" actions={NO_ACTIONS} />
        {/* A scroller, so the system keeps this line clear of a glass bar as it does a list. */}
        <ScrollView
          contentInsetAdjustmentBehavior="automatic"
          contentContainerStyle={{ paddingHorizontal: GUTTER }}
        >
          <Empty
            icon={Users}
            title="Only you are here"
            line="You are working in your own space. Switch to a company to see who is in it."
            room="page"
          />
        </ScrollView>
      </Screen>
    )
  }
  const { company, role } = me.workspace
  const admin = manages(role)
  const invite: BarAction = {
    symbol: 'person.badge.plus',
    icon: UserPlus,
    label: 'Invite someone',
    disabled: false,
    onPress: () => setOver(Over.Inviting()),
  }
  return (
    <Screen>
      <Bar title="People" actions={admin ? [invite] : NO_ACTIONS} />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={[styles.page, styles.column]}
      >
        {/* Whose people these are, as the page's first line. It was the line under the bar's
            title; the system's bar has no such line without a native change (`ui/Bar.tsx`). */}
        <Label size="label" tone="ink-2">
          {company.name}
        </Label>
        <Live state={people} loading={<Skeleton rows={4} />}>
          {(value) => (
            <Listed
              people={value}
              admin={admin}
              owner={role === 'owner'}
              company={company.name}
              onOpen={setOver}
            />
          )}
        </Live>
      </ScrollView>
      {Over.$is('Inviting')(over) && (
        <Invite company={company.name} onClose={() => setOver(Over.Nothing())} />
      )}
      {Over.$is('Member')(over) && (
        <MemberSheet member={over.member} onClose={() => setOver(Over.Nothing())} />
      )}
      {Over.$is('Invitation')(over) && (
        <InvitationSheet invitation={over.invitation} onClose={() => setOver(Over.Nothing())} />
      )}
    </Screen>
  )
}

/** The Members, the open invitations an admin can see, and the way out of the Company. */
function Listed({
  people,
  admin,
  owner,
  company,
  onOpen,
}: {
  people: PeopleResponse
  admin: boolean
  owner: boolean
  company: string
  onOpen: (over: Over) => void
}) {
  const me = useMe()
  const data = useLiveData()
  const go = useGo()
  const [refused, setRefused] = useState<Option.Option<string>>(Option.none())

  const leave = () =>
    confirmDestructive({
      title: `Leave ${company}?`,
      detail: 'You keep everything in your own space. You will need a new invitation to come back.',
      action: 'Leave',
      onConfirm: () => {
        warn()
        void data
          .change((client) => client.LeaveCompany())
          .then((result) => {
            if (Result.isFailure(result)) setRefused(Option.some('You could not leave just now.'))
            else go.popToTop()
          })
      },
    })

  return (
    <>
      {Option.isSome(refused) && <Notice message={refused.value} />}
      <Section
        title={`In ${company}`}
        detail="Members see shared threads, the company library and shared integrations."
      >
        {people.members.map((member) => {
          const mine = member.person.id === me.person.id
          // An owner's standing is not changed here, and nobody edits their own row.
          const editable = admin && !mine && member.role !== 'owner'
          return (
            <Row
              key={member.membershipId}
              leading={<Avatar name={member.person.name} image={member.person.image} size={32} />}
              title={mine ? `${member.person.name} · you` : member.person.name}
              detail={member.email}
              trailing={
                editable ? undefined : (
                  <Label size="label" tone="ink-2">
                    {ROLE_NAME[member.role]}
                  </Label>
                )
              }
              onPress={editable ? () => onOpen(Over.Member({ member })) : undefined}
            />
          )
        })}
      </Section>
      {admin && (
        <Section title="Invitations" detail="Open offers to join. Each link works once.">
          {people.invitations.length === 0 && <Row title="No open invitations" />}
          {people.invitations.map((invitation) => (
            <Row
              key={invitation.id}
              title={invitation.email}
              detail={`${ROLE_NAME[invitation.role]} · invited by ${invitation.invitedBy.name}`}
              onPress={() => onOpen(Over.Invitation({ invitation }))}
            />
          ))}
        </Section>
      )}
      {!owner && (
        <Section title="Leave">
          <Row title={`Leave ${company}`} danger onPress={leave} />
        </Section>
      )}
    </>
  )
}

/** One Member, for an admin: their role, and removing them. */
function MemberSheet({ member, onClose }: { member: Member; onClose: () => void }) {
  const data = useLiveData()
  const [refused, setRefused] = useState<Option.Option<string>>(Option.none())
  // The sheet shows the role it was opened with until the server confirms another.
  const [role, setRole] = useState<'admin' | 'member'>(member.role === 'admin' ? 'admin' : 'member')

  async function change(next: 'admin' | 'member') {
    setRole(next)
    const result = await data.change((client) =>
      client.ChangeRole({ membershipId: member.membershipId, role: next }),
    )
    if (Result.isSuccess(result)) return
    setRole(role)
    setRefused(Option.some('That role could not be changed.'))
  }

  const remove = () =>
    confirmDestructive({
      title: `Remove ${member.person.name}?`,
      detail:
        'They lose the company’s shared threads, library and integrations. Their own space stays theirs.',
      action: 'Remove',
      onConfirm: () => {
        warn()
        void data
          .change((client) => client.RemoveMember({ membershipId: member.membershipId }))
          .then((result) => {
            if (Result.isFailure(result))
              setRefused(Option.some('That person could not be removed.'))
            else onClose()
          })
      },
    })

  return (
    <Sheet title={member.person.name} detail={member.email} onClose={onClose}>
      {Option.isSome(refused) && <Notice message={refused.value} />}
      <Labelled label="Role">
        <Segmented
          label="Role"
          value={role}
          options={ROLES}
          onChange={(next) => void change(next)}
        />
      </Labelled>
      <Label size="label" tone="ink-2">
        {role === 'admin'
          ? 'Can invite people and set company rules.'
          : 'Works with what admins set up.'}
      </Label>
      <Button kind="danger" label="Remove from the company" onPress={remove} />
    </Sheet>
  )
}

/** The link an invited Person opens, and handing it to whatever the Person sends things with. */
function InviteLink({ invitation }: { invitation: Invitation }) {
  const data = useLiveData()
  const link = invitationAddress(data.session.server, invitation.id)
  return (
    <>
      <Label selectable size="label" tone="ink-2">
        {link}
      </Label>
      <Button
        kind="primary"
        label="Send the link"
        onPress={() => void SystemShare.share({ message: link })}
      />
    </>
  )
}

/** An open invitation: its link again, or taking it back. */
function InvitationSheet({ invitation, onClose }: { invitation: Invitation; onClose: () => void }) {
  const data = useLiveData()
  const [refused, setRefused] = useState<Option.Option<string>>(Option.none())

  async function withdraw() {
    warn()
    const result = await data.change((client) => client.RevokeInvitation({ id: invitation.id }))
    if (Result.isFailure(result)) setRefused(Option.some('That invitation could not be withdrawn.'))
    else onClose()
  }

  return (
    <Sheet
      title={invitation.email}
      detail={`${ROLE_NAME[invitation.role]} · invited by ${invitation.invitedBy.name}`}
      onClose={onClose}
    >
      {Option.isSome(refused) && <Notice message={refused.value} />}
      <InviteLink invitation={invitation} />
      <Button kind="danger" label="Withdraw the invitation" onPress={() => void withdraw()} />
    </Sheet>
  )
}

/**
 * Inviting someone: their email and a role. The server makes the invitation; what comes back is
 * a link the Person sends themselves, so the sheet turns into that link once it exists.
 */
function Invite({ company, onClose }: { company: string; onClose: () => void }) {
  const data = useLiveData()
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<'admin' | 'member'>('member')
  const [busy, setBusy] = useState(false)
  const [sent, setSent] = useState<Option.Option<Invitation>>(Option.none())
  const [refused, setRefused] = useState<Option.Option<string>>(Option.none())

  async function invite() {
    setBusy(true)
    const result = await data.change((client) => client.InviteMember({ email: email.trim(), role }))
    setBusy(false)
    setRefused(
      Option.map(
        refusalOf(result),
        () => 'That invitation could not be made. They may already be a member.',
      ),
    )
    if (Result.isFailure(result)) return
    commit()
    setSent(Option.some(result.success))
  }

  if (Option.isSome(sent)) {
    return (
      <Sheet
        title="Send them this link"
        detail={`It lets ${sent.value.email} join ${company}. It works once and runs out in a week.`}
        onClose={onClose}
      >
        <InviteLink invitation={sent.value} />
        <Button label="Done" onPress={onClose} />
      </Sheet>
    )
  }

  return (
    <Sheet
      title={`Invite someone to ${company}`}
      detail="They join with their own account. Their private threads and notes stay theirs."
      onClose={onClose}
    >
      <Labelled label="Their email">
        <Field
          autoFocus
          accessibilityLabel="Their email"
          value={email}
          placeholder="name@company.com"
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="email-address"
          onChangeText={setEmail}
        />
      </Labelled>
      <Labelled label="Role">
        <View style={{ gap: 8 }}>
          <Segmented label="Role" value={role} options={ROLES} onChange={setRole} />
          <Label size="label" tone="ink-2">
            {role === 'admin'
              ? 'Can invite people and set company rules.'
              : 'Works with what admins set up.'}
          </Label>
        </View>
      </Labelled>
      {Option.isSome(refused) && <Notice message={refused.value} />}
      <Button
        kind="primary"
        label={busy ? 'One moment…' : 'Create invitation'}
        disabled={busy || !email.includes('@')}
        onPress={() => void invite()}
      />
    </Sheet>
  )
}
