import * as React from 'react'
import { cn } from '@/ui/cn'

/**
 * shadcn's Card on Vivid's raised layer: its fill and an edge, no shadow, because a card in the
 * page is not floating. shadcn clips the card (`overflow-hidden`) so a picture takes its corners;
 * the pictures are rounded themselves here, and nothing is clipped, so a focus ring on a row at
 * the card's edge is drawn whole.
 */
function Card({
  className,
  size = 'default',
  ...props
}: React.ComponentProps<'div'> & { size?: 'default' | 'sm' }) {
  return (
    <div
      data-slot="card"
      data-size={size}
      className={cn(
        'group/card flex flex-col gap-(--card-spacing) rounded-card bg-card py-(--card-spacing) text-label text-card-foreground edge [--card-spacing:--spacing(4)] has-[>img:first-child]:pt-0 data-[size=sm]:[--card-spacing:--spacing(3)] *:[img:first-child]:rounded-t-card *:[img:last-child]:rounded-b-card',
        className,
      )}
      {...props}
    />
  )
}

export { Card }
