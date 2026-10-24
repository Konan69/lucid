import { createFileRoute } from '@tanstack/react-router'
import { warm } from '../data/warm'

/** Starts the Feed subscription before loading its screen. */
export const Route = createFileRoute('/feed')({
  loader: () => warm.feed(),
})
