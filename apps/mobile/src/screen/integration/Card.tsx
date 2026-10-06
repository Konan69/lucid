import { ConnectionStep, type ConnectionId, type ConnectionRequestMessage } from '@vivid/contracts'
import { answered, Awaited, awaitedWords } from '@vivid/state'
import { Option, Result } from 'effect'
import { useState } from 'react'
import { View } from 'react-native'
import { ExternalLink, KeyRound, Link2 } from 'lucide-react-native'
import { commit } from '../../data/haptics'
import {
  Finish,
  finishOf,
  finishOfStep,
  type Authorization,
  type KeyFields,
} from '../../data/integration'
import { useLiveData, useLiveValue } from '../../data/live'
import { useTheme } from '../../theme'
import { ServiceMark } from '../../ui/Mark'
import { Button, EDGE, Label, Notice, radius } from '../../ui/ui'
import { Integrations } from '../settings/Integrations'
import { EnterKey } from './Key'
import { Returning, showSignIn, Trip } from './Trip'

/**
 * Vivid needs a service to go on. The card says why in Vivid's own words and finishes the job
 * where the Person already is.
 *
 * A service Vivid only offered from the catalogue is picked and connected in the Integrations
 * sheet, which the card opens over the Thread; it used to send the Person to the web app's
 * settings for that. An Integration Vivid has already begun adding carries what is
 * left (`authorization`): a sign-in, which opens the provider's page in the phone's browser and
 * asks the server where things stand when the Person comes back, or a key, which is typed into a
 * sheet that sends it straight to the Integration (never into the Thread, never to Vivid). The
 * card names the Integration and nothing more: the sign-in address itself is asked of the server
 * when it is opened, and is never read from the Thread.
 *
 * Whether it is ready is read live, so the card turns to "Carry on" by itself, on this phone or
 * because the sign-in was finished on another device.
 *
 * Which accounts make it ready is `awaited`. A service Vivid offered is answered by any ready
 * account on it; an Integration Vivid began, by that one. One more account, which Vivid asks for
 * when the Person wants an account that is not among theirs (their work Gmail), is answered only
 * by an account begun after Vivid asked. That card is headed "Another Gmail account" and offers
 * "Add account" although the service is already connected; the Integrations sheet it opens says
 * "Add another account" on that service's row.
 *
 * Adapted from the web's card (`ConnectionCard` and `Finish` in
 * `apps/web/src/screen/thread/Cards.tsx`).
 */
export function IntegrationCard({
  request,
  authorization,
  awaited,
  onContinue,
}: {
  request: ConnectionRequestMessage
  /** What finishing it takes, when Vivid has already begun adding it. */
  authorization: Option.Option<Authorization>
  awaited: Awaited
  onContinue: (message: string) => void
}) {
  const data = useLiveData()
  const { colors: c } = useTheme()
  const connections = useLiveValue(data.live.connections)
  // What the server last said is left: asked on the way back from the provider's page, or told
  // when a key was taken. Until it has said anything, the card's own payload is what is left.
  const [latest, setLatest] = useState<Option.Option<Finish>>(Option.none())
  const finish = finishOf(authorization, latest)
  const words = awaitedWords(awaited, request.serviceName)
  // A request for one more account is never ready when it is made, whatever the card was told.
  const ready =
    (Awaited.$is('Service')(awaited) && request.ready) ||
    Option.exists(finish, Finish.$is('Done')) ||
    Option.exists(connections, (value) => answered(value.connections, request, awaited))
  return (
    <View
      style={{
        padding: 12,
        gap: 12,
        borderRadius: radius.card,
        borderWidth: EDGE,
        borderColor: c.border,
        backgroundColor: c.subtle,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <ServiceMark service={request.service} size={32} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <Label numberOfLines={1} size="footnote">
            {words.title}
          </Label>
          <Label size="label" tone="ink-2">
            {request.reason}
          </Label>
        </View>
      </View>
      {ready ? (
        <Button
          kind="primary"
          label="Carry on"
          onPress={() => {
            // It says something in the Thread, and sending is felt.
            commit()
            onContinue(words.carryOn)
          }}
        />
      ) : (
        left({
          name: request.serviceName,
          another: Awaited.$is('Another')(awaited),
          finish,
          onFinish: (next) => setLatest(Option.some(next)),
        })
      )}
    </View>
  )
}

/**
 * The one thing left to do to connect it: sign in, give it a key, or pick it from the catalog. A
 * projection of what is left onto the control that advances it; it holds nothing itself.
 */
const left = ({
  name,
  another,
  finish,
  onFinish,
}: {
  name: string
  /** Whether Vivid asked for one more account on a service that is already connected. */
  another: boolean
  finish: Option.Option<Finish>
  /** The server has said what is left now. */
  onFinish: (finish: Finish) => void
}) =>
  Option.match(finish, {
    onNone: () => <Connect label={another ? 'Add account' : 'Connect'} />,
    onSome: (next) =>
      Finish.$match(next, {
        SignIn: ({ id }) => <SignIn id={id} name={name} onFinish={onFinish} />,
        Key: ({ id, fields }) => (
          <Key id={id} name={name} fields={fields} onConnected={() => onFinish(Finish.Done())} />
        ),
        // A card that is done is drawn as "Carry on"; there is nothing left to offer.
        Done: () => null,
      }),
  })

/**
 * A service Vivid offered and has not begun adding. Choosing the account and authorizing it is
 * done in the Integrations sheet, opened here over the Thread, so the Person never leaves the
 * app for it. Whether it worked is not this button's to hear: the card reads the live list and
 * turns to "Carry on" by itself.
 */
function Connect({ label }: { label: string }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button icon={Link2} label={label} onPress={() => setOpen(true)} />
      {open && <Integrations onClose={() => setOpen(false)} />}
    </>
  )
}

/** What the button says at each point. It is the way in at every point but the two it waits at. */
const signInLabel = (trip: Trip): string =>
  Trip.$match(trip, {
    Still: () => 'Sign in',
    Opening: () => 'Opening…',
    Away: () => 'Sign in',
    Checking: () => 'Checking…',
    Unfinished: () => 'Sign in',
    Refused: () => 'Sign in',
  })

/**
 * Signing in on the provider's own page. The app has no browser of its own (it signs a device in
 * the same way, through the phone's browser), so the page is handed to the system and the app
 * goes to the background.
 *
 * The server is asked twice, with the same call (`ResumeConnection`), and it is the same
 * Integration afterwards, never a second one. Once on the press: a sign-in address is a
 * short-lived permission, so it is issued at the moment it is opened instead of being carried in
 * the Thread. And once when the Person comes back to the app, which is the cue to find out
 * whether it went through; if it did the card becomes "Carry on", and if it did not it says so
 * quietly and can be pressed again.
 *
 * The trip itself (its states, the hand-off to the browser, hearing the return) is `Trip.tsx`,
 * shared with the Integrations sheet.
 */
function SignIn({
  id,
  name,
  onFinish,
}: {
  id: ConnectionId
  name: string
  onFinish: (finish: Finish) => void
}) {
  const data = useLiveData()
  const [trip, setTrip] = useState<Trip>(Trip.Still())

  /** Asks where the Integration stands. A refusal is said on the card and answers with nothing. */
  async function ask(): Promise<Option.Option<ConnectionStep>> {
    const result = await data.change((client) => client.ResumeConnection({ id }))
    if (Result.isSuccess(result)) return Option.some(result.success)
    setTrip(Trip.Refused({ message: result.failure.message }))
    return Option.none()
  }

  /** Hands the provider's page to the browser, and starts listening for the way back. */
  const open = (address: string) =>
    showSignIn(address, name, {
      away: () => setTrip(Trip.Away()),
      refused: (message) => setTrip(Trip.Refused({ message })),
    })

  async function leave() {
    setTrip(Trip.Opening())
    const step = await ask()
    if (Option.isNone(step)) return
    if (ConnectionStep.guards.OpenSignIn(step.value)) {
      open(step.value.address)
      return
    }
    // It was finished somewhere else, or the service wants a key after all: the card is redrawn
    // as that, and this button is no longer on screen.
    setTrip(Trip.Still())
    onFinish(finishOfStep(step.value))
  }

  async function check() {
    setTrip(Trip.Checking())
    const step = await ask()
    if (Option.isNone(step)) return
    // Only read when the sign-in is still to do; otherwise the card is redrawn without this.
    setTrip(Trip.Unfinished())
    onFinish(finishOfStep(step.value))
  }

  const waiting = Trip.$is('Opening')(trip) || Trip.$is('Checking')(trip)
  return (
    <View style={{ gap: 8 }}>
      {Trip.$is('Away')(trip) && <Returning onReturn={() => void check()} />}
      <Button
        kind="primary"
        icon={ExternalLink}
        label={signInLabel(trip)}
        disabled={waiting}
        onPress={() => void leave()}
      />
      {Trip.$is('Unfinished')(trip) && (
        <Label size="label" tone="ink-2">
          {name} is not signed in yet.
        </Label>
      )}
      {Trip.$is('Refused')(trip) && <Notice message={trip.message} />}
    </View>
  )
}

/** Giving the service its key, in a sheet. The card itself never holds what is typed. */
function Key({
  id,
  name,
  fields,
  onConnected,
}: {
  id: ConnectionId
  name: string
  fields: KeyFields
  /** The service took the key and the Integration is ready. */
  onConnected: () => void
}) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button kind="primary" icon={KeyRound} label="Enter key" onPress={() => setOpen(true)} />
      {open && (
        <EnterKey
          keying={{ id, name, fields }}
          onClose={() => setOpen(false)}
          onConnected={onConnected}
        />
      )}
    </>
  )
}
