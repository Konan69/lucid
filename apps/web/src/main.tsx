import { RegistryContext } from '@effect/atom-react'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { Broken } from './screen/Broken'
import { Recover } from './ui/Recover'
import { engine } from './data/runtime'
import './styles/index.css'

const root = document.getElementById('root')
if (root === null) throw new Error('The Vivid root element is missing')

createRoot(root).render(
  <StrictMode>
    {/* One Atom registry for the whole app: the one the live queries were built in. */}
    <RegistryContext.Provider value={engine.registry}>
      {/* The last line of defence: whatever fails to draw, there is still a screen with a way on. */}
      <Recover from="app" fallback={<Broken />}>
        <App />
      </Recover>
    </RegistryContext.Provider>
  </StrictMode>,
)
