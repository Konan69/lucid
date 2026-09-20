import type { HTMLAttributes } from 'react'
import { cn } from './cn'

export function Card({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn('rounded-card bg-surface-3 smooth-shadow-ring-sm', className)} {...rest} />
  )
}
