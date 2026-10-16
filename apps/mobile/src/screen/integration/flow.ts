import { useAtomValue } from '@effect/atom-react'
import type { AccountName, Connection, ConnectionId, Service } from '@vivid/contracts'
import { connecting } from '@vivid/state'
import { Effect, Option, Result } from 'effect'
import { createContext, useContext, useState } from 'react'
import {
  refusalOf,
  standingFor,
  standingForCard,
  waitingOn,
  type CarryOn,
  type Pressing,
} from '../../data/connecting'
import { commit, warn } from '../../data/haptics'
import { refusalSentence } from '../../data/integration'
import { useLiveData } from '../../data/live'
import { confirmDestructive } from '../../ui/ui'
import { start } from '../../data/app'

/**
 * Gives an account the Person's own name for it, or takes that name away with none. It answers
 * with nothing when the name was saved, or with the sentence to show when it was not. Nothing is
 * asked of the service: the name is Vivid's own.
 */
const renameWith =
  (data: ReturnType<typeof useLiveData>) =>
  (
    connection: Connection,
    name: Option.Option<AccountName>,
  ): Effect.Effect<Option.Option<string>> =>
    data
      .changing((client) =>
        client.RenameConnection({ id: connection.id, name: Option.getOrNull(name) }),
      )
      .pipe(
        Effect.map((result) =>
          Result.isFailure(result)
            ? Option.some('That name was not saved. Try again.')
            : Option.none(),
        ),
      )

/**
 * Everything the phone app does to an Integration: start one, pick one up where it stopped, name
 * one and disconnect one. It is held once for the signed-in shell (`FlowProvider`,
 * `Provider.tsx`) and read with `useFlow`, so the Integrations page, an account's sheet, the form
 * that names a new account and the card in a Thread all act through the same one.
 *
 * Connecting itself is not kept here. It is the session's one machine (`data/connecting.ts`,
 * over `connecting` in `@vivid/state`, the machine the web's screens use through
 * `apps/web/src/data/connecting.ts`): this reads where it stands and presses through it. It used
 * to be `useState` here, set after an `await`, where a return check that answered late wrote
 * over a newer press. So an account begun from a card is heard coming back even though the card
 * is not what is in front, only one can be begun at a time anywhere, and a late answer has
 * nowhere to land.
 *
 * What is the phone's own:
 *
 * - Disconnecting asks first, with the system's own alert.
 * - Which account's sheet is open, and which account is being named, is not held here: each is a
 *   route on the stack (`Account`, `NameAccount`), where the web uses a popover and a dialog.
 * - The form for a service that takes a key is a route too (`Key`), which the machine opens
 *   through the shell (`keyRoute`); this holds no form of its own.
 */
export function useFlowHeld() {
  const data = useLiveData()
  const now = useAtomValue(data.connecting.attempt)
  // Why an account could not be disconnected. It is not part of connecting: nothing waits on it
  // but its own sentence. It is still set after the server answers (`remove`).
  const [unremoved, setUnremoved] = useState<Option.Option<string>>(Option.none())

  /** One press. The haptic is felt as the Person commits, and only for a press that was made. */
  const press = (pressing: Pressing) => {
    setUnremoved(Option.none())
    if (data.connecting.press(pressing)) commit()
  }

  /** Removes an Integration once the Person has said yes; a refusal is said on the page. */
  function remove(connection: Connection) {
    return start(
      Effect.gen(function* () {
        warn()
        setUnremoved(Option.none())
        // What an attempt left said of this account ("Connected") is no longer true; the live list
        // is what says how its row stands now. Said before the server is asked, not after.
        data.connecting.forget(connection.id)
        const result = yield* data.changing((client) =>
          client.RemoveConnection({ id: connection.id }),
        )
        if (Result.isFailure(result)) {
          setUnremoved(
            Option.some(`${connection.serviceName} could not be disconnected. Try again.`),
          )
        }
      }),
    )
  }

  return {
    /** The server is being waited on, anywhere: nothing else can be begun until it answers. */
    busy: waitingOn(now),

    /**
     * The one sentence about something that did not happen, shown at the top of the page: a
     * provider's page that could not be opened, else an account that could not be disconnected.
     */
    refused: Option.orElse(Option.flatMap(refusalOf(now), refusalSentence), () => unremoved),

    /** Where the attempt made on a row stands, by the service or account the row is pressed as. */
    standing: (pressed: connecting.Pressed) => standingFor(now, pressed),

    /** Where the attempt made on a card stands, by the tool call the card stands for. */
    standingOfCard: (card: string) => standingForCard(now, card),

    /**
     * Begins one account on a service, for this Person or their Company, under the name the
     * Person gave when they did. Whether a name has to be asked for first is the caller's to
     * decide (`asksName`, `cardPress`) and to ask (`NameAccount`): this begins. `card` is the
     * card in a Thread whose press this is, when it is one.
     */
    add: (
      service: Service['id'],
      shared: boolean,
      name: Option.Option<AccountName>,
      card: Option.Option<string>,
    ) =>
      press({
        pressed: service,
        asked: connecting.Asked.cases.Begin.make({ service, shared, name }),
        card,
      }),

    /**
     * Picks an Integration up where it stopped: the provider's page was left, the key was never
     * entered, or the sign-in lapsed. It is the same Integration afterwards, not a second one.
     */
    resume: (id: ConnectionId, card: Option.Option<string>) =>
      press({ pressed: id, asked: connecting.Asked.cases.Resume.make({ id }), card }),

    rename: renameWith(data),

    /**
     * Leaves what a card is owed: `carryOn` is called once, with the account, when an attempt
     * that carries this card (`add` or `resume` handed the same `card`) ends connected, whether
     * at once, on the way back from the provider's page, or when its key is taken. The machine
     * stops naming the card ten minutes after the press. See `owing` in `data/connecting.ts`
     * for why leaving it sets nothing off by itself.
     */
    owe: (card: string, carryOn: CarryOn) => data.connecting.owe(card, carryOn),

    /** The Person carried on by hand from this card: its attempt must not say it a second time. */
    carriedOn: (card: string) => data.connecting.carriedOn(card),

    /**
     * Forgets what a finished attempt left said on its row ("Connected", "Did not start"), and
     * the sentence at the top of the page. The row that opens the page calls it: these were words
     * about an earlier visit, or about a card in a Thread, and the live list is what says how
     * things stand now. An attempt that is still under way keeps its words.
     */
    rest: () => {
      setUnremoved(Option.none())
      data.connecting.rest()
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
