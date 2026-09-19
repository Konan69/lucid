import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { cn } from './cn'

type Variant = 'primary' | 'control' | 'ghost' | 'quiet'
type Size = 'sm' | 'md'

const VARIANT = {
  primary: 'bg-accent text-ink-on-accent hover:bg-accent-hover shadow-control',
  control: 'bg-surface-3 text-ink ring-line shadow-control hover:bg-wash-hover',
  ghost: 'text-ink-2 hover:bg-wash-hover hover:text-ink',
  quiet: 'text-ink-3 hover:text-ink',
} satisfies Record<Variant, string>
const SIZE = {
  sm: 'h-7 px-2.5 text-label gap-1.5 rounded-sm',
  md: 'h-8 px-3 text-label gap-2 rounded-control',
} satisfies Record<Size, string>

export function Button({
  variant = 'control',
  size = 'md',
  icon,
  children,
  className,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size; icon?: ReactNode }) {
  return (
    <button
      className={cn(
        'inline-flex items-center justify-center font-title whitespace-nowrap transition-colors duration-(--dur-fast) select-none',
        VARIANT[variant],
        SIZE[size],
        className,
      )}
      {...rest}
    >
      {icon}
      {children}
    </button>
  )
}

export function IconButton({
  label,
  children,
  className,
  active,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; active?: boolean }) {
  return (
    <button
      aria-label={label}
      title={label}
      className={cn(
        'inline-flex size-8 items-center justify-center rounded-control text-ink-3 transition-colors duration-(--dur-fast) hover:bg-wash-hover hover:text-ink',
        active && 'bg-wash-selected text-ink',
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  )
}
