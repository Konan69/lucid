import { ConnectionStep, type ConnectionId, type ConnectionRequestMessage } from '@vivid/contracts'
import { signInPage } from '@vivid/state'
import { Data, Option, Result } from 'effect'
import { useMemo, useState } from 'react'
import { Linking, View } from 'react-native'
import { ExternalLink, KeyRound, Link2 } from 'lucide-react-native'
import { onForeground } from '../../data/foreground'
import { commit } from '../../data/haptics'
import {
  Finish,
  finishOf,
  finishOfStep,
  isReady,
  type Authorization,
  type KeyFields,
} from '../../data/integration'
import { useLiveData, useLiveValue } from '../../data/live'
import { connectionsAddress } from '../../data/server'
import { useTheme } from '../../theme'
import { ServiceMark } from '../../ui/Mark'
import { Button, HAIRLINE, Label, Notice, radius } from '../../ui/ui'
import { EnterKey } from './Key'

/**
 * Vivid needs a service to go on. The card says why in Vivid's own words and finishes the job
 * where the Person already is.
 *
 * A service Vivid only offered from the catalogue is connected in the web app's settings, so the
 * card opens those in the browser. An Integration Vivid has already begun adding carries what is
 * left (`authorization`): a sign-in, which opens the provider's page in the phone's browser and
 * asks the server where things stand when the Person comes back, or a key, which is typed into a
 * sheet that sends it straight to the Integration (never into the Thread, never to Vivid). The
 * card names the Integration and nothing more: the sign-in address itself is asked of the server
 * when it is opened, and is never read from the Thread.
 *
 * Whether it is ready is read live, so the card turns to "Carry on" by itself, on this phone or
 * because the sign-in was finished on another device.
 *
 * Adapted from the web's card (`ConnectionCard` and `Finish` in
 * `apps/web/src/screen/thread/Cards.tsx`).
 */
export function IntegrationCard({
  request,
  authorization,
  onContinue,
}: {
  request: ConnectionRequestMessage
  /** What finishing it takes, when Vivid has already begun adding it. */
  authorization: Option.Option<Authorization>
  onContinue: (message: string) => void
}) {
  const data = useLiveData()
  const { colors: c } = useTheme()
  const connections = useLiveValue(data.live.connections)
  // What the server last said is left: asked on the way back from the provider's page, or told
  // when a key was taken. Until it has said anything, the card's own payload is what is left.
  const [latest, setLatest] = useState<Option.Option<Finish>>(Option.none())
  const finish = finishOf(authorization, latest)
  const ready =
    request.ready ||
    Option.exists(finish, Finish.$is('Done')) ||
    Option.exists(connections, (value) => isReady(value.connections, request, authorization))
  return (
    <View
      style={{
        padding: 12,
        gap: 12,
        borderRadius: radius.card,
        borderWidth: HAIRLINE,
        borderColor: c['line-3'],
        backgroundColor: c['surface-2'],
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <ServiceMark service={request.service} size={32} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <Label numberOfLines={1} size="footnote">
            {request.serviceName}
          </Label>
          <Label size="label" tone="ink-3">
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
            onContinue(`${request.serviceName} is connected. Carry on.`)
          }}
        />
      ) : (
        left(request.serviceName, finish, (next) => setLatest(Option.some(next)))
      )}
    </View>
  )
}

/**
 * The one thing left to do to connect it: sign in, give it a key, or pick it in the browser. A
 * projection of what is left onto the control that advances it; it holds nothing itself.
 */
const left = (
  name: string,
  finish: Option.Option<Finish>,
  /** The server has said what is left now. */
  onFinish: (finish: Finish) => void,
) =>
  Option.match(finish, {
    onNone: () => <InBrowser />,
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
 * done in the web app's settings, so this leaves for the browser and says so.
 */
function InBrowser() {
  const data = useLiveData()
  return (
    <Button
      icon={Link2}
      label="Connect in your browser"
      onPress={() => void Linking.openURL(connectionsAddress(data.session.server))}
    />
  )
}

/**
 * Where a sign-in stands, from this phone's side.
 *
 * - `Still`: nothing is in flight and there is nothing to say.
 * - `Opening`: the Person pressed Sign in, and the server is being asked for the provider's page.
 * - `Away`: that page was handed to the browser and the Person has not come back.
 * - `Checking`: they are back, and the server is being asked whether it went through.
 * - `Unfinished`: the server says the sign-in is still to do. Not an error: people look and leave.
 * - `Refused`: the page could not be opened, or the server would not say; its sentence.
 */
type Trip = Data.TaggedEnum<{
  Still: {}
  Opening: {}
  Away: {}
  Checking: {}
  Unfinished: {}
  Refused: { readonly message: string }
}>
const Trip = Data.taggedEnum<Trip>()

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
 * The address is only ever opened when it is a web page (`signInPage`): handed to a phone as it
 * came, another app's scheme would open that app.
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
  function open(address: string) {
    const page = signInPage(address)
    if (Option.isNone(page)) {
      setTrip(Trip.Refused({ message: `${name}’s sign-in page could not be opened.` }))
      return
    }
    // Said before the browser is asked for, so the card is already listening for the return by
    // the time the app leaves the front.
    setTrip(Trip.Away())
    void Linking.openURL(page.value.href).then(
      () => undefined,
      () =>
        setTrip(
          Trip.Refused({ message: `${name}’s sign-in page could not be opened in your browser.` }),
        ),
    )
  }

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
        <Label size="label" tone="ink-3">
          {name} is not signed in yet.
        </Label>
      )}
      {Trip.$is('Refused')(trip) && <Notice message={trip.message} />}
    </View>
  )
}

/**
 * Hears the Person come back to the app. It draws nothing; being a component is what lets the
 * card listen only while they are away at the provider's page, with no effect to run: the
 * subscription is this view's ref, and it ends when the view goes.
 */
function Returning({ onReturn }: { onReturn: () => void }) {
  const heard = useMemo(() => onForeground(onReturn), [onReturn])
  return <View ref={heard} />
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
