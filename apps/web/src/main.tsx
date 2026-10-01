import { RegistryContext } from '@effect/atom-react'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { engine } from './data/runtime'
import './styles/index.css'

const root = document.getElementById('root')
if (root === null) throw new Error('The Vivid root element is missing')

createRoot(root).render(
  <StrictMode>
    {/* One Atom registry for the whole app: the one the live queries were built in. */}
    <RegistryContext.Provider value={engine.registry}>
      <App />
    </RegistryContext.Provider>
  </StrictMode>,
)
