import type {
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from 'react'
import { cn } from './cn'

/** The surface every form control shares: a raised well whose ring deepens when it has focus. */
const CONTROL =
  'w-full rounded-control bg-surface-2 px-3 text-label text-ink smooth-shadow-ring-xs outline-none placeholder:text-ink-4 focus:smooth-ring-accent disabled:cursor-not-allowed disabled:opacity-50'

/** A labelled form control. The label wraps the control, so clicking the words focuses it. */
export function Field({
  label,
  hint,
  children,
}: {
  label: string
  /** A quieter word beside the label, such as "optional". */
  hint?: string
  children: ReactNode
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-label font-title text-ink-2">
        {label}
        {hint !== undefined && <span className="font-meta text-ink-3"> {hint}</span>}
      </span>
      {children}
    </label>
  )
}

/** A one-line text, date or time field. */
export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn(CONTROL, 'h-10', className)} {...rest} />
}

/** A choice from a closed list. It opens on click, so it reads as interactive. */
export function Select({ className, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={cn(CONTROL, 'h-10 cursor-pointer', className)} {...rest} />
}

/** A field for several lines, which the Person can drag taller. */
export function Textarea({ className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cn(CONTROL, 'resize-y py-2.5', className)} {...rest} />
}
