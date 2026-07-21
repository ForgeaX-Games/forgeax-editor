import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../lib/utils';

const textareaVariants = cva(
  'flex w-full appearance-none rounded-md border border-input bg-[var(--color-background-base)] text-foreground shadow-sm placeholder:text-muted-foreground hover:border-[var(--color-border-strong)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50',
  {
    variants: {
      size: {
        default: 'min-h-20 px-3 py-2 text-sm',
        sm: 'min-h-16 px-2 py-1.5 text-xs',
        lg: 'min-h-24 px-3 py-2 text-sm',
      },
    },
    defaultVariants: {
      size: 'default',
    },
  },
);

export interface TextareaProps
  extends React.TextareaHTMLAttributes<HTMLTextAreaElement>,
    VariantProps<typeof textareaVariants> {}

const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, size, ...props }, ref) => (
    <textarea
      ref={ref}
      className={cn(textareaVariants({ size }), className)}
      {...props}
    />
  ),
);
Textarea.displayName = 'Textarea';

export { Textarea, textareaVariants };
