import { useNavigate } from '@tanstack/react-router'
import { ThreadId } from '@vivid/contracts'
import { Routines } from '../screen/Routines'

/** What `/routines` draws. A Routine's conversation is a Thread, and opening one goes to it. */
export function RoutinesPlace() {
  const navigate = useNavigate()
  return (
    <Routines
      onOpenConversation={(conversation) =>
        void navigate({ to: '/t/$id', params: { id: ThreadId.make(conversation.id) } })
      }
    />
  )
}
