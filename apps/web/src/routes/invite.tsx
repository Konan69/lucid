import { createFileRoute } from '@tanstack/react-router'
import { InvitationId } from '@vivid/contracts'

/** `/invite/$id`: an invitation to a Company, shown before it is accepted. `main.tsx` gives it its
 * screen (`place/Invite`). */
export const Route = createFileRoute('/invite/$id')({
  params: {
    parse: ({ id }) => ({ id: InvitationId.make(id) }),
    stringify: ({ id }) => ({ id }),
  },
})
