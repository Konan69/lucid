import { useParams } from '@tanstack/react-router'
import { Invite } from '../screen/Invite'

/** What `/invite/$id` draws. */
export function InvitePlace() {
  const { id } = useParams({ from: '/invite/$id' })
  return <Invite id={id} />
}
