import type { InvitationId, InvitationPreview } from '@vivid/contracts'
import { Effect, Result } from 'effect'
import { use, useState } from 'react'
import { change } from '../data/live'
import { Route, router } from '../data/route'
import { Avatar } from '../ui/Avatar'
import { Button } from '../ui/Button'
import { Face } from '../ui/Face'

const previews = new Map<InvitationId, Promise<InvitationPreview | null>>()

/**
 * The preview of one invitation, asked for once per id and shared by every render. React reads
 * the promise with `use`, so the screen suspends while it is on its way and there is no effect,
 * no loading flag and no second request under Strict Mode.
 */
const previewOf = (id: InvitationId) => {
  const known = previews.get(id)
  if (known !== undefined) return known
  const asked = change((client) => client.PreviewInvitation({ id })).then((result) =>
    Result.isSuccess(result) ? result.success : null,
  )
  previews.set(id, asked)
  return asked
}

/**
 * Why pressing Join did not join, in the words the Person reads. Each sentence is true of the
 * failure it is shown for; none is a guess.
 * - `unconfirmed` is the server's `MailboxUnconfirmed`: the address is the invited one, but it was
 *   registered with a password and nothing has shown the mailbox is theirs. Vivid has no way to
 *   send mail yet, so the sentence says that and offers no "send me a link" that could not work.
 * - `refused` is the invitation itself saying no: `Forbidden` (another address, or no longer
 *   open), `Conflict` (already used, or already a Member) and `NotFound` (withdrawn since the
 *   preview). Trying again cannot change any of them.
 * - `failed` is everything else: the database, the runtime or the connection. The invitation may
 *   be perfectly good, so the sentence blames nothing about it and says to try again.
 */
const REFUSALS = {
  unconfirmed:
    'This Vivid cannot confirm the email address of an account with a password yet, so you cannot join with this account.',
  refused: 'This invitation is for a different email address, or it was already used.',
  failed: 'Could not join right now. Try again.',
} as const

/**
 * An invitation to a Company, opened from its link. It says who invited the Person and to what,
 * before anything happens; joining is their choice. An invitation that was used, withdrawn or has
 * run out says so plainly instead of failing when the button is pressed.
 */
export function Invite({ id }: { id: InvitationId }) {
  const preview = use(previewOf(id))
  const [refusal, setRefusal] = useState<keyof typeof REFUSALS | null>(null)

  async function join() {
    // The invitation's own answers are taken out of the failure channel by tag, inside the
    // operation, and never guessed from a message. What is left in the channel is then only
    // infrastructure and the unexpected, which must not be reported as a bad invitation.
    const result = await change((client) =>
      client.AcceptInvitation({ invitationId: id }).pipe(
        Effect.as('joined' as const),
        Effect.catchTags({
          MailboxUnconfirmed: () => Effect.succeed('unconfirmed' as const),
          Forbidden: () => Effect.succeed('refused' as const),
          Conflict: () => Effect.succeed('refused' as const),
          NotFound: () => Effect.succeed('refused' as const),
        }),
      ),
    )
    if (Result.isFailure(result)) return setRefusal('failed')
    if (result.success !== 'joined') return setRefusal(result.success)
    router.go(Route.New())
  }

  return (
    <section className="flex h-full min-w-0 flex-1 flex-col items-center justify-center gap-4 bg-surface-0 px-6 text-center">
      <Face size={48} mood="happy" />
      {preview === null ? (
        <>
          <h1 className="text-page font-title text-ink">This invitation is not here</h1>
          <p className="max-w-sm text-body text-ink-3">
            It may have been withdrawn. Ask whoever invited you for a new link.
          </p>
          <Button onClick={() => router.go(Route.New())}>Go to Vivid</Button>
        </>
      ) : (
        <>
          <h1 className="text-page font-title text-ink">Join {preview.company.name}</h1>
          <p className="flex items-center gap-2 text-body text-ink-3">
            <Avatar name={preview.invitedBy.name} image={preview.invitedBy.image} size={20} />
            {preview.invitedBy.name} invited you as {article(preview.role)}.
          </p>
          <Boundaries company={preview.company.name} />
          {preview.status === 'pending' ? (
            <div className="flex gap-2">
              <Button variant="ghost" onClick={() => router.go(Route.New())}>
                Not now
              </Button>
              <Button variant="primary" onClick={() => void join()}>
                Join {preview.company.name}
              </Button>
            </div>
          ) : (
            <p className="text-label text-attention">This invitation is no longer open.</p>
          )}
          {refusal !== null && (
            <p role="alert" className="max-w-sm text-label text-danger">
              {REFUSALS[refusal]}
            </p>
          )}
        </>
      )}
    </section>
  )
}

/**
 * What joining shares and what it does not, said before the Person joins. Someone asked to bring
 * their assistant into a company needs to know, first, what the company will be able to see; a
 * single reassuring sentence did not say it. Each line is something the server enforces.
 */
const SHARED = [
  'Threads you start for everyone or share',
  'The company’s Library and Projects',
  'Integrations an admin sets up for all',
  'Rules its admins write',
]
const YOURS = [
  'Your private threads',
  'What Vivid knows about you',
  'Your own Integrations',
  'Your own computer',
]

function Boundaries({ company }: { company: string }) {
  return (
    <div className="grid w-full max-w-lg gap-2.5 text-left sm:grid-cols-2">
      <Boundary title={`Shared with ${company}`} lines={SHARED} />
      <Boundary title="Still only yours" lines={YOURS} note="Admins cannot read these." />
    </div>
  )
}

function Boundary({
  title,
  lines,
  note,
}: {
  title: string
  lines: ReadonlyArray<string>
  note?: string
}) {
  return (
    <section className="rounded-card bg-surface-3 p-4 edge">
      <h2 className="text-label font-title text-ink">{title}</h2>
      <ul className="mt-2 flex flex-col gap-1.5 text-label text-ink-2">
        {lines.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      {note !== undefined && <p className="mt-2 text-meta font-meta text-ink-3">{note}</p>}
    </section>
  )
}

const article = (role: string) =>
  role === 'admin' || role === 'owner' ? `an ${role}` : `a ${role}`
