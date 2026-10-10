import { createFileRoute, lazyRouteComponent } from '@tanstack/react-router'
import { ProjectId } from '@vivid/contracts'
import { warm } from '../data/warm'

/**
 * `/projects` and `/projects/$id`: the shelf of Projects, or one Project open on it.
 *
 * One route with an optional id, not two: opening a Project is the same screen with one more
 * thing on it, and two routes would unmount the shelf and draw it again on every open and close.
 */
export const Route = createFileRoute('/projects/{-$id}')({
  params: {
    parse: ({ id }) => (id === undefined ? {} : { id: ProjectId.make(id) }),
    stringify: ({ id }) => (id === undefined ? {} : { id }),
  },
  // Begins the screen's data before the screen (`data/warm.ts`); it holds nothing back.
  loader: () => warm.projects(),
  component: lazyRouteComponent(() => import('../place/Projects'), 'ProjectsPlace'),
})
