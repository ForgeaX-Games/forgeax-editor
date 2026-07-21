import * as React from 'react';
import { LoaderCircle } from 'lucide-react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../lib/utils';

const spinnerVariants = cva('animate-spin text-muted-foreground', {
  variants: {
    size: {
      default: 'h-4 w-4',
      sm: 'h-3.5 w-3.5',
      lg: 'h-5 w-5',
    },
  },
  defaultVariants: {
    size: 'default',
  },
});

export interface SpinnerProps
  extends Omit<React.ComponentPropsWithoutRef<typeof LoaderCircle>, 'size'>,
    VariantProps<typeof spinnerVariants> {}

function Spinner({ className, size, 'aria-label': ariaLabel = 'Loading', ...props }: SpinnerProps) {
  return (
    <LoaderCircle
      aria-label={ariaLabel}
      className={cn(spinnerVariants({ size }), className)}
      {...props}
    />
  );
}

export { Spinner, spinnerVariants };
