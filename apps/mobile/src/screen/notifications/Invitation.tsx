import type { InvitationId, InvitationPreview } from '@vivid/contracts'
import { Data, Effect, Option, Result } from 'effect'
import { Suspense, use, useState } from 'react'
import { View } from 'react-native'
import { confirm } from '../../data/haptics'
import { useLiveData, type LiveData } from '../../data/live'
import { Avatar } from '../../ui/Avatar'
import { Sheet } from '../../ui/Sheet'
import { Button, Card, Label, Notice, Skeleton } from '../../ui/ui'

/**
 * What asking the server about an invitation came to.
 *
 * - `Found`: the invitation, whatever its status; a used or withdrawn one still says who sent it.
 * - `Missing`: the server's own `NotFound`. There is no such invitation for anyone to see.
 * - `Unread`: the question itself failed (the connection, the server). Nothing is known about the
 *   invitation, so nothing is said about it; `message` is the failure's own sentence.
 *
 * The web's page reads every failure as "not here" (`previewOf` in `apps/web/src/screen/
 * Invite.tsx`). A phone loses its connection far more often than a browser tab, and telling
 * someone their invitation was withdrawn because a train went into a tunnel is untrue, so the
 * two are kept apart here.
 */
type Reading = Data.TaggedEnum<{
  Found: { readonly preview: InvitationPreview }
  Missing: {}
  Unread: { readonly message: string }
}>
const Reading = Data.taggedEnum<Reading>()

/**
 * Asks the server what an invitation is. The answer the invitation itself gives (`NotFound`) is
 * taken out of the failure channel by its tag, inside the operation; what is left there is only
 * infrastructure and the unexpected. It never rejects: every ending is a `Reading`.
 */
const read = (data: LiveData, id: InvitationId): Promise<Reading> =>
  data
    .change((client) =>
      client.PreviewInvitation({ id }).pipe(
        Effect.map((preview): Reading => Reading.Found({ preview })),
        Effect.catchTags({ NotFound: () => Effect.succeed<Reading>(Reading.Missing()) }),
      ),
    )
    .then((result) =>
      Result.isSuccess(result)
        ? result.success
        : Reading.Unread({ message: result.failure.message }),
    )

/**
 * Why pressing Join did not join, in the words the Person reads. Each sentence is true of the
 * failure it is shown for; none is a guess. Ported from the web's `REFUSALS`
 * (`apps/web/src/screen/Invite.tsx`).
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
 * What joining shares and what it does not, said before the Person joins. Someone asked to bring
 * their assistant into a company needs to know, first, what the company will be able to see.
 * Each line is something the server enforces. The web's lists, word for word.
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

/** A role with the article English gives it: "an admin", "an owner", "a member". */
const article = (role: string) =>
  role === 'admin' || role === 'owner' ? `an ${role}` : `a ${role}`

/**
 * An invitation to a Company, opened from its row in Notifications as a sheet over the list. It
 * says who invited the Person and to what, and what joining shares, before anything happens;
 * joining is their choice. An invitation that was used, withdrawn or has run out says so plainly
 * instead of failing when the button is pressed.
 *
 * The same answers and words as the web's page (`apps/web/src/screen/Invite.tsx`), which the
 * phone used to open in the browser. The two lists are stacked, not set side by side, and the
 * choice is in the sheet's footer under a thumb.
 *
 * The server is asked once, as the sheet opens: the question is this component's first state, a
 * promise the two parts below read with `use`, so there is no effect and no loading flag. It is
 * asked afresh each time the sheet is opened, never remembered, because an invitation changes
 * (it is used, or withdrawn) and an app is open for days. Joining closes the sheet and goes
 * nowhere: the live `me` query is what moves the Person into the Company.
 */
export function Invitation({ id, onClose }: { id: InvitationId; onClose: () => void }) {
  const data = useLiveData()
  const [asked, setAsked] = useState(() => read(data, id))
  return (
    <Sheet
      title="Invitation"
      onClose={onClose}
      footer={
        // Nothing to choose until the invitation has been read.
        <Suspense fallback={null}>
          <Choice
            id={id}
            asked={asked}
            onAgain={() => setAsked(read(data, id))}
            onClose={onClose}
          />
        </Suspense>
      }
    >
      <Suspense fallback={<Skeleton rows={4} />}>
        <Shown asked={asked} />
      </Suspense>
    </Sheet>
  )
}

/** What the sheet says, once the server has answered: the invitation, or why there is none. */
function Shown({ asked }: { asked: Promise<Reading> }) {
  return Reading.$match(use(asked), {
    Found: ({ preview }) => <Offer preview={preview} />,
    Missing: () => (
      <View style={{ gap: 6 }}>
        <Label accessibilityRole="header" size="title">
          This invitation is not here
        </Label>
        <Label tone="ink-2">
          It may have been withdrawn. Ask whoever invited you for a new link.
        </Label>
      </View>
    ),
    Unread: ({ message }) => <Notice message={message} />,
  })
}

/**
 * Who is asking, to what, and what it means. The Company's name leads, then the Person who sent
 * the invitation with their picture, then, for one that can no longer be accepted, that it
 * cannot; the two lists follow so they are read before the choice below them.
 */
function Offer({ preview }: { preview: InvitationPreview }) {
  return (
    <>
      <View style={{ gap: 10 }}>
        <Label accessibilityRole="header" size="title">
          Join {preview.company.name}
        </Label>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <Avatar name={preview.invitedBy.name} image={preview.invitedBy.image} size={28} />
          <Label tone="ink-2" style={{ flex: 1 }}>
            {preview.invitedBy.name} invited you as {article(preview.role)}.
          </Label>
        </View>
        {preview.status !== 'pending' && (
          <Label size="label" tone="status-attention">
            This invitation is no longer open.
          </Label>
        )}
      </View>
      <Boundary title={`Shared with ${preview.company.name}`} lines={SHARED} note={Option.none()} />
      <Boundary
        title="Still only yours"
        lines={YOURS}
        note={Option.some('Admins cannot read these.')}
      />
    </>
  )
}

/** One side of the line joining draws: what crosses it, or what stays behind it. */
function Boundary({
  title,
  lines,
  note,
}: {
  title: string
  lines: ReadonlyArray<string>
  /** What is promised about the whole list, when something is. */
  note: Option.Option<string>
}) {
  return (
    <Card>
      <Label accessibilityRole="header" style={{ fontWeight: '600' }}>
        {title}
      </Label>
      <View style={{ gap: 6 }}>
        {lines.map((line) => (
          <Label key={line} tone="ink-2">
            {line}
          </Label>
        ))}
      </View>
      {Option.isSome(note) && (
        <Label size="label" tone="ink-3">
          {note.value}
        </Label>
      )}
    </Card>
  )
}

/**
 * What the Person can do about what was read, in the sheet's footer: join or leave it for now
 * when the invitation is open, ask again when the question failed, and otherwise only close,
 * because nothing they press could change an invitation that is gone or no longer open.
 */
function Choice({
  id,
  asked,
  onAgain,
  onClose,
}: {
  id: InvitationId
  asked: Promise<Reading>
  /** Asks the server about the invitation again. */
  onAgain: () => void
  onClose: () => void
}) {
  return Reading.$match(use(asked), {
    Found: ({ preview }) =>
      preview.status === 'pending' ? (
        <Join id={id} company={preview.company.name} onClose={onClose} />
      ) : (
        <Button label="Close" onPress={onClose} />
      ),
    Missing: () => <Button label="Close" onPress={onClose} />,
    Unread: () => <Button kind="primary" label="Try again" onPress={onAgain} />,
  })
}

/** How the last press on Join went. */
type Joining = Data.TaggedEnum<{
  Idle: {}
  Asking: {}
  Refused: { readonly why: keyof typeof REFUSALS }
}>
const Joining = Data.taggedEnum<Joining>()

/**
 * Join, and the way to leave the invitation for later. The Company's name is on the button, so
 * what is being agreed to is said where the thumb is. A refusal is said above the buttons and
 * leaves them as they were.
 */
function Join({
  id,
  company,
  onClose,
}: {
  id: InvitationId
  company: string
  onClose: () => void
}) {
  const data = useLiveData()
  const [joining, setJoining] = useState<Joining>(Joining.Idle())
  const asking = Joining.$is('Asking')(joining)

  async function join() {
    setJoining(Joining.Asking())
    // The invitation's own answers are taken out of the failure channel by tag, inside the
    // operation, and never guessed from a message. What is left in the channel is then only
    // infrastructure and the unexpected, which must not be reported as a bad invitation.
    const result = await data.change((client) =>
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
    if (Result.isFailure(result)) {
      setJoining(Joining.Refused({ why: 'failed' }))
      return
    }
    if (result.success !== 'joined') {
      setJoining(Joining.Refused({ why: result.success }))
      return
    }
    // Joined. The live `me` query moves the Person into the Company; the sheet only gets out of
    // the way.
    confirm()
    onClose()
  }

  return (
    <View style={{ gap: 8 }}>
      {Joining.$is('Refused')(joining) && <Notice message={REFUSALS[joining.why]} />}
      <Button
        kind="primary"
        label={asking ? 'Joining…' : `Join ${company}`}
        disabled={asking}
        onPress={() => void join()}
      />
      <Button kind="ghost" label="Not now" disabled={asking} onPress={onClose} />
    </View>
  )
}
