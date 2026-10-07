import type { ReactNode } from 'react'
import { FlowContext, useFlowHeld, type ShowKey } from './flow'
import { Returning } from './Trip'

/**
 * Holds the one integration flow for the signed-in shell (`useFlowHeld`, `flow.ts`), and hears
 * the Person come back from a provider's page wherever they are when they do.
 *
 * The flow's state used to live inside the Integrations page, so only that page could begin an
 * account or hear the Person come back; the card in a Thread opened the whole page over the
 * Thread to borrow it. It is mounted around the navigator instead (`Shell`, `App.tsx`), which is
 * built again for each workspace, so a flow never outlives the workspace its accounts belong to.
 *
 * `Returning` is mounted only while a sign-in is away, and draws nothing. It is here once: drawn
 * by each surface that reads the flow, the return would be answered as many times as there were
 * surfaces mounted.
 *
 * Nothing here is a React Native `Modal`. The form for a service that takes a key is a route on
 * the stack, and being outside the navigator this cannot navigate, so the shell hands it the way
 * to open that route (`onKey`).
 */
export function FlowProvider({ onKey, children }: { onKey: ShowKey; children: ReactNode }) {
  const flow = useFlowHeld(onKey)
  return (
    <FlowContext.Provider value={flow}>
      {children}
      {flow.away && <Returning onReturn={() => void flow.returned()} />}
    </FlowContext.Provider>
  )
}
