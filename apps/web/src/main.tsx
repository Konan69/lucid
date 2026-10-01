import { RegistryContext } from '@effect/atom-react'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { engine } from './data/runtime'
import { Canvas } from './screen/Canvas'
import './styles/index.css'

const root = document.getElementById('root')
if (root === null) throw new Error('The Vivid root element is missing')

/**
 * The voice demo adds `/canvas`, every demo screen side by side for design review. The phone
 * Vivid rings is a separate entry (`phone.html`), so it downloads only what a call needs.
 */
function Page() {
  if (location.pathname === '/canvas') return <Canvas />
  return <App />
}

createRoot(root).render(
  <StrictMode>
    {/* One Atom registry for the whole app: the one the live queries were built in. */}
    <RegistryContext.Provider value={engine.registry}>
      <Page />
    </RegistryContext.Provider>
  </StrictMode>,
)
