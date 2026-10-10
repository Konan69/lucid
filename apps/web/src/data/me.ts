import type { MeResponse } from '@vivid/contracts'
import { Option } from 'effect'
import { createContext, use } from 'react'

/**
 * Who is signed in, for every screen under the shell.
 *
 * The shell is drawn only once the live `me` query has answered (`App.tsx`), and it hands that
 * answer down here. A screen the router draws takes no props, so this is how it reads the Person
 * without matching on the query's loading and failed states a second time.
 */
export const Me = createContext(Option.none<MeResponse>())

/**
 * The signed-in Person. Only the shell provides it, and only the shell draws screens, so a
 * screen that finds nobody was drawn outside the shell: a defect in this app, not a state a
 * Person can reach, which is why it throws for the nearest `Recover` and is not a typed failure.
 */
export const useMe = (): MeResponse =>
  Option.getOrThrowWith(use(Me), () => new Error('A screen was drawn outside the signed-in shell'))
