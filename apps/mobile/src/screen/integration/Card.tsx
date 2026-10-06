import { ConnectionStep, type ConnectionId, type ConnectionRequestMessage } from '@vivid/contracts'
import { answered, answering, Awaited, awaitedWords, CardPress, cardPress } from '@vivid/state'
import { Option, Result } from 'effect'
import { useState } from 'react'
import { View } from 'react-native'
import { Check, ExternalLink, KeyRound, Link2 } from 'lucide-react-native'
import { commit } from '../../data/haptics'
import {
  CARD_PRESSED,
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
import { useGo } from '../../workspace'
import { useFlow } from './flow'
import { Returning, showSignIn, Trip } from './Trip'

/**
 * Vivid needs a service to go on. The card says why in Vivid's own words and finishes the job
 * where the Person already is.
 *
 * A service Vivid only offered from the catalogue is connected by the card's own button, right
 * here in the Thread (`Connect`); it used to open the whole Integrations page over the Thread,
 * where the Person had to find the service again. An Integration Vivid has already begun adding
 * carries what is left (`authorization`): a sign-in, which opens the provider's page in the phone's browser and
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
 * "Add account" although the service is already connected.
 *
 * Adapted from the web's card (`ConnectionCard` and `Finish` in
 * `apps/web/src/screen/thread/Cards.tsx`).
 */
export function IntegrationCard({
  id,
  request,
  authorization,
  awaited,
  current,
  onContinue,
}: {
  /** The tool call this card stands for, which names its one "carry on" in the flow. */
  id: string
  request: ConnectionRequestMessage
  /** What finishing it takes, when Vivid has already begun adding it. */
  authorization: Option.Option<Authorization>
  awaited: Awaited
  /** Whether this is the newest thing in the Thread and Vivid has stopped to wait for it. */
  current: boolean
  onContinue: (message: string) => void
}) {
  const data = useLiveData()
  const flow = useFlow()
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
      {ready && current && (
        // Reached when the account was connected somewhere else (the Integrations page, another
        // device), where no press here was waiting for it; a press here carries on by itself.
        <Button
          kind="primary"
          label="Carry on"
          onPress={() => {
            // It says something in the Thread, and sending is felt.
            commit()
            // The live list can say the account is ready before the press that connected it has
            // heard so. That press must not then say "carry on" a second time.
            flow.forget(id)
            // One more account is named by the account that was added, so Vivid does not have to
            // guess which of several is new.
            onContinue(
              words.carryOn(
                Option.flatMap(connections, (value) =>
                  answering(value.connections, request, awaited),
                ),
              ),
            )
          }}
        />
      )}
      {ready && !current && <Settled />}
      {!ready &&
        left({
          id,
          request,
          awaited,
          finish,
          onFinish: (next) => setLatest(Option.some(next)),
          onContinue,
        })}
    </View>
  )
}

/**
 * The settled fact, on a card the Thread has moved on from: the account is connected and there is
 * nothing left to press. It was a primary "Carry on" on every answered card, however old, so a
 * card Vivid had already carried on from still asked to be pressed, and pressing it said "carry
 * on" a second time. The web's card says the same thing the same way (`ConnectionAction` in
 * `apps/web/src/screen/thread/Cards.tsx`).
 */
function Settled() {
  const { colors: c } = useTheme()
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
      <Check pointerEvents="none" size={16} strokeWidth={2} color={c['status-success']} />
      <Label size="label" tone="ink-2">
        Connected
      </Label>
    </View>
  )
}

/**
 * The one thing left to do to connect it: sign in, give it a key, or connect it from here. A
 * projection of what is left onto the control that advances it; it holds nothing itself.
 */
const left = ({
  id,
  request,
  awaited,
  finish,
  onFinish,
  onContinue,
}: {
  id: string
  request: ConnectionRequestMessage
  awaited: Awaited
  finish: Option.Option<Finish>
  /** The server has said what is left now. */
  onFinish: (finish: Finish) => void
  onContinue: (message: string) => void
}) =>
  Option.match(finish, {
    onNone: () => <Connect id={id} request={request} awaited={awaited} onContinue={onContinue} />,
    onSome: (next) =>
      Finish.$match(next, {
        SignIn: ({ id: connection }) => (
          <SignIn id={connection} name={request.serviceName} onFinish={onFinish} />
        ),
        Key: ({ id: connection, fields }) => (
          <Key id={connection} name={request.serviceName} fields={fields} />
        ),
        // A card that is done is drawn as "Carry on"; there is nothing left to offer.
        Done: () => null,
      }),
  })

/**
 * A service Vivid offered and has not begun adding, connected from the card. The press is the
 * web card's (`connect` in `ConnectionCard`, `apps/web/src/screen/thread/Cards.tsx`), through the
 * shell's one flow, so the provider's page, the key form and the way back are the same ones the
 * Integrations page uses and nothing is opened over the Thread but what the account needs:
 *
 * - an Integration that was begun for this card and left unfinished is picked up, not begun twice;
 * - one more account on a service that does not say who signs in is named first, in a bottom
 *   sheet over the Thread, which then begins it;
 * - anything else is begun at once.
 *
 * Which of the three it is, is decided from the list as it stands at the press (`cardPress`).
 *
 * Carrying on by itself: the card leaves a wish under its own name (`flow.onceConnected`, the
 * tool call it stands for) and hands that name to the press, and the flow, which is told how
 * every press it began ends, calls the wish once when a press that carried this card ends in a
 * connected account (`data/wish.ts`). A press from anywhere else never answers it. So the Thread goes on the moment the sign-in is finished, as on the web
 * (`carryOnOnceReady`), and only for a press made here: a card that is merely read again tomorrow
 * says nothing for the Person, and "Carry on" stays on it as the way to do that by hand. Nothing
 * is listened to and no effect runs. The flow drops the wish after ten minutes, the web's limit.
 */
function Connect({
  id,
  request,
  awaited,
  onContinue,
}: {
  /** The tool call the card stands for: whose wish this is, and whose press. */
  id: string
  request: ConnectionRequestMessage
  awaited: Awaited
  onContinue: (message: string) => void
}) {
  const data = useLiveData()
  const flow = useFlow()
  const go = useGo()
  const connections = useLiveValue(data.live.connections)
  const press = cardPress(
    Option.match(connections, { onNone: () => [], onSome: (value) => value.connections }),
    request,
    awaited,
  )
  // What the flow files this press under: the Integration it picks up, or the service it begins on.
  const key = CardPress.$is('Resume')(press) ? press.id : request.service
  // A press that began on the service is still filed there once its account is in the list and
  // the next press would pick that account up, so both are looked under.
  const pressed = Option.orElse(Option.fromUndefinedOr(flow.presses.get(key)), () =>
    Option.fromUndefinedOr(flow.presses.get(request.service)),
  )
  const said = Option.map(pressed, (value) => CARD_PRESSED[value])
  const waiting = Option.flatMap(said, (words) => words.button)
  const line = Option.flatMap(said, (words) => words.line)

  const connect = () => {
    const words = awaitedWords(awaited, request.serviceName)
    flow.onceConnected(id, (connected) => {
      // Only the account this card asked for carries its Thread on, and it is named, so Vivid
      // does not have to guess which of several accounts is the new one.
      const account = answering([connected], request, awaited)
      if (Option.isSome(account)) onContinue(words.carryOn(account))
    })
    CardPress.$match(press, {
      Resume: ({ id: begun }) => flow.resume(begun, Option.some(id)),
      // The Person's own account: a card never adds one for a whole Company.
      Name: () =>
        go.navigate('NameAccount', {
          service: request.service,
          serviceName: request.serviceName,
          shared: false,
          // The form begins the account for this card, so the card's wish is its to answer.
          card: id,
        }),
      Begin: () => flow.add(request.service, false, Option.none(), Option.some(id)),
    })
  }

  return (
    <View style={{ gap: 8 }}>
      <Button
        icon={Link2}
        label={Option.getOrElse(waiting, () =>
          Awaited.$is('Another')(awaited) ? 'Add account' : 'Connect',
        )}
        // One press at a time, anywhere: nothing is begun while the server is still being asked,
        // about this card's account or another's (`flow.busy`), or while this one is checked.
        disabled={flow.busy || Option.isSome(waiting)}
        onPress={connect}
      />
      {/* What did not happen is said as every refusal on a card is; the rest is a quiet line. */}
      {Option.isSome(line) && Option.contains(pressed, 'refused') && (
        <Notice message={line.value} />
      )}
      {Option.isSome(line) && !Option.contains(pressed, 'refused') && (
        <Label accessibilityLiveRegion="polite" size="label" tone="ink-2">
          {line.value}
        </Label>
      )}
    </View>
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
 * shared with the Integrations page.
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

/**
 * Giving the service its key, for an Integration Vivid already began. The form is the stack's
 * `Key` sheet, opened over the Thread; the card itself never holds what is typed. The press is
 * filed under the Integration, which is what there is to file it under: nothing was begun from
 * here. That the key was taken is read from the live list, as every other way of connecting is.
 */
function Key({ id, name, fields }: { id: ConnectionId; name: string; fields: KeyFields }) {
  const go = useGo()
  return (
    <Button
      kind="primary"
      icon={KeyRound}
      label="Enter key"
      onPress={() => go.navigate('Key', { id, name, fields, press: id })}
    />
  )
}
