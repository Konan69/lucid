import {
  ShareThreadRequest,
  ThreadAudience,
  type Member,
  type PersonId,
  type Thread,
} from '@vivid/contracts'
import { Option, Result } from 'effect'
import { Building2, Check, Lock, Users } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { change, live, useLiveValue } from '../../data/live'
import { Avatar } from '../../ui/Avatar'
import { Button } from '../../ui/Button'
import { cn } from '../../ui/cn'
import { Dialog, DialogActions } from '../../ui/Dialog'

type Reach = 'private' | 'people' | 'company'

const reachOf = (audience: ThreadAudience): Reach =>
  ThreadAudience.match(audience, {
    Private: (): Reach => 'private',
    People: (): Reach => 'people',
    Company: (): Reach => 'company',
  })

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
  const people = useLiveValue(live.people)
  const [reach, setReach] = useState<Reach>(reachOf(thread.audience))
  const [chosen, setChosen] = useState<ReadonlyArray<PersonId>>(
    ThreadAudience.guards.People(thread.audience)
      ? thread.audience.participants.map((person) => person.id)
      : [],
  )
  const [refusal, setRefusal] = useState<string | null>(null)
  const others = Option.match(people, {
    onNone: (): ReadonlyArray<Member> => [],
    onSome: (value) => value.members.filter((member) => member.person.id !== me),
  })

  async function save() {
    const audience = audienceFor(reach, chosen)
    const result = await change((client) => client.ShareThread({ id: thread.id, audience }))
    if (Result.isFailure(result)) {
      setRefusal('That could not be saved. Try again.')
      return
    }
    onClose()
  }

  const toggle = (id: PersonId) =>
    setChosen((current) =>
      current.includes(id) ? current.filter((person) => person !== id) : [...current, id],
    )

  return (
    <Dialog
      title="Share this thread"
      description="People you share with can read it and write in it. Vivid answers each person as themselves."
      width="md"
      onClose={onClose}
    >
      <div className="flex flex-col gap-1.5">
        <Choice
          icon={<Lock className="size-4" />}
          title="Only me"
          detail="Nobody else can see this thread."
          selected={reach === 'private'}
          onSelect={() => setReach('private')}
        />
        <Choice
          icon={<Users className="size-4" />}
          title="People I choose"
          detail="Pick who else is in this thread."
          selected={reach === 'people'}
          onSelect={() => setReach('people')}
        />
        {reach === 'people' && (
          <PeoplePicker company={company} members={others} chosen={chosen} onToggle={toggle} />
        )}
        <Choice
          icon={<Building2 className="size-4" />}
          title={`Everyone in ${company}`}
          detail="Every member can find and join this thread."
          selected={reach === 'company'}
          onSelect={() => setReach('company')}
        />
      </div>
      {refusal !== null && (
        <p role="alert" className="mt-3 text-label text-danger">
          {refusal}
        </p>
      )}
      <DialogActions>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant="primary"
          disabled={reach === 'people' && chosen.length === 0}
          onClick={() => void save()}
        >
          Save
        </Button>
      </DialogActions>
    </Dialog>
  )
}

/** The audience a reach and a set of chosen People make. */
const audienceFor = (reach: Reach, chosen: ReadonlyArray<PersonId>): ShareThreadRequest =>
  ({
    private: (): ShareThreadRequest => ShareThreadRequest.cases.Private.make({}),
    people: (): ShareThreadRequest =>
      ShareThreadRequest.cases.People.make({ participants: chosen }),
    company: (): ShareThreadRequest => ShareThreadRequest.cases.Company.make({}),
  })[reach]()

/** The Members of the Company, each a checkbox. */
function PeoplePicker({
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
  return (
    <ul className="ml-9 flex max-h-56 flex-col gap-px overflow-y-auto py-1">
      {members.length === 0 && (
        <li className="px-2 py-1.5 text-label text-ink-3">
          Nobody else is in {company} yet. Invite people in Settings.
        </li>
      )}
      {members.map((member) => {
        const picked = chosen.includes(member.person.id)
        return (
          <li key={member.person.id}>
            <button
              type="button"
              role="checkbox"
              aria-checked={picked}
              onClick={() => onToggle(member.person.id)}
              className="flex h-9 w-full cursor-pointer items-center gap-2.5 rounded-row px-2 text-left transition-colors duration-(--dur-fast) hover:bg-wash-hover"
            >
              <Avatar name={member.person.name} image={member.person.image} size={20} />
              <span className="min-w-0 flex-1 truncate text-label text-ink">
                {member.person.name}
              </span>
              <span
                className={cn(
                  'inline-flex size-4 items-center justify-center rounded-xs ring-line',
                  picked && 'bg-accent text-ink-on-accent',
                )}
              >
                {picked && <Check className="size-3" strokeWidth={2.5} />}
              </span>
            </button>
          </li>
        )
      })}
    </ul>
  )
}

function Choice({
  icon,
  title,
  detail,
  selected,
  onSelect,
}: {
  icon: ReactNode
  title: string
  detail: string
  selected: boolean
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className={cn(
        'flex w-full cursor-pointer items-center gap-3 rounded-control px-3 py-2.5 text-left transition-surface duration-(--dur-fast)',
        selected
          ? 'bg-accent-soft ring-1 ring-accent'
          : 'bg-surface-2 ring-line hover:bg-wash-hover',
      )}
    >
      <span className={cn('shrink-0', selected ? 'text-accent-ink' : 'text-ink-3')}>{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block text-label font-title text-ink">{title}</span>
        <span className="block text-label text-ink-3">{detail}</span>
      </span>
    </button>
  )
}
