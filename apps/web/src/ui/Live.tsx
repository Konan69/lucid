import { LiveState } from '@vivid/state'
import type { ReactNode } from 'react'
import { Alert } from './alert'

/**
 * Draws one live query, keeping its three states apart so no screen can blur them:
 *
 * - `Loading` draws what the caller passes as `loading` (a skeleton, or nothing). It never draws
 *   empty-state copy, because nothing has been answered yet.
 * - `Failed` draws the server's own sentence. A live query only fails for good (the Person must
 *   sign in, or may not see this); a dropped connection keeps the last result on screen instead.
 * - `Ready` hands the value to `children`, which decides what an empty value looks like.
 */
export function Live<Value>({
  state,
  loading,
  children,
}: {
  state: LiveState<Value>
  loading: ReactNode
  children: (value: Value) => ReactNode
}) {
  return LiveState.$match(state, {
    Loading: () => loading,
    Failed: ({ failure }) => <Alert variant="destructive">{failure.message}</Alert>,
    Ready: ({ value }) => children(value),
  })
}
