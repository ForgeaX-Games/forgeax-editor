import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../lib/utils';

const emptyVariants = cva(
  'flex flex-col items-center justify-center rounded-md border border-dashed border-border text-center',
  {
    variants: {
      size: {
        default: 'min-h-40 gap-3 p-6',
        sm: 'min-h-28 gap-2 p-4',
        lg: 'min-h-48 gap-4 p-8',
      },
    },
    defaultVariants: {
      size: 'default',
    },
  },
);

export interface EmptyProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof emptyVariants> {}

function Empty({ className, size, ...props }: EmptyProps) {
  return (
    <div
      className={cn(emptyVariants({ size }), className)}
      {...props}
    />
  );
}

function EmptyHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('flex flex-col items-center gap-1', className)} {...props} />;
}

function EmptyTitle({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
  return <h3 className={cn('text-sm font-medium text-foreground', className)} {...props} />;
}

function EmptyDescription({ className, ...props }: React.HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn('max-w-sm text-sm text-muted-foreground', className)} {...props} />;
}

function EmptyContent({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('flex items-center gap-2', className)} {...props} />;
}

export { Empty, EmptyHeader, EmptyTitle, EmptyDescription, EmptyContent, emptyVariants };
