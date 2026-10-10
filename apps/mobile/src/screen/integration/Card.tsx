import { ConnectionAuthorization, type ConnectionRequestMessage } from '@vivid/contracts'
import {
  answered,
  answering,
  Awaited,
  awaitedWords,
  CardPress,
  cardPress,
  type connecting,
} from '@vivid/state'
import { Option } from 'effect'
import { View } from 'react-native'
import { Check, ExternalLink, KeyRound, Link2, type LucideIcon } from 'lucide-react-native'
import { commit } from '../../data/haptics'
import { cardSaid, type Authorization } from '../../data/integration'
import { useLiveData, useLiveValue } from '../../data/live'
import { useTheme } from '../../theme'
import { ServiceMark } from '../../ui/Mark'
import { Button, EDGE, Label, Notice, radius } from '../../ui/ui'
import { useGo } from '../../workspace'
import { useFlow } from './flow'

/**
 * Vivid needs a service to go on. The card says why in Vivid's own words and finishes the job
 * where the Person already is.
 *
 * A service Vivid only offered from the catalogue is connected by the card's own button, right
 * here in the Thread; it used to open the whole Integrations page over the Thread, where the
 * Person had to find the service again. An Integration Vivid has already begun adding carries
 * what is left (`authorization`): a sign-in, which opens the provider's page in the phone's
 * browser, or a key, which is typed into a sheet that sends it straight to the Integration
 * (never into the Thread, never to Vivid). The card names the Integration and nothing more: the
 * sign-in address itself is asked of the server when it is opened, and is never read from the
 * Thread.
 *
 * The card keeps nothing of its own. Every press goes through the shell's one flow to the
 * session's connecting machine (`data/connecting.ts`) with the tool call the card stands for,
 * and the card draws where its own attempt stands (`flow.standingOfCard`). It used to make the
 * sign-in trip itself, in its own state set after each answer, beside the flow's copy of the same
 * trip; an answer that came late was written onto whatever the card showed by then.
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
 * Adapted from the web's card (`ConnectionCard` in `apps/web/src/screen/thread/Cards.tsx`).
 */
export function IntegrationCard({
  id,
  request,
  authorization,
  awaited,
  current,
  onContinue,
}: {
  /** The tool call this card stands for, which names its attempt and its one "carry on". */
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
  const go = useGo()
  const { colors: c } = useTheme()
  const connections = useLiveValue(data.live.connections)
  const list = Option.match(connections, { onNone: () => [], onSome: (value) => value.connections })
  const words = awaitedWords(awaited, request.serviceName)
  // A request for one more account is never ready when it is made, whatever the card was told.
  const ready =
    (Awaited.$is('Service')(awaited) && request.ready) || answered(list, request, awaited)
  // What one press does. An Integration Vivid began is picked up, whatever it is waiting for:
  // the server says afresh whether that is a sign-in or a key, and the machine opens whichever
  // it is. Otherwise it is decided from the list as it stands at the press (`cardPress`).
  const next = Option.match(authorization, {
    onNone: () => cardPress(list, request, awaited),
    onSome: (begun) => CardPress.Resume({ id: begun.connectionId }),
  })

  /**
   * One press. The card leaves what it is owed, then presses with the tool call it stands for:
   * when the attempt that carries it ends in an account the Thread goes on by itself, as on the
   * web, and only for a press made here. A card that is merely read again tomorrow says nothing
   * for the Person, and "Carry on" stays on it as the way to do that by hand.
   */
  const press = () => {
    flow.owe(id, (connected) => {
      // Only the account this card asked for carries its Thread on, and it is named, so Vivid
      // does not have to guess which of several accounts is the new one.
      const account = answering([connected], request, awaited)
      if (Option.isSome(account)) onContinue(words.carryOn(account))
    })
    CardPress.$match(next, {
      Resume: ({ id: begun }) => flow.resume(begun, Option.some(id)),
      // The Person's own account: a card never adds one for a whole Company. The form begins
      // the account for this card, so what the card is owed is that press's to answer.
      Name: () =>
        go.navigate('NameAccount', {
          service: request.service,
          serviceName: request.serviceName,
          shared: false,
          card: id,
        }),
      Begin: () => flow.add(request.service, false, Option.none(), Option.some(id)),
    })
  }

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
            // The live list can say the account is ready before the attempt that connected it
            // has said so. That attempt must not then say "carry on" a second time.
            flow.carriedOn(id)
            // One more account is named by the account that was added, so Vivid does not have to
            // guess which of several is new.
            onContinue(words.carryOn(answering(list, request, awaited)))
          }}
        />
      )}
      {ready && !current && <Settled />}
      {!ready && (
        <Press
          way={wayIn(authorization, awaited)}
          serviceName={request.serviceName}
          said={flow.standingOfCard(id)}
          busy={flow.busy}
          current={current}
          onPress={press}
          onGiveUp={(message) => {
            // It says something in the Thread, and sending is felt.
            commit()
            // A carry-on made by hand: nothing is owed for it by an attempt.
            flow.carriedOn(id)
            onContinue(message)
          }}
        />
      )}
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

/** The card's button as it stands before anything is pressed, and its word for its first wait. */
interface Way {
  readonly kind: 'primary' | 'plain'
  readonly icon: LucideIcon
  readonly label: string
  /** What the button says while the server is first asked. */
  readonly starting: string
}

/**
 * What the card offers, from what is known to be left. An Integration Vivid began says what it
 * wants (a sign-in, a key) and leads with it; a service Vivid only offered is connected, or, when
 * the card asked for one more account, added to.
 */
const wayIn = (authorization: Option.Option<Authorization>, awaited: Awaited): Way =>
  Option.match(authorization, {
    onNone: (): Way => ({
      kind: 'plain',
      icon: Link2,
      label: Awaited.$is('Another')(awaited) ? 'Add account' : 'Connect',
      starting: 'Connecting…',
    }),
    onSome: (begun) =>
      ConnectionAuthorization.match(begun, {
        OpenSignIn: (): Way => ({
          kind: 'primary',
          icon: ExternalLink,
          label: 'Sign in',
          starting: 'Opening…',
        }),
        EnterKey: (): Way => ({
          kind: 'primary',
          icon: KeyRound,
          label: 'Enter key',
          starting: 'Opening…',
        }),
      }),
  })

/**
 * The one thing to press on a card that is not ready, and what its attempt has to say. It is the
 * same button and the same press at every point of an attempt; what changes is what it says
 * (`cardSaid`, from where the machine stands). It holds nothing itself.
 *
 * The one exception is an attempt pressing again cannot mend (the service did not take the key):
 * the button is then "Carry on", which tells Vivid what happened. It is offered only while the
 * Thread is waiting on this card, so the same words are not sent a second time.
 */
function Press({
  way,
  serviceName,
  said,
  busy,
  current,
  onPress,
  onGiveUp,
}: {
  way: Way
  /** The service's name, for the sentence about a sign-in that was not finished. */
  serviceName: string
  /** Where this card's own attempt stands. */
  said: connecting.Standing
  /** Whether nothing can be pressed for now: the server is being asked, here or anywhere. */
  busy: boolean
  /** Whether the Thread is waiting on this card. */
  current: boolean
  onPress: () => void
  /** Carries the Thread on with what happened, when the attempt cannot be made again here. */
  onGiveUp: (message: string) => void
}) {
  const { button, line, carryOn } = cardSaid(said, { starting: way.starting, serviceName })
  return (
    <View style={{ gap: 8 }}>
      {Option.isNone(carryOn) && (
        <Button
          kind={way.kind}
          icon={way.icon}
          label={Option.getOrElse(button, () => way.label)}
          // One press at a time, anywhere: nothing is begun while the server is still being
          // asked, about this card's account or another's. The machine refuses it as well.
          disabled={busy}
          onPress={onPress}
        />
      )}
      {/* Not a press on the machine, so it does not wait for one; and never the card's own way
          in, which would pick up an account the server refuses. */}
      {Option.isSome(carryOn) && current && (
        <Button
          kind="primary"
          label={Option.getOrElse(button, () => 'Carry on')}
          onPress={() => onGiveUp(carryOn.value)}
        />
      )}
      {/* What did not happen is said as every refusal on a card is; the rest is a quiet line. */}
      {Option.isSome(line) && line.value.urgent && <Notice message={line.value.words} />}
      {Option.isSome(line) && !line.value.urgent && (
        <Label accessibilityLiveRegion="polite" size="label" tone="ink-2">
          {line.value.words}
        </Label>
      )}
    </View>
  )
}
