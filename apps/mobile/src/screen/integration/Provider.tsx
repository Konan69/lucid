import { useMemo, type ReactNode } from 'react'
import { View } from 'react-native'
import { onForeground } from '../../data/foreground'
import { useLiveData } from '../../data/live'
import { FlowContext, useFlowHeld } from './flow'

/**
 * Holds the one integration flow for the signed-in shell (`useFlowHeld`, `flow.ts`), and is the
 * shell's side of the session's connecting machine (`data/connecting.ts`): it tells it each time
 * the Person comes back to the app.
 *
 * It is mounted around the navigator (`Shell`, `App.tsx`), which is built again for each
 * workspace. The machine is the session's and outlives a shell.
 *
 * It is one view's ref, so no effect runs: the subscription lives exactly as long as the view.
 * Coming back is said on every return to the front, not only while a sign-in is away: the machine
 * takes `Returned` only in `Away`, so no flag is kept here to say whether one is. It is here
 * once: said by each surface that reads the flow, the return would be answered as many times as
 * there were surfaces mounted.
 */
export function FlowProvider({ children }: { children: ReactNode }) {
  const flow = useFlowHeld()
  const { connecting } = useLiveData()
  const held = useMemo(() => onForeground(connecting.returned), [connecting])
  return (
    <FlowContext.Provider value={flow}>
      {children}
      <View ref={held} />
    </FlowContext.Provider>
  )
}
