import { useMemo, type ReactNode } from 'react'
import { View } from 'react-native'
import type { ShowKey } from '../../data/connecting'
import { onForeground } from '../../data/foreground'
import { useLiveData } from '../../data/live'
import { FlowContext, useFlowHeld } from './flow'

/**
 * Holds the one integration flow for the signed-in shell (`useFlowHeld`, `flow.ts`), and is the
 * shell's side of the session's connecting machine (`data/connecting.ts`): it hands the machine
 * the way to open the key form, and tells it each time the Person comes back to the app.
 *
 * It is mounted around the navigator (`Shell`, `App.tsx`), which is built again for each
 * workspace. The machine is the session's and outlives a shell; what is handed over here is the
 * shell's, and is taken back when the shell goes.
 *
 * Both are one view's ref, so no effect runs: the subscriptions live exactly as long as the view.
 * Coming back is said on every return to the front, not only while a sign-in is away: the machine
 * takes `Returned` only in `Away`, so no flag is kept here to say whether one is. It is here
 * once: said by each surface that reads the flow, the return would be answered as many times as
 * there were surfaces mounted.
 *
 * Nothing here is a React Native `Modal`. The form for a service that takes a key is a route on
 * the stack, and being outside the navigator this cannot navigate, so the shell hands it the way
 * to open that route (`onKey`).
 */
export function FlowProvider({ onKey, children }: { onKey: ShowKey; children: ReactNode }) {
  const flow = useFlowHeld()
  const { connecting } = useLiveData()
  const held = useMemo(() => {
    const hear = onForeground(connecting.returned)
    const hand = connecting.keyRoute(onKey)
    return (view: View | null) => {
      const unhear = hear(view)
      const unhand = hand()
      return () => {
        unhear()
        unhand()
      }
    }
  }, [connecting, onKey])
  return (
    <FlowContext.Provider value={flow}>
      {children}
      <View ref={held} />
    </FlowContext.Provider>
  )
}
