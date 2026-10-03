import { ConnectionStep, type Service } from '@vivid/contracts'
import { Data, Result } from 'effect'
import { change } from '../../data/live'
import type { Keying } from './Key'
import { showSignIn } from './signin'

/**
 * Where connecting a service stands after one press, for whichever screen pressed it. Settings,
 * the card in a Thread and the first screen all start an Integration the same way and differ only
 * in how they say what happened, so the flow is here once and the words stay with each screen.
 *
 * - `SigningIn`: the provider's page is open in its own tab; the live list says when it is done.
 * - `NeedsKey`: the service wants a key, to be collected by `EnterKey`.
 * - `Connected`: nothing more was needed.
 * - `Blocked`: the browser would not open the sign-in tab (pop-ups are off for this page).
 * - `Refused`: the server did not begin it.
 */
export type Began = Data.TaggedEnum<{
  SigningIn: {}
  NeedsKey: { readonly keying: Keying }
  Connected: {}
  Blocked: {}
  Refused: {}
}>
export const Began = Data.taggedEnum<Began>()

/**
 * Does what a Connection says comes next. `tab` is a tab the caller already opened inside the
 * click, when it knew a sign-in was coming; with none, one is opened here, which a browser still
 * allows for a few seconds after the click.
 */
export function follow(step: ConnectionStep, tab: Window | null): Began {
  return ConnectionStep.match(step, {
    // Each branch is annotated: the first branch's variant would otherwise be taken as the
    // answer of every branch.
    // The provider's page is shown in its own tab; this page hears that it finished through the
    // live list of Connections and needs nothing back from that tab.
    OpenSignIn: ({ address }): Began => {
      const target = tab === null ? window.open('about:blank', '_blank') : tab
      return showSignIn(target, address) ? Began.SigningIn() : Began.Blocked()
    },
    EnterKey: ({ connection, fields }): Began => {
      if (tab !== null) tab.close()
      return Began.NeedsKey({
        keying: { id: connection.id, name: connection.serviceName, fields },
      })
    },
    Done: (): Began => {
      if (tab !== null) tab.close()
      return Began.Connected()
    },
  })
}

/** Starts a Connection to a service from the catalog, for this Person or for their Company. */
export async function begin(
  service: Pick<Service, 'id' | 'name'>,
  tab: Window | null,
  shared: boolean,
): Promise<Began> {
  const result = await change((client) =>
    client.BeginConnection({
      service: service.id,
      // A Connection's label is at most 40 characters; the service's name is the default one.
      label: service.name.slice(0, 40),
      shared,
    }),
  )
  if (Result.isFailure(result)) {
    if (tab !== null) tab.close()
    return Began.Refused()
  }
  return follow(result.success, tab)
}
