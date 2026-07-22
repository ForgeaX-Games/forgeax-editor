import * as React from 'react';
import * as CheckboxPrimitive from '@radix-ui/react-checkbox';
import { Check } from 'lucide-react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../lib/utils';

const checkboxVariants = cva(
  'no-motion-lift peer shrink-0 cursor-pointer appearance-none rounded-sm border border-input bg-[var(--color-background-base)] text-primary shadow-sm transition-colors hover:border-[var(--color-border-strong)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:border-primary data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground',
  {
    variants: {
      size: {
        default: 'h-4 w-4 [&_svg]:h-4 [&_svg]:w-4',
        sm: 'h-3.5 w-3.5 [&_svg]:h-3.5 [&_svg]:w-3.5',
        menu: [
          'h-[15px] w-[15px] rounded-[4px]',
          'border-[var(--color-border-default)] bg-transparent shadow-none',
          'text-[var(--color-text-on-bright-primary)]',
          'hover:border-[var(--color-border-default)]',
          'focus-visible:ring-0 focus-visible:ring-offset-0',
          'data-[state=checked]:border-[var(--color-brand-primary)]',
          'data-[state=checked]:bg-[var(--color-brand-primary)]',
          'data-[state=checked]:text-[var(--color-text-on-bright-primary)]',
          '[&_svg]:h-[11px] [&_svg]:w-[11px] [&_svg]:stroke-[2.2]',
        ].join(' '),
        lg: 'h-5 w-5 [&_svg]:h-5 [&_svg]:w-5',
      },
    },
    defaultVariants: {
      size: 'default',
    },
  },
);

const Checkbox = React.forwardRef<
  React.ElementRef<typeof CheckboxPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof CheckboxPrimitive.Root> &
    VariantProps<typeof checkboxVariants>
>(({ className, size, ...props }, ref) => (
  <CheckboxPrimitive.Root
    ref={ref}
    className={cn(checkboxVariants({ size }), className)}
    {...props}
  >
    <CheckboxPrimitive.Indicator className={cn('flex items-center justify-center text-current')}>
      <Check />
    </CheckboxPrimitive.Indicator>
  </CheckboxPrimitive.Root>
));
Checkbox.displayName = CheckboxPrimitive.Root.displayName;

export { Checkbox, checkboxVariants };
