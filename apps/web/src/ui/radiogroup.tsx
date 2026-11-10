import { RadioGroup as RadioGroupPrimitive } from '@base-ui/react/radio-group'
import { cn } from '@/ui/cn'

function RadioGroup({ className, ...props }: RadioGroupPrimitive.Props) {
  return (
    <RadioGroupPrimitive
      data-slot="radio-group"
      className={cn('grid w-full gap-3', className)}
      {...props}
    />
  )
}

export { RadioGroup }
