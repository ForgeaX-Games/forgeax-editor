import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../lib/utils';

const inputVariants = cva(
  'flex w-full appearance-none rounded-md border border-[var(--color-border-default,#444)] bg-[var(--color-background-base,#2a2a2a)] text-[var(--color-text-primary,#fff)] shadow-sm transition-colors file:border-0 file:bg-transparent file:font-medium placeholder:text-muted-foreground hover:border-[var(--color-border-strong)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50',
  {
    variants: {
      size: {
        default: 'h-9 px-3 py-1 text-sm file:text-sm',
        sm: 'h-7 px-2 py-0.5 text-xs file:text-xs',
        lg: 'h-10 px-3 py-2 text-sm file:text-sm',
      },
    },
    defaultVariants: {
      size: 'default',
    },
  },
);

export interface InputProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'size'>,
    VariantProps<typeof inputVariants> {}

const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, size, ...props }, ref) => (
    <input
      ref={ref}
      type={type}
      className={cn(inputVariants({ size }), className)}
      {...props}
    />
  ),
);
Input.displayName = 'Input';

export { Input, inputVariants };
