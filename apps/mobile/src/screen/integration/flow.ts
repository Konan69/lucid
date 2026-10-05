import type { VividRpcClient } from '@vivid/client-runtime'
import { ConnectionStep, type Connection, type ConnectionId, type Service } from '@vivid/contracts'
import type { ProductFailure } from '@vivid/state'
import { Option, Result, type Effect } from 'effect'
import { useState } from 'react'
import { commit, warn } from '../../data/haptics'
import { afterPress, type Pressed, type Presses, type PressKey } from '../../data/integration'
import { useLiveData } from '../../data/live'
import { confirmDestructive } from '../../ui/ui'
import type { Keying } from './Key'
import { showSignIn } from './Trip'

/** The sign-in the Person left the app for: whose row says so, and which Integration to ask about. */
interface Away {
  readonly key: PressKey
  readonly id: ConnectionId
}

/** The key form that is open: what it asks for, and whose row hears that it was taken. */
interface Asking {
  readonly key: PressKey
  readonly keying: Keying
}

/** One question put to the server whose answer is what an Integration needs next. */
type Ask = (client: VividRpcClient['Service']) => Effect.Effect<ConnectionStep, ProductFailure>

/**
 * Everything the Integrations sheet does to an Integration: start one from the catalog, pick one
 * up where it stopped, hear the Person come back from a provider's page, and disconnect one. The
 * sheet draws what this holds and holds nothing of its own.
 *
 * It is the web's flow (`begin` and `follow` in `apps/web/src/screen/integration/begin.ts`, and
 * `connect`, `resume` and `disconnect` in `apps/web/src/screen/settings/Connections.tsx`), with
 * the phone's differences:
 *
 * - There is no tab to open ahead of the answer and so nothing to be blocked: the provider's page
 *   is handed to the phone's browser once the server has said where it is (`showSignIn`).
 * - The app leaves the front for that page, so when the Person comes back the server is asked
 *   where the Integration stands (`returned`), exactly as the card in a Thread does. Only one
 *   sign-in can be away at a time, because there is only one front.
 * - Disconnecting asks first, with the system's own alert.
 */
export function useFlow() {
  const data = useLiveData()
  const [presses, setPresses] = useState<Presses>(new Map())
  const [asking, setAsking] = useState<Option.Option<Asking>>(Option.none())
  const [away, setAway] = useState<Option.Option<Away>>(Option.none())
  const [refused, setRefused] = useState<Option.Option<string>>(Option.none())

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
        // The key form is the answer; the row goes back to how it was.
        mark(key, Option.none())
        setAsking(
          Option.some({
            key,
            keying: { id: connection.id, name: connection.serviceName, fields },
          }),
        )
      },
      Done: () => mark(key, Option.some('connected')),
    })

  /** One press, from its first word to what the server made of it. */
  async function press(key: PressKey, ask: Ask) {
    // One Integration is begun at a time: nothing is pressed while a press is still on its way to
    // the server, this row's or another's. Two answers arriving together used to be able to ask
    // for two keys at once, with one form between them.
    if ([...presses.values()].includes('starting')) return
    // Felt as the Person commits, not when the answer comes back.
    commit()
    setRefused(Option.none())
    mark(key, Option.some('starting'))
    const result = await data.change(ask)
    if (Result.isFailure(result)) {
      mark(key, Option.some('refused'))
      return
    }
    settle(key, result.success)
  }

  /** Removes an Integration once the Person has said yes; a refusal is said in the sheet. */
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
    asking,
    /** Whether the Person is away at a provider's page, which is when the return is listened for. */
    away: Option.isSome(away),
    /** The one sentence about something that did not happen, shown at the top of the sheet. */
    refused,

    /** Starts an Integration with a service from the catalog, for this Person or their Company. */
    connect: (service: Service, shared: boolean) =>
      void press(service.id, (client) =>
        client.BeginConnection({
          service: service.id,
          // An Integration's label is at most 40 characters; the service's name is the default.
          label: service.name.slice(0, 40),
          shared,
        }),
      ),

    /**
     * Picks an Integration up where it stopped: the provider's page was left, the key was never
     * entered, or the sign-in lapsed. It is the same Integration afterwards, not a second one.
     */
    resume: (connection: Connection) =>
      void press(connection.id, (client) => client.ResumeConnection({ id: connection.id })),

    /**
     * The Person is back from the provider's page. The server is asked where the Integration
     * stands with the call that began the trip (`ResumeConnection`); it is the same Integration
     * afterwards. A sign-in that is still to do is not an error, people look and leave: the row
     * says nothing more, and the list above shows it as not finished with a way to finish it.
     */
    returned: async () => {
      if (Option.isNone(away)) return
      const { key, id } = away.value
      setAway(Option.none())
      mark(key, Option.some('checking'))
      const result = await data.change((client) => client.ResumeConnection({ id }))
      if (Result.isFailure(result) || ConnectionStep.guards.OpenSignIn(result.success)) {
        mark(key, Option.none())
        return
      }
      settle(key, result.success)
    },

    /** The key form was closed, taken or not. */
    closeKey: () => setAsking(Option.none()),

    /** The service took the key: the row that asked for it says so. */
    keyed: () => {
      if (Option.isSome(asking)) mark(asking.value.key, Option.some('connected'))
    },

    /** Asks before disconnecting: Vivid stops being able to use the account at once. */
    disconnect: (connection: Connection) =>
      confirmDestructive({
        title: `Disconnect ${connection.serviceName}?`,
        detail: 'Vivid will stop using this account. You can connect it again whenever you like.',
        action: 'Disconnect',
        onConfirm: () => void remove(connection),
      }),
  }
}

/** What the sheet is handed to act with. */
export type Flow = ReturnType<typeof useFlow>
