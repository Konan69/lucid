import * as React from 'react'
import { Dialog as DialogPrimitive } from '@base-ui/react/dialog'
import { cn } from '@/ui/cn'
import { countSurface } from '@/ui/Layer'

import { Button } from '@/ui/button'
import { XIcon } from 'lucide-react'

function Dialog({ ...props }: DialogPrimitive.Root.Props) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />
}

function DialogPortal({ ...props }: DialogPrimitive.Portal.Props) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />
}

function DialogClose({ ...props }: DialogPrimitive.Close.Props) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />
}

function DialogOverlay({ className, ...props }: DialogPrimitive.Backdrop.Props) {
  return (
    <DialogPrimitive.Backdrop
      data-slot="dialog-overlay"
      className={cn('fixed inset-0 isolate z-50 motion-fade glass-scrim', className)}
      {...props}
    />
  )
}

function DialogContent({
  className,
  children,
  showCloseButton = true,
  flush = false,
  instant = false,
  solid = false,
  ...props
}: DialogPrimitive.Popup.Props & {
  showCloseButton?: boolean
  /** For a surface that lays itself out edge to edge (Settings, the palette): no padding or gap. */
  flush?: boolean
  /** For a surface opened from the keyboard many times a day: it is there at once, no entrance. */
  instant?: boolean
  /**
   * For a surface that fills the window and scrolls (Settings), or whose own panes cover it
   * (Customise): the solid raised layer, not glass. A blur that large is worked out again on
   * every frame of a scroll, and under an opaque pane it would show nothing.
   */
  solid?: boolean
}) {
  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Popup
        data-slot="dialog-content"
        // Base UI does not state this itself. The app's shortcuts read it to stand down while
        // a modal is open (`App.tsx`), as assistive tech does to leave the page behind it alone.
        aria-modal="true"
        ref={countSurface}
        className={cn(
          // `grid-cols-1` is a column that may be narrower than its content. A bare grid's column
          // is as wide as the widest thing in it, so a row that should truncate instead pushed
          // the palette's content wider than the panel, and the focused field scrolled it sideways.
          'fixed top-1/2 left-1/2 z-50 grid max-h-[calc(100%-2rem)] w-full max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 grid-cols-1 gap-5 overflow-y-auto rounded-dialog p-6 text-label text-popover-foreground lift-lg outline-none sm:max-w-sm',
          solid ? 'bg-popover' : 'glass-modal',
          flush && 'gap-0 p-0',
          !instant && 'motion-dialog',
          className,
        )}
        {...props}
      >
        {children}
        {showCloseButton && (
          <DialogPrimitive.Close
            data-slot="dialog-close"
            render={
              <Button
                variant="ghost"
                className="absolute top-3 right-3 text-ink-3"
                size="icon-sm"
              />
            }
          >
            <XIcon />
            <span className="sr-only">Close</span>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Popup>
    </DialogPortal>
  )
}

function DialogHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="dialog-header"
      className={cn('flex flex-col gap-1 pr-8', className)}
      {...props}
    />
  )
}

function DialogFooter({
  className,
  showCloseButton = false,
  children,
  ...props
}: React.ComponentProps<'div'> & {
  showCloseButton?: boolean
}) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn('flex flex-col-reverse gap-2 sm:flex-row sm:justify-end', className)}
      {...props}
    >
      {children}
      {showCloseButton && (
        <DialogPrimitive.Close render={<Button variant="outline" />}>Close</DialogPrimitive.Close>
      )}
    </div>
  )
}

function DialogTitle({ className, ...props }: DialogPrimitive.Title.Props) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn('text-dialog font-title text-ink', className)}
      {...props}
    />
  )
}

function DialogDescription({ className, ...props }: DialogPrimitive.Description.Props) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn(
        'text-label font-meta text-muted-foreground *:[a]:underline *:[a]:underline-offset-3 *:[a]:hover:text-foreground',
        className,
      )}
      {...props}
    />
  )
}

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
}
