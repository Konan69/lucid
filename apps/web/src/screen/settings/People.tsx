import {
  Workspace,
  type Invitation,
  type MeResponse,
  type Member,
  type PeopleResponse,
  type Role,
} from '@vivid/contracts'
import { Result } from 'effect'
import { Building2, UserPlus } from 'lucide-react'
import { useState } from 'react'
import { change, live, LiveState, useLive } from '../../data/live'
import { Route, router } from '../../data/route'
import { Avatar } from '../../ui/Avatar'
import { Button } from '../../ui/Button'
import { Copy } from '../../ui/Copy'
import { Dialog, DialogActions, DialogField } from '../../ui/Dialog'
import { Segmented } from '../../ui/Segmented'
import { CreateCompany } from '../sidebar/Company'
import { Awaiting, Empty, Refusal, Row, Section } from './Parts'

const ROLE_NAME = { owner: 'Owner', admin: 'Admin', member: 'Member' } satisfies Record<
  Role,
  string
>
const ROLES = [
  { value: 'member', label: 'Member', name: 'Member' },
  { value: 'admin', label: 'Admin', name: 'Admin' },
] as const

const manages = (role: Role) => role === 'owner' || role === 'admin'

/**
 * Who is in the Company. Admins invite people, change roles and remove people; everyone sees who
 * their colleagues are. In a personal space there is nobody to list, so the section says what a
 * Company is for and offers to create one, which is the only way one comes to exist.
 */
export function People({ me }: { me: MeResponse }) {
  const people = useLive(live.people)
  if (!Workspace.guards.Company(me.workspace)) return <NoCompany />
  if (!LiveState.$is('Ready')(people)) return <Awaiting state={people} />
  return (
    <CompanyPeople
      me={me}
      company={me.workspace.company.name}
      role={me.workspace.role}
      people={people.value}
    />
  )
}

/**
 * Said to a Person working alone: what a Company gives, and the way to make one here. This is one
 * of the two places a Company is created; the other is the workspace switcher.
 */
function NoCompany() {
  const [creating, setCreating] = useState(false)
  return (
    <Section title="People">
      <div className="flex flex-col items-center gap-3 px-6 py-10 text-center">
        <Building2 className="size-6 text-ink-3" strokeWidth={1.5} />
        <p className="max-w-sm text-label text-pretty text-ink-3">
          You are working in your own space. A company gives the people you work with shared
          threads, a shared Library and shared rules. Everything you have here stays yours.
        </p>
        <Button onClick={() => setCreating(true)}>Create a company</Button>
      </div>
      {creating && <CreateCompany onClose={() => setCreating(false)} />}
    </Section>
  )
}

function CompanyPeople({
  me,
  company,
  role,
  people,
}: {
  me: MeResponse
  company: string
  role: Role
  people: PeopleResponse
}) {
  const [inviting, setInviting] = useState(false)
  const [refusal, setRefusal] = useState<string | null>(null)
  const admin = manages(role)

  async function attempt(action: Parameters<typeof change>[0], failed: string) {
    const result = await change(action)
    setRefusal(Result.isFailure(result) ? failed : null)
    return Result.isSuccess(result)
  }

  return (
    <>
      <Refusal message={refusal} />
      <Section
        title={`People in ${company}`}
        detail="Members see shared threads, the company library and shared connections."
        action={
          admin ? (
            <Button
              size="sm"
              variant="primary"
              icon={<UserPlus className="size-3.5" />}
              onClick={() => setInviting(true)}
            >
              Invite
            </Button>
          ) : undefined
        }
      >
        {people.members.map((member) => (
          <MemberRow
            key={member.membershipId}
            member={member}
            mine={member.person.id === me.person.id}
            admin={admin}
            onRole={(next) =>
              void attempt(
                (client) => client.ChangeRole({ membershipId: member.membershipId, role: next }),
                'That role could not be changed.',
              )
            }
            onRemove={() =>
              void attempt(
                (client) => client.RemoveMember({ membershipId: member.membershipId }),
                'That person could not be removed.',
              )
            }
          />
        ))}
      </Section>

      {admin && (
        <Section
          title="Invitations"
          detail="Open offers to join. Each link works once, for its address."
        >
          {people.invitations.length === 0 && <Empty>No open invitations.</Empty>}
          {people.invitations.map((invitation) => (
            <InvitationRow
              key={invitation.id}
              invitation={invitation}
              onRevoke={() =>
                void attempt(
                  (client) => client.RevokeInvitation({ id: invitation.id }),
                  'That invitation could not be withdrawn.',
                )
              }
            />
          ))}
        </Section>
      )}

      {role !== 'owner' && (
        <Section title="Leave">
          <Row label={`Leave ${company}`} detail="You keep everything in your own space.">
            <Button
              onClick={() =>
                void attempt(
                  (client) => client.LeaveCompany(),
                  'You could not leave just now.',
                ).then((left) => {
                  if (left) router.go(Route.New())
                })
              }
            >
              Leave
            </Button>
          </Row>
        </Section>
      )}

      {inviting && <Invite company={company} onClose={() => setInviting(false)} />}
    </>
  )
}

function MemberRow({
  member,
  mine,
  admin,
  onRole,
  onRemove,
}: {
  member: Member
  mine: boolean
  admin: boolean
  onRole: (role: 'admin' | 'member') => void
  onRemove: () => void
}) {
  // An owner's standing is not changed here, and nobody edits their own row.
  const role = member.role
  return (
    <div className="flex min-h-14 items-center gap-3 px-4 py-2.5">
      <Avatar name={member.person.name} image={member.person.image} size={28} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-label text-ink">
          {member.person.name}
          {mine && <span className="text-ink-3"> · you</span>}
        </div>
        <div className="truncate text-label text-ink-3">{member.email}</div>
      </div>
      {admin && !mine && role !== 'owner' ? (
        <>
          <Segmented label="Role" value={role} options={ROLES} onChange={onRole} />
          <Button size="sm" variant="ghost" onClick={onRemove}>
            Remove
          </Button>
        </>
      ) : (
        <span className="text-label text-ink-3">{ROLE_NAME[role]}</span>
      )}
    </div>
  )
}

const invitationLink = (invitation: Invitation) =>
  `${location.origin}/invite/${encodeURIComponent(invitation.id)}`

function InvitationRow({ invitation, onRevoke }: { invitation: Invitation; onRevoke: () => void }) {
  return (
    <Row
      label={invitation.email}
      detail={`${ROLE_NAME[invitation.role]} · invited by ${invitation.invitedBy.name}`}
    >
      <Copy name="invitation link" read={() => invitationLink(invitation)} />
      <Button size="sm" variant="ghost" onClick={onRevoke}>
        Withdraw
      </Button>
    </Row>
  )
}

function Invite({ company, onClose }: { company: string; onClose: () => void }) {
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<'admin' | 'member'>('member')
  const [sent, setSent] = useState<Invitation | null>(null)
  const [refusal, setRefusal] = useState<string | null>(null)

  async function invite() {
    const result = await change((client) => client.InviteMember({ email: email.trim(), role }))
    if (Result.isFailure(result)) {
      setRefusal('That invitation could not be made. They may already be a member.')
      return
    }
    setSent(result.success)
  }

  if (sent !== null) {
    return (
      <Dialog
        title="Send them this link"
        description={`It lets ${sent.email} join ${company}. It works once and runs out in a week.`}
        width="md"
        onClose={onClose}
      >
        <div className="flex items-center gap-2 rounded-control bg-well px-3 py-2">
          <code className="min-w-0 flex-1 truncate font-mono text-label text-ink-2">
            {invitationLink(sent)}
          </code>
          <Copy name="invitation link" read={() => invitationLink(sent)} />
        </div>
        <DialogActions>
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        </DialogActions>
      </Dialog>
    )
  }

  return (
    <Dialog
      title={`Invite someone to ${company}`}
      description="They join with their own account. Their private threads and notes stay theirs."
      width="md"
      onClose={onClose}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault()
          void invite()
        }}
      >
        <DialogField
          label="Their email"
          value={email}
          onChange={setEmail}
          placeholder="name@company.com"
        />
        <div className="mt-3 flex items-center gap-3">
          <span className="text-label text-ink-2">Role</span>
          <Segmented label="Role" value={role} options={ROLES} onChange={setRole} />
          <span className="text-label text-ink-3">
            {role === 'admin'
              ? 'Can invite people and set company rules.'
              : 'Works with what admins set up.'}
          </span>
        </div>
        {refusal !== null && (
          <p role="alert" className="mt-3 text-label text-danger">
            {refusal}
          </p>
        )}
        <DialogActions>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={!email.includes('@')}>
            Create invitation
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  )
}
