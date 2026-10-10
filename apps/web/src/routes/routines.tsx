import { createFileRoute, lazyRouteComponent } from '@tanstack/react-router'
import { warm } from '../data/warm'

/** `/routines`: what Vivid has been asked to do on a trigger. */
export const Route = createFileRoute('/routines')({
  // Begins the screen's data before the screen (`data/warm.ts`); it holds nothing back.
  loader: () => warm.routines(),
  component: lazyRouteComponent(() => import('../place/Routines'), 'RoutinesPlace'),
})
