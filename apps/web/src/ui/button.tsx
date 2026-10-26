import { Button as ButtonPrimitive } from '@base-ui/react/button'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/ui/cn'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/ui/tooltip'

/**
 * shadcn's Button (`base-mira`, on Base UI), drawn as Vivid's. The variant and size names are
 * shadcn's, so a block added from a registry finds the button it was written against; what each
 * one looks like is Vivid's:
 *
 * - `default`      the one filled action on a surface, in the primary colour.
 * - `outline`      a control: a raised layer, its own fill and an edge, no shadow. Hover steps it
 *                  down to the surface fill, which stays opaque.
 * - `secondary`    a filled control with no edge, for a row of equal choices.
 * - `ghost`        an action that only shows a fill under the pointer.
 * - `destructive`  the one thing that cannot be taken back, said in the danger ink on the quiet
 *                  control surface, not on a red fill: the warning is the dialog, this answers it.
 * - `link`         words that go somewhere.
 * - `glass`        a suggested reply under Vivid's (`thread/Replies.tsx`): a light glass fill with
 *                  the field's hairline and no shadow, so it reads as a tap and not as a bubble.
 *                  It slides in as it arrives (`motion-offer`).
 *
 * Sizes are the control's (`default`, 32 px), smaller and larger steps of it, the square icon
 * sizes, and `pill`: the control's height, fully round, for a row's one action.
 *
 * It answers a press by giving a little (`motion-press`, scale 0.97 over 120 ms). Focus is the
 * document's own ring, so it is not restated here. Base UI gives it `type="button"` unless the
 * caller says `type="submit"`.
 */
const buttonVariants = cva(
  "group/button inline-flex shrink-0 motion-press cursor-pointer items-center justify-center font-title whitespace-nowrap select-none disabled:cursor-not-allowed disabled:opacity-60 aria-disabled:cursor-not-allowed aria-disabled:opacity-60 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground hover:bg-primary-hover',
        outline: 'bg-surface-3 text-ink edge hover:bg-surface-2 aria-expanded:bg-surface-2',
        secondary: 'bg-wash-selected text-ink hover:bg-wash-pressed',
        ghost:
          'text-ink-2 hover:bg-accent hover:text-ink aria-expanded:bg-accent aria-expanded:text-ink aria-pressed:bg-wash-selected aria-pressed:text-ink',
        destructive: 'bg-surface-3 text-danger edge hover:bg-danger-soft',
        link: 'text-primary-ink underline-offset-4 hover:underline',
        glass:
          'motion-offer bg-surface-0/45 text-ink edge backdrop-blur-md edge-field hover:bg-surface-0/70',
      },
      size: {
        default: 'h-8 gap-2 rounded-control px-3 text-label',
        xs: "h-6 gap-1 rounded-row px-2 text-meta [&_svg:not([class*='size-'])]:size-3.5",
        sm: 'h-7 gap-1.5 rounded-row px-2.5 text-label',
        lg: 'h-10 gap-2 rounded-control px-4 text-title',
        // The one compact action at the end of a row that already carries a logo and two lines
        // (the Integration card in a Thread): as tall as a control, round, so it reads as the
        // row's single answer and not as one of a toolbar's buttons.
        pill: 'h-8 gap-1.5 rounded-full px-3.5 text-label',
        // A suggested reply: the pill's height and round ends, in the reading size of the bubble
        // above it, at the regular weight, with the "↪" sitting close (the owner's mockup v8).
        reply: 'h-8 gap-1.25 rounded-full ps-2.5 pe-3 text-body font-normal',
        icon: 'size-8 rounded-control',
        'icon-xs': "size-6 rounded-row [&_svg:not([class*='size-'])]:size-3.5",
        'icon-sm': 'size-7 rounded-row',
        'icon-lg': 'size-10 rounded-control',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
)

function Button({
  className,
  variant = 'default',
  size = 'default',
  ...props
}: ButtonPrimitive.Props & VariantProps<typeof buttonVariants>) {
  return (
    <ButtonPrimitive
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

/**
 * A button that is only a mark. `label` is its name: what a screen reader says and what the
 * tooltip shows on hover or focus, so a mark is never left unexplained. `active` holds the chosen
 * fill for a mark that is a switch (a panel that is open, a view that is on).
 */
function IconButton({
  label,
  active = false,
  size = 'icon',
  className,
  ...props
}: Omit<ButtonPrimitive.Props, 'aria-label'> & {
  label: string
  active?: boolean
  size?: 'icon' | 'icon-xs' | 'icon-sm' | 'icon-lg'
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size={size}
            aria-label={label}
            className={cn('text-ink-3', active && 'bg-wash-selected text-ink', className)}
            {...props}
          />
        }
      />
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

export { Button, IconButton, buttonVariants }
