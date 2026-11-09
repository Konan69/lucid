import {
  Workspace,
  type Invitation,
  type MeResponse,
  type Member,
  type PeopleResponse,
  type Role,
} from '@vivid/contracts'
import { Effect, Result } from 'effect'
import { Building2, UserPlus } from 'lucide-react'
import { useId, useState } from 'react'
import { act } from '../../data/app'
import { changing, live, LiveState, useLive } from '../../data/live'
import { router } from '../../router'
import { PersonAvatar } from '../../ui/Person'
import { Button } from '../../ui/button'
import { Copy } from '../../ui/Copy'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../ui/dialog'
import { Field, FieldError, FieldGroup, FieldLabel } from '../../ui/field'
import { Input } from '../../ui/input'
import { useSurface } from '../../ui/Layer'
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
        <Button variant="outline" onClick={() => setCreating(true)}>
          Create a company
        </Button>
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

  function attempt(action: Parameters<typeof changing>[0], failed: string) {
    return Effect.gen(function* () {
      const result = yield* changing(action)
      setRefusal(Result.isFailure(result) ? failed : null)
      return Result.isSuccess(result)
    })
  }

  return (
    <>
      <Refusal message={refusal} />
      <Section
        title={`People in ${company}`}
        detail="Members see shared threads, the company library and shared connections."
        action={
          admin ? (
            <Button size="sm" onClick={() => setInviting(true)}>
              <UserPlus className="size-3.5" />
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
              void act(
                attempt(
                  (client) => client.ChangeRole({ membershipId: member.membershipId, role: next }),
                  'That role could not be changed.',
                ),
              )
            }
            onRemove={() =>
              void act(
                attempt(
                  (client) => client.RemoveMember({ membershipId: member.membershipId }),
                  'That person could not be removed.',
                ),
              )
            }
          />
        ))}
      </Section>

      {admin && (
        <Section
          title="Invitations"
          detail="Pending invitations. Each link works once, for the email it was sent to."
        >
          {people.invitations.length === 0 && <Empty>No open invitations.</Empty>}
          {people.invitations.map((invitation) => (
            <InvitationRow
              key={invitation.id}
              invitation={invitation}
              onRevoke={() =>
                void act(
                  attempt(
                    (client) => client.RevokeInvitation({ id: invitation.id }),
                    'That invitation could not be withdrawn.',
                  ),
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
              variant="outline"
              onClick={() =>
                void act(
                  attempt(
                    (client) => client.LeaveCompany(),
                    'Couldn’t leave the company. Try again.',
                  ),
                ).then((left) => {
                  if (left) void router.navigate({ to: '/' })
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
      <PersonAvatar name={member.person.name} image={member.person.image} size={28} />
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
  const field = useId()
  // One surface for both steps: the form and the link it makes are the same dialog, so the link
  // replaces the form in place instead of one dialog leaving and another arriving. Sent away
  // (Escape, a click outside, the close button) it plays out before `onClose` is told.
  const surface = useSurface(onClose)

  function invite() {
    return Effect.gen(function* () {
      const result = yield* changing((client) => client.InviteMember({ email: email.trim(), role }))
      if (Result.isFailure(result)) {
        setRefusal('That invitation could not be made. They may already be a member.')
        return
      }
      setSent(result.success)
    })
  }

  if (sent !== null) {
    return (
      <Dialog {...surface}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Send them this link</DialogTitle>
            <DialogDescription>
              {`It lets ${sent.email} join ${company}. It works once and expires in a week.`}
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-center gap-2 rounded-control bg-well px-3 py-2">
            <code className="min-w-0 flex-1 truncate font-mono text-label text-ink-2">
              {invitationLink(sent)}
            </code>
            <Copy name="invitation link" read={() => invitationLink(sent)} />
          </div>
          <DialogFooter>
            <Button onClick={onClose}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    )
  }

  return (
    <Dialog {...surface}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{`Invite someone to ${company}`}</DialogTitle>
          <DialogDescription>
            They join with their own account. Their private threads and notes stay theirs.
          </DialogDescription>
        </DialogHeader>
        {/* `contents`: the fields and the actions take the dialog's own gap, and the submit button
            stays inside the form so Enter in the field makes the invitation. */}
        <form
          className="contents"
          onSubmit={(event) => {
            event.preventDefault()
            void act(invite())
          }}
        >
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor={field}>Their email</FieldLabel>
              <Input
                id={field}
                required
                // A dialog exists to take this one answer; the cursor belongs in it.
                // oxlint-disable-next-line jsx-a11y/no-autofocus
                autoFocus
                maxLength={120}
                value={email}
                onChange={(event) => setEmail(event.currentTarget.value)}
                placeholder="name@company.com"
              />
            </Field>
            <div className="flex items-center gap-3">
              <span className="text-label text-ink-2">Role</span>
              <Segmented label="Role" value={role} options={ROLES} onChange={setRole} />
              <span className="text-label text-ink-3">
                {role === 'admin'
                  ? 'Can invite people and set company rules.'
                  : 'Works with what admins set up.'}
              </span>
            </div>
            {refusal !== null && <FieldError>{refusal}</FieldError>}
          </FieldGroup>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!email.includes('@')}>
              Create invitation
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
