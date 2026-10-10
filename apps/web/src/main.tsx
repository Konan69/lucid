import { RegistryContext } from '@effect/atom-react'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider } from '@tanstack/react-router'
import App from './App'
import { Broken } from './screen/Broken'
import { Recover } from './ui/Recover'
import { TooltipProvider } from './ui/tooltip'
import { arrival } from './data/arrival'
import { engine } from './data/runtime'
import { sidebar } from './data/sidebar'
import { FirstPlace } from './place/First'
import { InvitePlace } from './place/Invite'
import { ThreadPlace } from './place/Thread'
import { router } from './router'
import { Route as firstRoute } from './routes/first'
import { Route as inviteRoute } from './routes/invite'
import { Route as rootRoute } from './routes/root'
import { Route as threadRoute } from './routes/thread'
import { startTelemetry } from './data/telemetry'
// Starts the app from what this browser kept of the first screen, before anything is drawn,
// and listens for the session ending, which erases it.
import './data/ending'
// The two typefaces ship with the app, so Vivid looks the same on every system.
import '@fontsource-variable/geist'
import '@fontsource-variable/bricolage-grotesque'
import './styles/index.css'

// The screens a Person meets first, given to their routes here so they ship in the app's first
// file. The route files cannot import them (`src/routes/root.tsx` says why); this is the one
// module that imports both, and it runs before the router draws anything.
rootRoute.update({ component: App })
firstRoute.update({ component: FirstPlace })
threadRoute.update({ component: ThreadPlace })
inviteRoute.update({ component: InvitePlace })

// Each time the Person arrives somewhere: a drawer has done its job once they have chosen where
// to go, and the first arrival is asked for only once they are on the first screen. Subscribed
// here and not in `router.ts`, which must import no data module (it says why).
router.subscribe('onResolved', () => {
  sidebar.tuck()
  arrival.consider()
})

// Before the first draw, so an error while drawing the first screen is reported.
startTelemetry()

const root = document.getElementById('root')
if (root === null) throw new Error('The Vivid root element is missing')

createRoot(root).render(
  <StrictMode>
    {/* One Atom registry for the whole app: the one the live queries were built in. */}
    <RegistryContext.Provider value={engine.registry}>
      {/* The last line of defence: whatever fails to draw, there is still a screen with a way on. */}
      <Recover from="app" fallback={<Broken />}>
        {/* One provider for every tooltip, so the second one a pointer reaches opens at once. */}
        <TooltipProvider>
          <RouterProvider router={router} />
        </TooltipProvider>
      </Recover>
    </RegistryContext.Provider>
  </StrictMode>,
)
