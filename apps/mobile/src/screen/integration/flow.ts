import type { VividRpcClient } from '@vivid/client-runtime'
import {
  ConnectionStep,
  type AccountName,
  type Connection,
  type ConnectionId,
  type Service,
} from '@vivid/contracts'
import type { ProductFailure } from '@vivid/state'
import { Option, Result, type Effect } from 'effect'
import { createContext, useContext, useRef, useState } from 'react'
import { commit, warn } from '../../data/haptics'
import {
  afterPress,
  inFlight,
  type Pressed,
  type Presses,
  type PressKey,
} from '../../data/integration'
import { useLiveData } from '../../data/live'
import {
  bind,
  forget,
  leave,
  refused as unanswered,
  settled,
  type Wish,
  type Wishes,
} from '../../data/wish'
import { confirmDestructive } from '../../ui/ui'
import type { Routes } from '../../workspace'
import { HERE, showSignIn } from './Trip'

/** The sign-in the Person left the app for: whose row says so, and which Integration to ask about. */
interface Away {
  readonly key: PressKey
  readonly id: ConnectionId
}

/** How long a press is waited on to end in a connected account before its wish lapses, in ms. */
const WISH_MS = 10 * 60_000

/**
 * Opens the form for a service that takes a key (the `Key` route), and answers whether it could.
 * It is handed to the flow because the flow is held outside the navigator, which is what lets a
 * card, a page and a sheet share it.
 */
export type ShowKey = (asked: Routes['Key']) => boolean

/** One question put to the server whose answer is what an Integration needs next. */
type Ask = (client: VividRpcClient['Service']) => Effect.Effect<ConnectionStep, ProductFailure>

/**
 * Gives an account the Person's own name for it, or takes that name away with none. It answers
 * with nothing when the name was saved, or with the sentence to show when it was not. Nothing is
 * asked of the service: the name is Vivid's own.
 */
const renameWith =
  (data: ReturnType<typeof useLiveData>) =>
  async (
    connection: Connection,
    name: Option.Option<AccountName>,
  ): Promise<Option.Option<string>> => {
    const result = await data.change((client) =>
      client.RenameConnection({ id: connection.id, name: Option.getOrNull(name) }),
    )
    return Result.isFailure(result)
      ? Option.some('That name was not saved. Try again.')
      : Option.none()
  }

/**
 * The wishes cards have left, held for the flow between two steps of `data/wish.ts`, which is
 * where what happens to them is decided. They are acted on, never drawn, so they are a ref and
 * not state: nothing redraws when one is left.
 */
function useWishes() {
  const held = useRef<Wishes>(new Map())
  return {
    leave: (card: string, go: Wish['go']) => {
      held.current = leave(held.current, card, { until: Date.now() + WISH_MS, go })
    },
    bind: (card: string, key: PressKey) => {
      held.current = bind(held.current, card, key)
    },
    forget: (card: string) => {
      held.current = forget(held.current, card)
    },
    refused: (key: PressKey) => {
      held.current = unanswered(held.current, key)
    },
    /**
     * A press ended in a connected account: each card whose press it was gets its wish, once. One
     * that waited longer than `WISH_MS` is dropped unanswered, as the web's listener gives up: by
     * then the Person has moved on, and the card's own "Carry on" is still there to press.
     */
    fulfil: (key: PressKey, connected: Connection) => {
      const { call, rest } = settled(held.current, key, Date.now())
      held.current = rest
      for (const wish of call) wish.go(connected)
    },
  }
}

/**
 * Everything the phone app does to an Integration: start one, pick one up where it stopped, hear
 * the Person come back from a provider's page, name one and disconnect one. It is held once for
 * the signed-in shell (`FlowProvider`, `Provider.tsx`) and read with `useFlow`, so the
 * Integrations page, an account's sheet, the form that names a new account and the card in a
 * Thread all act through the same one: an account begun from a card is heard coming back even
 * though the card is not what is in front, and only one can be begun at a time anywhere.
 *
 * It is the web's flow (`begin` and `follow` in `apps/web/src/screen/integration/begin.ts`, and
 * `connect`, `resume` and `disconnect` in `apps/web/src/screen/settings/Connections.tsx`), with
 * the phone's differences:
 *
 * - There is no tab to open ahead of the answer and so nothing to be blocked: the provider's page
 *   is handed to the phone's browser once the server has said where it is (`showSignIn`).
 * - The app leaves the front for that page, so when the Person comes back the server is asked
 *   where the Integration stands (`returned`). Only one sign-in can be away at a time, because
 *   there is only one front.
 * - Disconnecting asks first, with the system's own alert.
 * - Which account's sheet is open, and which account is being named, is not held here: each is a
 *   route on the stack (`Account`, `NameAccount`), where the web uses a popover and a dialog.
 * - The form for a service that takes a key is a route too (`Key`). This flow is held outside the
 *   navigator, so it is handed the way to open it (`showKey`) and holds no form of its own.
 *
 * The web's card listens to the live list for the account it asked for (`carryOnOnceReady`,
 * `apps/web/src/screen/thread/Cards.tsx`). Here the press itself is what is followed: this flow
 * began it and is told how it ends, so a card leaves a wish with its press (`onceConnected`) and
 * no list is subscribed to and no effect runs.
 */
export function useFlowHeld(showKey: ShowKey) {
  const data = useLiveData()
  const [presses, setPresses] = useState<Presses>(new Map())
  const [away, setAway] = useState<Option.Option<Away>>(Option.none())
  const [refused, setRefused] = useState<Option.Option<string>>(Option.none())
  const wishes = useWishes()
  // One Integration is begun at a time: a press is on its way to the server, this row's or
  // another's. Two answers arriving together used to be able to ask for two keys at once.
  const busy = [...presses.values()].includes('starting')

  /** Keeps where one press stands beside the row that was pressed. */
  const mark = (key: PressKey, pressed: Option.Option<Pressed>) =>
    setPresses((before) => afterPress(before, key, pressed))

  /** Does what an Integration says comes next, and says it on the row that was pressed. */
  const settle = (key: PressKey, step: ConnectionStep) =>
    ConnectionStep.match(step, {
      OpenSignIn: ({ connection, address }) =>
        showSignIn(address, connection.serviceName, {
          away: () => {
            mark(key, Option.some('waiting'))
            setAway(Option.some({ key, id: connection.id }))
          },
          refused: (message) => {
            setAway(Option.none())
            mark(key, Option.some('refused'))
            setRefused(Option.some(message))
          },
        }),
      EnterKey: ({ connection, fields }) => {
        // The key form is the answer; the row goes back to how it was. A press comes from a
        // screen, so the navigator is there to show the form; were it ever not, the press is
        // said to have failed where it was made, never dropped in silence.
        const shown = showKey({
          id: connection.id,
          name: connection.serviceName,
          fields,
          press: key,
        })
        mark(key, shown ? Option.none() : Option.some('refused'))
        if (!shown) wishes.refused(key)
      },
      Done: ({ connection }) => {
        mark(key, Option.some('connected'))
        wishes.fulfil(key, connection)
      },
    })

  /** One press, from its first word to what the server made of it. */
  async function press(key: PressKey, ask: Ask, card: Option.Option<string>) {
    // Nothing is pressed while a press is still on its way. The buttons that begin an account
    // are disabled by the same fact (`busy`), so this is the guard behind them.
    if (busy) return
    // Only now is the card's wish this press's to answer: a press that was not let through
    // binds nothing, and what it would have begun cannot carry a Thread on.
    if (Option.isSome(card)) wishes.bind(card.value, key)
    // Felt as the Person commits, not when the answer comes back.
    commit()
    setRefused(Option.none())
    mark(key, Option.some('starting'))
    const result = await data.change(ask)
    if (Result.isFailure(result)) {
      mark(key, Option.some('refused'))
      // Nothing was begun, so there is nothing to wait on; pressing again leaves the wish again.
      wishes.refused(key)
      return
    }
    settle(key, result.success)
  }

  /**
   * Begins one account on a service, under the Person's name for it when they gave one. `card` is
   * the card in a Thread whose press this is, when it is one.
   */
  const begin = (
    service: Service['id'],
    shared: boolean,
    name: Option.Option<AccountName>,
    card: Option.Option<string>,
  ) =>
    void press(
      service,
      (client) =>
        client.BeginConnection({ service, name: Option.getOrNull(name), shared, from: HERE }),
      card,
    )

  /** Removes an Integration once the Person has said yes; a refusal is said on the page. */
  async function remove(connection: Connection) {
    warn()
    setRefused(Option.none())
    const result = await data.change((client) => client.RemoveConnection({ id: connection.id }))
    if (Result.isFailure(result)) {
      setRefused(Option.some(`${connection.serviceName} could not be disconnected. Try again.`))
      return
    }
    // What an earlier press left on this account's row and on its service's row ("Connected") is
    // no longer true; the live list is what says how they stand now.
    mark(connection.id, Option.none())
    mark(connection.service, Option.none())
  }

  return {
    presses,
    /** A press is on its way to the server, anywhere: nothing else can be begun until it answers. */
    busy,
    /** Whether the Person is away at a provider's page, which is when the return is listened for. */
    away: Option.isSome(away),
    /** The one sentence about something that did not happen, shown at the top of the page. */
    refused,

    /**
     * Begins one account on a service, for this Person or their Company, under the name the
     * Person gave when they did. Whether a name has to be asked for first is the caller's to
     * decide (`asksName`, `cardPress`) and to ask (`NameAccount`): this begins.
     */
    add: begin,

    rename: renameWith(data),

    /**
     * Picks an Integration up where it stopped: the provider's page was left, the key was never
     * entered, or the sign-in lapsed. It is the same Integration afterwards, not a second one.
     */
    resume: (id: ConnectionId, card: Option.Option<string>) =>
      void press(id, (client) => client.ResumeConnection({ id, from: HERE }), card),

    /**
     * Leaves a card's wish: `go` is called once, with the account, when a press that carries
     * this card (`add` or `resume` handed the same `card`) ends connected, whether at once, on
     * the way back from the provider's page, or when its key is taken. It lapses after ten
     * minutes. `card` is the tool call the card stands for. Until a press carries the card the
     * wish answers to nothing, so a name form that is dismissed leaves nothing behind that
     * another press could set off.
     */
    onceConnected: wishes.leave,

    /** The Person carried on by hand from this card: its wish must not say it a second time. */
    forget: wishes.forget,

    /**
     * Forgets what finished presses left said on their rows ("Connected", "Did not start"), and
     * the sentence at the top of the page. The page calls it as it is opened: these were this
     * flow's words about an earlier visit, or about a card in a Thread, and the live list is what
     * says how things stand now. A press that is still on its way keeps its words.
     */
    rest: () => {
      setRefused(Option.none())
      setPresses(inFlight)
    },

    /**
     * The Person is back from the provider's page. The server is asked where the Integration
     * stands with the call that began the trip (`ResumeConnection`); it is the same Integration
     * afterwards. A sign-in that is still to do is not an error, people look and leave: the row
     * says nothing more, and the list shows it as not finished with a way to finish it.
     */
    returned: async () => {
      if (Option.isNone(away)) return
      const { key, id } = away.value
      setAway(Option.none())
      mark(key, Option.some('checking'))
      const result = await data.change((client) => client.ResumeConnection({ id, from: HERE }))
      if (Result.isFailure(result) || ConnectionStep.guards.OpenSignIn(result.success)) {
        mark(key, Option.none())
        return
      }
      settle(key, result.success)
    },

    /**
     * The service took the key (the `Key` route says so): the row or card whose press asked for
     * it, filed under `key`, says connected, and its wish is answered.
     */
    keyed: (key: PressKey, connected: Connection) => {
      mark(key, Option.some('connected'))
      wishes.fulfil(key, connected)
    },

    /**
     * Asks before disconnecting: Vivid stops being able to use the account at once. `onYes` is
     * called as the Person agrees, before the server is asked, so the account's own sheet can
     * close on an account it has nothing left to show for.
     */
    disconnect: (connection: Connection, onYes: () => void) =>
      confirmDestructive({
        title: `Disconnect ${connection.serviceName}?`,
        detail: 'Vivid will stop using this account. You can connect it again whenever you like.',
        action: 'Disconnect',
        onConfirm: () => {
          onYes()
          void remove(connection)
        },
      }),
  }
}

/** What every surface that acts on an Integration is handed to act with. */
export type Flow = ReturnType<typeof useFlowHeld>

/**
 * The one flow of the signed-in shell. `null` is the value outside the shell, where nothing that
 * acts on an Integration is drawn, as it is for `MeContext` (`workspace.ts`).
 */
export const FlowContext = createContext<Flow | null>(null)

/** The shell's flow: to begin, pick up, name or disconnect an Integration from anywhere in it. */
export function useFlow(): Flow {
  const flow = useContext(FlowContext)
  if (flow === null) throw new Error('This screen is drawn outside the signed-in shell.')
  return flow
}
