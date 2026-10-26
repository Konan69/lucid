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
import { commit } from '../../data/haptics'
import { cardSaid, type Authorization } from '../../data/integration'
import { useLiveData, useLiveValue } from '../../data/live'
import { useTheme } from '../../theme'
import { EDGE, Label, Notice, Press, radius } from '../../ui/ui'
import { useGo } from '../../workspace'
import { useFlow } from './flow'
import { Logo } from './Logo'

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

  // The account's own logo: the one the live list draws for it, else the service's bundled mark.
  const mark = Option.flatMap(
    Option.fromUndefinedOr(list.find((each) => each.service === request.service)),
    (each) => Option.fromNullishOr(each.mark),
  )
  const said = cardSaid(flow.standingOfCard(id), {
    starting: wayIn(authorization, awaited).starting,
    serviceName: request.serviceName,
  })
  const row = rowOf({
    ready,
    current,
    way: wayIn(authorization, awaited),
    said,
    busy: flow.busy,
    onPress: press,
    onCarryOn: () => {
      // It says something in the Thread, and sending is felt.
      commit()
      // The live list can say the account is ready before the attempt that connected it has
      // said so. That attempt must not then say "carry on" a second time.
      flow.carriedOn(id)
      // One more account is named by the account that was added, so Vivid does not have to
      // guess which of several is new.
      onContinue(words.carryOn(answering(list, request, awaited)))
    },
    onGiveUp: (message) => {
      commit()
      // A carry-on made by hand: nothing is owed for it by an attempt.
      flow.carriedOn(id)
      onContinue(message)
    },
  })
  return (
    <View
      style={{
        padding: 12,
        borderRadius: radius.card,
        borderCurve: 'continuous',
        borderWidth: EDGE,
        borderColor: c['border-subtle'],
        backgroundColor: c.screen,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 11 }}>
        <Logo service={request.service} mark={mark} size={36} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <Label numberOfLines={1} size="footnote" style={{ fontWeight: '600' }}>
            {words.title}
          </Label>
          <Label
            accessibilityLiveRegion="polite"
            numberOfLines={1}
            size="label"
            tone={row.tone}
          >
            {row.line}
          </Label>
        </View>
        {Option.isSome(row.action) && <CardButton {...row.action.value} />}
      </View>
      {/* What did not happen is said as every refusal is, under the words it belongs to. */}
      {Option.isSome(said.line) && said.line.value.urgent && (
        <View style={{ marginTop: 10, marginLeft: 47 }}>
          <Notice message={said.line.value.words} />
        </View>
      )}
    </View>
  )
}

/** The one thing a card's row offers: what its button says, how loud it is, and what it does. */
interface Action {
  readonly label: string
  readonly kind: 'primary' | 'quiet'
  readonly disabled: boolean
  readonly onPress: () => void
}

/** A card's one row: the line under the name, its ink, and the button at its end, if any. */
interface Row {
  readonly line: string
  readonly tone: 'ink-2' | 'status-success'
  readonly action: Option.Option<Action>
}

/**
 * What the card's row says and offers, from where the account and this card's attempt stand. One
 * line under the name says the state for the Person; it is never the text Vivid was given (the
 * owner, 26 October 2026: "why is it telling the user to call find tools?"). A settled card has
 * no button: "Connected" says it all, so it carries no dot or check besides.
 */
const rowOf = (card: {
  ready: boolean
  current: boolean
  way: Way
  said: ReturnType<typeof cardSaid>
  busy: boolean
  onPress: () => void
  onCarryOn: () => void
  onGiveUp: (message: string) => void
}): Row => {
  if (card.ready)
    return {
      line: 'Connected',
      tone: 'status-success',
      // Reached when the account was connected somewhere else (the Integrations page, another
      // device), where no press here was waiting for it; a press here carries on by itself.
      action: card.current
        ? Option.some({ label: 'Carry on', kind: 'primary', disabled: false, onPress: card.onCarryOn })
        : Option.none(),
    }
  const { button, line, carryOn } = card.said
  // An attempt pressing again cannot mend: the button tells Vivid what happened instead, and
  // only while the Thread waits on this card, so the words are not sent twice.
  if (Option.isSome(carryOn))
    return {
      line: card.way.line,
      tone: 'ink-2',
      action: card.current
        ? Option.some({
            label: Option.getOrElse(button, () => 'Carry on'),
            kind: 'primary',
            disabled: false,
            onPress: () => card.onGiveUp(carryOn.value),
          })
        : Option.none(),
    }
  return {
    line: Option.match(line, {
      onNone: () => card.way.line,
      // An urgent line is said under the row as a notice; the row keeps the card's own line.
      onSome: (said) => (said.urgent ? card.way.line : said.words),
    }),
    tone: 'ink-2',
    action: Option.some({
      label: Option.getOrElse(button, () => card.way.label),
      kind: card.way.kind,
      // One press at a time, anywhere: nothing is begun while the server is still being asked,
      // about this card's account or another's. The machine refuses it as well.
      disabled: card.busy,
      onPress: card.onPress,
    }),
  }
}

/**
 * The card's button: a 32-point pill at the end of its row, the size the row can hold beside a
 * 36-point logo, with its hit area made up to 44 by slop. The loud one is the primary fill; the
 * quiet one sits on the card's own surface with a hairline.
 */
function CardButton({ label, kind, disabled, onPress }: Action) {
  const { colors: c } = useTheme()
  const primary = kind === 'primary'
  return (
    <Press
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      hitSlop={{ top: 6, bottom: 6, left: 4, right: 4 }}
      onPress={onPress}
      style={({ pressed }) => ({
        height: 32,
        paddingHorizontal: 14,
        borderRadius: 16,
        alignItems: 'center',
        justifyContent: 'center',
        opacity: disabled ? 0.5 : 1,
        borderWidth: primary ? 0 : EDGE,
        borderColor: c['border-subtle'],
        backgroundColor: primary
          ? pressed
            ? c['primary-text']
            : c.primary
          : pressed
            ? c['wash-pressed']
            : c['subtle-strong'],
      })}
    >
      <Label size="label" tone={primary ? 'ink-on-accent' : 'ink'} style={{ fontWeight: '600' }}>
        {label}
      </Label>
    </Press>
  )
}

/** The card's button as it stands before anything is pressed, and its word for its first wait. */
interface Way {
  readonly kind: 'primary' | 'quiet'
  readonly label: string
  /** The line under the name while nothing has been pressed: what finishing it takes. */
  readonly line: string
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
      kind: 'primary',
      label: Awaited.$is('Another')(awaited) ? 'Add account' : 'Connect',
      line: Awaited.$is('Another')(awaited) ? 'Add another account' : 'Not connected yet',
      starting: 'Connecting…',
    }),
    onSome: (begun) =>
      ConnectionAuthorization.match(begun, {
        OpenSignIn: (): Way => ({
          kind: 'primary',
          label: 'Sign in',
          line: 'Sign in to connect',
          starting: 'Opening…',
        }),
        EnterKey: (): Way => ({
          kind: 'primary',
          label: 'Add key',
          line: 'Needs an API key to connect',
          starting: 'Opening…',
        }),
      }),
  })

