import { useNavigate } from '@tanstack/react-router'
import { useMe } from '../data/me'
import { Feed } from '../screen/Feed'

/** What `/feed` draws: the Feed, whose cards open their background Threads at `/t/$id`. */
export function FeedPlace() {
  const navigate = useNavigate()
  return (
    <Feed
      me={useMe()}
      onOpen={(thread) => void navigate({ to: '/t/$id', params: { id: thread } })}
    />
  )
}
