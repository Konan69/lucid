import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { cn } from './cn'

type Variant = 'primary' | 'control' | 'danger' | 'ghost' | 'quiet'
type Size = 'sm' | 'md'

const VARIANT = {
  primary: 'bg-accent text-ink-on-accent hover:bg-accent-hover smooth-shadow-xs',
  control: 'bg-surface-3 text-ink smooth-shadow-ring-xs hover:bg-wash-hover',
  // The one thing in a dialog that cannot be taken back. It is said in the danger ink on the
  // same quiet surface, not on a red fill: the warning is the dialog, this is the answer to it.
  danger: 'bg-surface-3 text-danger smooth-shadow-ring-xs hover:bg-danger-soft',
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
        'inline-flex cursor-pointer items-center justify-center font-title whitespace-nowrap transition-press duration-(--dur-fast) select-none active:enabled:scale-96 disabled:cursor-not-allowed disabled:opacity-60',
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
        'inline-flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-control text-ink-3 transition-press duration-(--dur-fast) hover:bg-wash-hover hover:text-ink active:enabled:scale-96 disabled:cursor-not-allowed disabled:opacity-60',
        active && 'bg-wash-selected text-ink',
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  )
}
