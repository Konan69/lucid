import { createFileRoute } from '@tanstack/react-router'
import { warm } from '../data/warm'

/** `/library`: what Vivid has been given to know. */
export const Route = createFileRoute('/library')({
  // Begins the screen's data before the screen (`data/warm.ts`); it holds nothing back.
  loader: () => warm.library(),
})
