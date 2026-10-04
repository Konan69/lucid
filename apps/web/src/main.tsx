import { RegistryContext } from '@effect/atom-react'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { Broken } from './screen/Broken'
import { Recover } from './ui/Recover'
import { TooltipProvider } from './ui/tooltip'
import { engine } from './data/runtime'
// The two typefaces ship with the app, so Vivid looks the same on every system.
import '@fontsource-variable/geist'
import '@fontsource-variable/bricolage-grotesque'
import './styles/index.css'

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
          <App />
        </TooltipProvider>
      </Recover>
    </RegistryContext.Provider>
  </StrictMode>,
)
