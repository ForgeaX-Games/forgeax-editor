import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../lib/utils';

const buttonVariants = cva(
  'no-motion-lift inline-flex box-border cursor-pointer select-none appearance-none items-center justify-center gap-2 whitespace-nowrap rounded-sm border border-transparent bg-transparent text-sm font-medium leading-none shadow-none focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        default: 'border-white/[0.06] bg-white/[0.03] text-[var(--color-text-secondary)] hover:bg-white/[0.10] hover:text-[var(--color-text-primary)]',
        primary: 'border-transparent bg-primary text-primary-foreground hover:bg-primary/90 hover:text-primary-foreground',
        destructive: 'border-transparent bg-destructive text-destructive-foreground hover:bg-destructive/90 hover:text-destructive-foreground',
        outline: 'border-[var(--color-divider-default)] bg-transparent text-[var(--color-text-secondary)] hover:bg-white/[0.10] hover:text-[var(--color-text-primary)]',
        secondary: 'border-white/[0.06] bg-white/[0.03] text-[var(--color-text-secondary)] hover:bg-white/[0.10] hover:text-[var(--color-text-primary)]',
        ghost: 'border-transparent bg-transparent text-[var(--color-text-secondary)] hover:bg-white/[0.10] hover:text-[var(--color-text-primary)]',
        link: 'border-transparent bg-transparent text-primary hover:text-primary',
        subtle: 'border-white/[0.06] bg-white/[0.03] text-[var(--color-text-secondary)] hover:bg-white/[0.10] hover:text-[var(--color-text-primary)]',
        chrome: 'border-transparent bg-transparent text-[var(--color-text-secondary)] hover:bg-white/[0.10] hover:text-[var(--color-text-primary)]',
      },
      size: {
        default: 'h-9 px-4 py-2',
        sm: 'h-7 rounded-sm px-2.5 text-xs',
        lg: 'h-10 rounded-sm px-8',
        icon: 'h-9 w-9',
        iconSm: 'h-8 w-8',
        iconLg: 'h-10 w-10',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button';
    return (
      <Comp
        ref={ref}
        className={cn(buttonVariants({ variant, size, className }))}
        {...props}
      />
    );
  },
);
Button.displayName = 'Button';

export { Button, buttonVariants };
