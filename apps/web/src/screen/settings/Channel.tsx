import { ChannelStanding, type Channel, type ChannelLink } from '@vivid/contracts'
import {
  codeEnding,
  composerOf,
  KNOWN_BY,
  makeWhen,
  MESSENGER,
  messageLink,
  channelWords,
  textingUnreached,
  textLink,
  thisReader,
  type Composer,
} from '@vivid/state'
import { Option } from 'effect'
import type { TextingActs } from '../../data/texting'
import { useMemo, useState, useSyncExternalStore, type ReactNode } from 'react'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../../ui/alertdialog'
import { Button, buttonVariants } from '../../ui/button'
import { cn } from '../../ui/cn'
import { Copy } from '../../ui/Copy'
import { Input } from '../../ui/input'
import { useSurface } from '../../ui/Layer'
import { Mark } from '../integration/Mark'
import { Refusal, Section } from './Parts'

const when = makeWhen(thisReader())

/**
 * Which form of `sms:` link this computer's messaging app reads. Apple's Messages (Mac, iPhone,
 * iPad) takes the body after `&`; everything else takes the standard `?`. See `messageLink`.
 */
const composer = (): Composer =>
  /Mac|iPhone|iPad|iPod/u.test(navigator.userAgent) ? 'apple' : 'standard'

type Standing<Tag extends ChannelStanding['_tag']> = Extract<ChannelStanding, { _tag: Tag }>

/**
 * Everything "Text Vivid" draws, given the channels and the ways to act. It reads no live data
 * and starts nothing itself (`Texting.tsx` is that half), so every standing can be rendered, and
 * tested, without a server behind it. One row for each messaging app, in the server's order.
 */
export function TextingChannels({
  links,
  acts,
}: {
  links: ReadonlyArray<ChannelLink>
  acts: TextingActs
}) {
  return (
    <Section
      // Not "Text Vivid" again: the pane is already titled that, one line above.
      title="Messaging apps"
      detail="Connect an app, then message Vivid there the way you message anyone."
    >
      {links.map((link) => (
        <ChannelControl key={link.channel} link={link} acts={acts} />
      ))}
    </Section>
  )
}

/** What a control is in the middle of asking the server, which holds its buttons meanwhile. */
type Asking = 'nothing' | 'connecting' | 'disconnecting'

/**
 * One messaging app and everything a Person does with it here: connect a number, confirm it,
 * see that it is connected, disconnect it. What it draws is decided by where the channel stands,
 * and a refusal from the last thing asked is said once underneath, whatever the standing.
 */
export function ChannelControl({ link, acts }: { link: ChannelLink; acts: TextingActs }) {
  const { channel, standing } = link
  const [asking, setAsking] = useState<Asking>('nothing')
  const [refused, setRefused] = useState<string | null>(null)

  /**
   * Asks once, holds the buttons until the answer, then says the refusal if there was one.
   *
   * The act is already running when it gets here: `acts` is the app's boundary, handed in so
   * that this control can be drawn with no runtime attached (`TextingActs`), and what it hands
   * back is a Promise. So the answer is followed as one, and nothing is started here.
   */
  function ask(what: Exclude<Asking, 'nothing'>, made: Promise<Option.Option<string>>) {
    setAsking(what)
    setRefused(null)
    return (
      made
        // A call that dies instead of answering is still Vivid not being reached.
        .catch(() => Option.some(textingUnreached))
        .then((said) => {
          setRefused(Option.getOrNull(said))
          setAsking('nothing')
        })
    )
  }

  const connect = (written: Option.Option<string>) =>
    void ask('connecting', acts.connect(channel, written))
  const disconnect = () => void ask('disconnecting', acts.disconnect(channel))

  return (
    <div>
      {ChannelStanding.guards.Unavailable(standing) && <Unavailable channel={channel} />}
      {ChannelStanding.guards.NotConnected(standing) &&
        (KNOWN_BY[channel] === 'number' ? (
          <NotConnected
            channel={channel}
            asking={asking}
            invalid={refused !== null}
            onConnect={(written) => connect(Option.some(written))}
          />
        ) : (
          <NotStarted channel={channel} asking={asking} onConnect={() => connect(Option.none())} />
        ))}
      {ChannelStanding.guards.Confirming(standing) && (
        <Confirming
          channel={channel}
          standing={standing}
          asking={asking}
          onAgain={() => connect(Option.some(standing.address))}
          onOther={disconnect}
        />
      )}
      {ChannelStanding.guards.Awaiting(standing) && (
        <Awaiting
          channel={channel}
          standing={standing}
          asking={asking}
          onAgain={() => connect(Option.none())}
          onCancel={disconnect}
        />
      )}
      {ChannelStanding.guards.Connected(standing) && (
        <Connected
          channel={channel}
          standing={standing}
          asking={asking}
          onDisconnect={disconnect}
        />
      )}
      {refused !== null && (
        <div className="px-4">
          <Refusal message={refused} />
        </div>
      )}
    </div>
  )
}

/**
 * A channel's row: its mark, its name over a sentence, and the control beside them. It keeps the
 * measure of `Row` (the control goes underneath on a narrow window) and adds the mark, which
 * `Row` has no place for.
 */
function Line({
  channel,
  detail,
  quiet = false,
  children,
}: {
  channel: Channel
  detail: ReactNode
  /** A channel that cannot be used here: its mark steps back with it. */
  quiet?: boolean
  children: ReactNode
}) {
  return (
    <div className="flex min-h-14 flex-col gap-2.5 px-4 py-3 sm:flex-row sm:items-center sm:gap-4">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <Mark service={{ name: channel }} className={cn(quiet && 'opacity-60')} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-label text-ink">{channel}</div>
          <div className="text-label text-pretty text-ink-3">{detail}</div>
        </div>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2">{children}</div>
    </div>
  )
}

/**
 * A channel Vivid does not text on yet (WhatsApp). It is shown, not hidden, so a Person looking for
 * it finds it and reads why it cannot be pressed; the button is there and plainly off.
 */
function Unavailable({ channel }: { channel: Channel }) {
  return (
    <Line channel={channel} quiet detail={`Vivid cannot text on ${channel} yet.`}>
      <Button size="sm" variant="outline" disabled>
        Connect
      </Button>
    </Line>
  )
}

/** The Person's own number and "Connect". One press is one request: the button holds meanwhile. */
function NotConnected({
  channel,
  asking,
  invalid,
  onConnect,
}: {
  channel: Channel
  asking: Asking
  /** The last number was refused; the field says so until it is typed in again. */
  invalid: boolean
  onConnect: (written: string) => void
}) {
  const [written, setWritten] = useState('')
  const [edited, setEdited] = useState(false)
  const busy = asking !== 'nothing'
  return (
    <Line channel={channel} detail="Your own number, with its country code.">
      <form
        className="flex w-full items-center gap-2 sm:w-auto"
        onSubmit={(event) => {
          event.preventDefault()
          setEdited(false)
          onConnect(written)
        }}
      >
        <Input
          compact
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          value={written}
          onChange={(event) => {
            setWritten(event.currentTarget.value)
            setEdited(true)
          }}
          placeholder="+234 801 234 5678"
          aria-label={`Your phone number for ${channel}`}
          aria-invalid={invalid && !edited}
          // The longest number there is, written with every space and bracket a person might add.
          maxLength={32}
          className="min-w-0 flex-1 sm:w-44 sm:flex-none"
        />
        {/* Not held back while the field is empty: a primary button that looks switched off reads
            as "this does not work". An empty number is answered like any other that cannot be
            reached, in words, under the row. */}
        <Button type="submit" size="sm" disabled={busy}>
          {busy ? 'Connecting…' : 'Connect'}
        </Button>
      </form>
    </Line>
  )
}

/**
 * A channel where there is no number to give (Discord): one press asks for a code, and the account
 * it is sent from becomes the Person's.
 */
function NotStarted({
  channel,
  asking,
  onConnect,
}: {
  channel: Channel
  asking: Asking
  onConnect: () => void
}) {
  return (
    <Line channel={channel} detail={`Connect, then send Vivid a code on ${channel}.`}>
      <Button size="sm" disabled={asking !== 'nothing'} onClick={onConnect}>
        {asking === 'connecting' ? 'Connecting…' : `Connect ${channel}`}
      </Button>
    </Line>
  )
}

/**
 * The number is given and not yet proved: the Person texts the code from that phone. The number
 * to text and the code are the two things to carry to the phone, so they are large, in the
 * fixed-width face, each with its own copy button.
 *
 * Nothing here counts down. When the code ends is said as a time, and the screen changes once,
 * at that moment (`codeEnding`): the code steps back and asking for a new one becomes the action.
 * When the text arrives the live list says `Connected` and this is replaced without being asked.
 */
function Confirming({
  channel,
  standing,
  asking,
  onAgain,
  onOther,
}: {
  channel: Channel
  standing: Standing<'Confirming'>
  asking: Asking
  onAgain: () => void
  onOther: () => void
}) {
  // One store for one code; a new code is a new `expiresAt` and a new store.
  const ending = useMemo(() => codeEnding(standing.expiresAt), [standing.expiresAt])
  const ended = useSyncExternalStore(ending.subscribe, ending.read, ending.read)
  // The day the time is said against is the day this was opened, like every other list here.
  const [opened] = useState(() => Date.now())
  const at = when(standing.expiresAt, opened)
  const busy = asking !== 'nothing'
  return (
    <div className="flex flex-col gap-3 px-4 py-3">
      <div className="flex items-center gap-3">
        <Mark service={{ name: channel }} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-label text-ink">{channel}</div>
          <div className="text-label text-ink-3">{channelWords(standing)}</div>
        </div>
      </div>
      <p className="text-label text-pretty text-ink-2">
        From the phone with <span className="text-ink tabular-nums">{standing.address}</span>, text
        this code to this number.
      </p>
      <dl className="divide-y divide-line-1 rounded-control bg-well">
        <Figure name="Text this number" value={standing.textTo} spent={false} />
        <Figure name="This code" value={standing.code} spent={ended} />
      </dl>
      <p aria-live="polite" className="text-label text-ink-3">
        {ended ? `This code ended at ${at}. Get a new one.` : `The code works until ${at}.`}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        {!ended && (
          <a
            href={messageLink(channel, composer(), standing.textTo, Option.some(standing.code))}
            className={buttonVariants({ size: 'sm' })}
          >
            Open {MESSENGER[channel]}
          </a>
        )}
        <Button size="sm" variant={ended ? 'default' : 'ghost'} disabled={busy} onClick={onAgain}>
          {asking === 'connecting' ? 'Getting a new code…' : 'Get a new code'}
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={onOther}>
          Use a different number
        </Button>
      </div>
    </div>
  )
}

/**
 * Waiting for the code on a channel with no number to give (Discord): whoever sends it to Vivid
 * there is the account that becomes the Person's. The code is the one thing to carry, so it is
 * large with its copy; "Open Discord" goes to the Vivid bot, where it is pasted, since Discord's
 * links cannot write it in. Like `Confirming`, the screen changes once when the code ends, to
 * connecting again for a new code, and the live list replaces this with `Connected` when the
 * message arrives.
 */
function Awaiting({
  channel,
  standing,
  asking,
  onAgain,
  onCancel,
}: {
  channel: Channel
  standing: Standing<'Awaiting'>
  asking: Asking
  onAgain: () => void
  onCancel: () => void
}) {
  const ending = useMemo(() => codeEnding(standing.expiresAt), [standing.expiresAt])
  const ended = useSyncExternalStore(ending.subscribe, ending.read, ending.read)
  const [opened] = useState(() => Date.now())
  const at = when(standing.expiresAt, opened)
  const busy = asking !== 'nothing'
  return (
    <div className="flex flex-col gap-3 px-4 py-3">
      <div className="flex items-center gap-3">
        <Mark service={{ name: channel }} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-label text-ink">{channel}</div>
          <div className="text-label text-ink-3">{channelWords(standing)}</div>
        </div>
      </div>
      <p className="text-label text-pretty text-ink-2">Send this code to Vivid on {channel}.</p>
      <dl className="rounded-control bg-well">
        <Figure name="This code" value={standing.code} spent={ended} />
      </dl>
      <p aria-live="polite" className="text-label text-ink-3">
        {ended ? 'This code has ended.' : `The code works until ${at}.`}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        {ended ? (
          <Button size="sm" disabled={busy} onClick={onAgain}>
            {asking === 'connecting' ? 'Connecting…' : 'Connect again'}
          </Button>
        ) : (
          <a
            href={messageLink(channel, composer(), standing.textTo, Option.none())}
            className={buttonVariants({ size: 'sm' })}
          >
            Open {MESSENGER[channel]}
          </a>
        )}
        <Button size="sm" variant="ghost" disabled={busy} onClick={onCancel}>
          {asking === 'disconnecting' ? 'Cancelling…' : 'Cancel'}
        </Button>
      </div>
    </div>
  )
}

/**
 * One thing to carry to the phone: what it is, the value in the fixed-width face, and a button
 * that copies it. A code that has ended is struck through and cannot be copied, so an old code
 * is never the one that gets sent.
 */
function Figure({ name, value, spent }: { name: string; value: string; spent: boolean }) {
  return (
    <div className="flex items-center gap-3 px-3 py-2">
      <div className="min-w-0 flex-1">
        <dt className="text-meta font-meta text-ink-3">{name}</dt>
        <dd
          className={cn(
            'font-mono text-section break-all tabular-nums',
            spent ? 'text-ink-4 line-through' : 'text-ink select-all',
          )}
        >
          {value}
        </dd>
      </div>
      {!spent && <Copy name={name} read={() => value} />}
    </div>
  )
}

/**
 * A connected channel. What a Person does with one is text Vivid, so the number to text is the
 * large thing (the same `Figure` the code is shown in, with its copy button) and the filled button
 * under it opens their messaging app on a first message to that number. Their own number and
 * since when are said quietly; disconnecting stops Vivid answering that phone, so it stands apart
 * on the last line, in the danger colour, and is asked for twice.
 *
 * The button is only there when this device can be expected to open the link (`textLink`). A
 * Windows or Linux desktop has nothing that takes an `sms:` link, and a button that does nothing
 * when pressed is worse than none: there the number and its copy are the whole of it, and one
 * sentence says to text it from the phone.
 *
 * Discord has no number to text (`KNOWN_BY`): the Person writes to the Vivid bot, so the line says
 * where Vivid answers there instead.
 */
function Connected({
  channel,
  standing,
  asking,
  onDisconnect,
}: {
  channel: Channel
  standing: Standing<'Connected'>
  asking: Asking
  onDisconnect: () => void
}) {
  const [confirming, setConfirming] = useState(false)
  const [opened] = useState(() => Date.now())
  const link = textLink(channel, composerOf(navigator.userAgent), standing.textTo)
  const byNumber = KNOWN_BY[channel] === 'number'
  return (
    <>
      <div className="flex flex-col gap-3 px-4 py-3">
        <div className="flex items-center gap-3">
          <Mark service={{ name: channel }} />
          <div className="min-w-0 flex-1">
            <div className="truncate text-label text-ink">{channel}</div>
            <div className="flex items-center gap-1.5 text-label text-ink-3">
              <i aria-hidden className="size-1.5 shrink-0 rounded-full bg-success" />
              {channelWords(standing)} · {when(standing.since, opened)}
            </div>
          </div>
        </div>
        {byNumber && (
          <dl className="rounded-control bg-well">
            <Figure name="Vivid’s number" value={standing.textTo} spent={false} />
          </dl>
        )}
        {Option.isSome(link) && (
          <div>
            <a href={link.value} className={buttonVariants({ size: 'sm' })}>
              Open {MESSENGER[channel]}
            </a>
          </div>
        )}
        {/* The quiet end of the group: whose phone this is, and the way out, kept away from the
            button above so the two are never pressed for each other. */}
        <div className="flex flex-wrap items-center justify-end gap-x-4 gap-y-2">
          <p className="min-w-48 flex-1 text-label text-pretty wrap-anywhere text-ink-3">
            {byNumber ? (
              <>
                {Option.isNone(link) && 'Text this number from your phone. '}
                Vivid answers texts from <span className="tabular-nums">{standing.address}</span>.
              </>
            ) : (
              'DM Vivid, or mention @Vivid in any channel of your server.'
            )}
          </p>
          <Button
            size="sm"
            variant="destructive"
            disabled={asking !== 'nothing'}
            onClick={() => setConfirming(true)}
          >
            {asking === 'disconnecting' ? 'Disconnecting…' : 'Disconnect'}
          </Button>
        </div>
      </div>
      {confirming && (
        <Disconnect
          channel={channel}
          stops={
            byNumber
              ? `Vivid will stop answering texts from ${standing.address}.`
              : `Vivid will stop answering you on ${channel}.`
          }
          onClose={() => setConfirming(false)}
          onDisconnect={onDisconnect}
        />
      )}
    </>
  )
}

/** The second ask before a number is taken off a channel. `stops` says what Vivid stops doing. */
function Disconnect({
  channel,
  stops,
  onClose,
  onDisconnect,
}: {
  channel: Channel
  stops: string
  onClose: () => void
  onDisconnect: () => void
}) {
  return (
    <AlertDialog {...useSurface(onClose)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Disconnect {channel}?</AlertDialogTitle>
          <AlertDialogDescription>
            {`${stops} You can connect it again at any time.`}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel variant="ghost">Keep it</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            onClick={() => {
              onClose()
              onDisconnect()
            }}
          >
            Disconnect {channel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
