import { useNavigate, useParams } from '@tanstack/react-router'
import { Option } from 'effect'
import { Projects } from '../screen/Projects'

/**
 * What `/projects` and `/projects/$id` draw: the shelf, with the Project the address names open
 * on it. The open one rides in the path so the sidebar's group can link straight to a Project.
 */
export function ProjectsPlace() {
  const { id } = useParams({ from: '/projects/{-$id}' })
  const navigate = useNavigate()
  return (
    <Projects
      open={Option.fromUndefinedOr(id)}
      onOpen={(next) =>
        void navigate({ to: '/projects/{-$id}', params: { id: Option.getOrUndefined(next) } })
      }
      onOpenThread={(thread) => void navigate({ to: '/t/$id', params: { id: thread } })}
    />
  )
}
