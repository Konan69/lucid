import { useParams } from '@tanstack/react-router'
import { useMe } from '../data/me'
import { usePages } from '../data/pages'
import { panel, usePanel } from '../data/panel'
import { wake } from '../data/wake'
import { Thread } from '../screen/Thread'

/**
 * What `/t/$id` draws. Going from one Thread to the next keeps this mounted and changes the id
 * it hands down: it is the same screen with different words in it, and changes at once.
 */
export function ThreadPlace() {
  const { id } = useParams({ from: '/t/$id' })
  const beside = usePanel((state) => state.open)
  return (
    <Thread
      id={id}
      me={useMe()}
      panelOpen={beside}
      onTogglePanel={() => {
        // Opening the panel onto Vivid's computer is arriving at it, which turns it on. Opening
        // it onto a page that was left in front is not.
        if (!usePanel.getState().open && usePages.getState().front === 'computer') wake()
        panel.toggle()
      }}
    />
  )
}
