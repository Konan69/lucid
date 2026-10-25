import { clock } from '@vivid/state'
import { useSyncExternalStore } from 'react'

/** The time now, to the second, kept moving while the component that asks for it is mounted. */
export const useNow = () => useSyncExternalStore(clock.watch, clock.read, clock.read)
