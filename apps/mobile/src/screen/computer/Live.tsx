import { VividRpcClient } from '@vivid/client-runtime'
import { ComputerScreen, ComputerState, type Computer } from '@vivid/contracts'
import { Effect, Result } from 'effect'
import { lazy, Suspense, useCallback, useState } from 'react'
import { TurboModuleRegistry, View } from 'react-native'
import { viewerOnGlass } from '../../data/computer'
import { useLiveData } from '../../data/live'

/**
 * Whether this install can draw a web page inside the app. The web view is a native part
 * (`react-native-webview`), in the app from version 0.3.0. Its JavaScript asks for the native
 * module the moment it is loaded and throws when there is none
 * (`NativeRNCWebViewModule.ts`, `TurboModuleRegistry.getEnforcing`), so the question is asked
 * here first, with the call that answers "none" without throwing, and the package is loaded only
 * after a yes (`Glass`). An install whose native part did not load keeps the page it had: the
 * screen opens in the browser.
 */
export const drawsScreen = (): boolean => TurboModuleRegistry.get('RNCWebViewModule') !== null

/** The web view, loaded when a screen is first drawn and never on an install without it. */
const Glass = lazy(() =>
  import('react-native-webview').then((loaded) => ({ default: loaded.WebView })),
)

/** How long before a viewer's permission runs out a fresh one is asked for. */
const RENEW_BEFORE_MS = 60_000

/** The Computer as the server has it now, for the next permission to watch it. */
const read = Effect.fn('Computer.live.read')(function* () {
  return (yield* (yield* VividRpcClient).GetComputer()).computer
})

/**
 * The Computer's own screen, live, on the glass: the provider's viewer page in a web view that
 * fills whatever holds it. It is the web panel's `Viewer` (`apps/web/src/screen/Computer.tsx`)
 * for a phone, and keeps its two rules.
 *
 * The address is a short-lived permission to watch one machine. It is never written anywhere,
 * and a minute before it runs out the server is asked for the next one, so a screen left open
 * keeps showing; an ask that fails is made again five seconds later, for as long as the page is
 * shown. The timer belongs to the view that holds the page (a ref's own cleanup), not to an
 * effect.
 *
 * While the Person is only watching, nothing they do reaches the page (`pointerEvents`), so
 * looking can never fight with what Vivid is doing there. Once they have taken over, touches go
 * through and the page's own keyboard button types into the machine.
 */
export function Live({
  address,
  expiresAt,
  control,
}: {
  address: string
  expiresAt: number
  /** The Person holds the keyboard and pointer, so their touches are the machine's. */
  control: boolean
}) {
  const data = useLiveData()
  const [shown, setShown] = useState({ address, expiresAt })
  // How many times the next permission was asked for and not given. Each one sets the timer
  // again, so a moment without the network does not leave the page on a permission that runs out.
  const [missed, setMissed] = useState(0)
  /** What the ask for the next permission came to. */
  const renewed = (answer: Result.Result<Computer, unknown>) => {
    if (Result.isFailure(answer)) return setMissed((count) => count + 1)
    // A Computer that stopped has no screen to renew; its record takes this view down.
    if (!ComputerState.guards.Running(answer.success.state)) return
    const next = answer.success.state.screen
    if (ComputerScreen.guards.Viewer(next))
      setShown({ address: next.address, expiresAt: next.expiresAt })
  }
  const renew = useCallback(
    (held: View | null) => {
      if (held === null) return undefined
      const timer = setTimeout(
        () => void data.run(read()).then(renewed),
        Math.max(shown.expiresAt - Date.now() - RENEW_BEFORE_MS, 5_000),
      )
      return () => clearTimeout(timer)
    },
    // `missed` is here so that a failed ask makes a new timer; it is not read inside.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
    [data, shown.expiresAt, missed],
  )
  return (
    <View
      ref={renew}
      pointerEvents={control ? 'auto' : 'none'}
      accessibilityLabel="Vivid’s computer screen"
      style={{ flex: 1, alignSelf: 'stretch' }}
    >
      <Suspense fallback={null}>
        <Glass
          source={{ uri: viewerOnGlass(shown.address) }}
          // The page is a video of a screen: it plays in place, at once, and is not a document
          // to scroll, bounce or zoom.
          allowsInlineMediaPlayback
          mediaPlaybackRequiresUserAction={false}
          scrollEnabled={false}
          bounces={false}
          // Nothing of the permission is kept after the page is gone.
          incognito
          style={{ flex: 1, backgroundColor: 'transparent' }}
        />
      </Suspense>
    </View>
  )
}
