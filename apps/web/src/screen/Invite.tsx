import type { InvitationId, InvitationPreview } from '@vivid/contracts'
import { Result } from 'effect'
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
 * An invitation to a Company, opened from its link. It says who invited the Person and to what,
 * before anything happens; joining is their choice. An invitation that was used, withdrawn or has
 * run out says so plainly instead of failing when the button is pressed.
 */
export function Invite({ id }: { id: InvitationId }) {
  const preview = use(previewOf(id))
  const [refusal, setRefusal] = useState<string | null>(null)

  async function join() {
    const result = await change((client) => client.AcceptInvitation({ invitationId: id }))
    if (Result.isFailure(result)) {
      setRefusal('This invitation is for a different email address, or it was already used.')
      return
    }
    router.go(Route.New())
  }

  return (
    <section className="flex h-full min-w-0 flex-1 flex-col items-center justify-center gap-4 bg-surface-0 px-6 text-center content-edge">
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
          <p className="max-w-sm text-label text-ink-3">
            You will share threads, a library and connections with the company. Your own threads,
            notes and connections stay yours.
          </p>
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
            <p role="alert" className="text-label text-danger">
              {refusal}
            </p>
          )}
        </>
      )}
    </section>
  )
}

const article = (role: string) =>
  role === 'admin' || role === 'owner' ? `an ${role}` : `a ${role}`
