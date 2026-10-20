import { createFileRoute, lazyRouteComponent } from '@tanstack/react-router'
import { warm } from '../data/warm'

/** Starts the Feed subscription before loading its screen. */
export const Route = createFileRoute('/feed')({
  loader: () => warm.feed(),
  component: lazyRouteComponent(() => import('../place/Feed'), 'FeedPlace'),
})
