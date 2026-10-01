import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Phone } from './screen/Phone'
import './styles/index.css'

/**
 * The phone Vivid rings is its own entry, not a route of the app. The phone joins over a tunnel
 * on mobile data, where the app's full bundle — the Thread, Flue, Markdown, the Library — is a
 * slow download it never uses. This page carries only the call.
 */
const root = document.getElementById('root')
if (root === null) throw new Error('The Vivid root element is missing')

createRoot(root).render(
  <StrictMode>
    <div className="h-dvh">
      <Phone />
    </div>
  </StrictMode>,
)
