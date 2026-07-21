import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../lib/utils';

const inputGroupVariants = cva(
  'flex w-full items-center rounded-md border border-input bg-[var(--color-background-base)] shadow-sm transition-colors focus-within:ring-1 focus-within:ring-ring hover:border-[var(--color-border-strong)]',
  {
    variants: {
      size: {
        default: 'h-9 text-sm',
        sm: 'h-7 text-xs',
        lg: 'h-10 text-sm',
      },
    },
    defaultVariants: {
      size: 'default',
    },
  },
);

export interface InputGroupProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof inputGroupVariants> {}

function InputGroup({ className, size, ...props }: InputGroupProps) {
  return (
    <div
      className={cn(inputGroupVariants({ size }), className)}
      {...props}
    />
  );
}

function InputGroupAddon({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('flex h-full items-center gap-1 px-3 text-[inherit] text-muted-foreground [&_svg]:size-4', className)}
      {...props}
    />
  );
}

function InputGroupInput({ className, ...props }: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        'min-w-0 flex-1 appearance-none bg-transparent px-0 py-1 text-[inherit] text-foreground outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    />
  );
}

function InputGroupButton({ className, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      className={cn(
        'no-motion-lift inline-flex h-full cursor-pointer appearance-none items-center justify-center gap-1 rounded-none border-0 bg-transparent px-3 text-[inherit] text-muted-foreground transition-colors hover:bg-[var(--color-interaction-hover)] hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 [&_svg]:size-4',
        className,
      )}
      {...props}
    />
  );
}

export { InputGroup, InputGroupAddon, InputGroupInput, InputGroupButton };
