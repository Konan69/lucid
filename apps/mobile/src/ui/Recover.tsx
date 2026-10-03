import { Component, createContext, useContext, type ReactNode } from 'react'

interface Props {
  /** What is drawn in place of the part that broke. It can offer `useAgain()` as a way back. */
  readonly fallback: ReactNode
  /**
   * What the broken part was drawing from. When it changes, the part is tried again by itself: a
   * reply that could not be drawn while half of it had arrived may draw once the rest has.
   */
  readonly from: string
  readonly children: ReactNode
}

interface State {
  readonly broken: boolean
  readonly from: string
}

const Again = createContext<() => void>(() => undefined)

/** For a fallback: draws the part that broke once more. */
export const useAgain = () => useContext(Again)

/**
 * Keeps one part of the screen that fails to draw from taking the rest with it.
 *
 * Without it, an exception while rendering anything (one malformed reply, one unexpected record)
 * unmounts the whole tree; on a phone that is an app that closes under the Person's thumb, or a
 * blank screen with nothing to press. React only offers this as a class:
 * `getDerivedStateFromError` has no hook. It is the web's `ui/Recover.tsx`, unchanged in what it
 * does.
 */
export class Recover extends Component<Props, State> {
  override state: State = { broken: false, from: this.props.from }

  static getDerivedStateFromError(): Partial<State> {
    return { broken: true }
  }

  static getDerivedStateFromProps(props: Props, state: State): State | null {
    return props.from === state.from ? null : { broken: false, from: props.from }
  }

  readonly again = () => this.setState({ broken: false })

  override render() {
    if (!this.state.broken) return this.props.children
    return <Again.Provider value={this.again}>{this.props.fallback}</Again.Provider>
  }
}
