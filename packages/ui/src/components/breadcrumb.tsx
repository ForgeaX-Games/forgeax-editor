import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { ChevronRight } from 'lucide-react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../lib/utils';

const Breadcrumb = React.forwardRef<
  HTMLElement,
  React.ComponentPropsWithoutRef<'nav'>
>(({ className, ...props }, ref) => (
  <nav
    ref={ref}
    aria-label="breadcrumb"
    className={cn('flex min-w-0 flex-1 items-center overflow-hidden', className)}
    {...props}
  />
));
Breadcrumb.displayName = 'Breadcrumb';

const BreadcrumbList = React.forwardRef<
  HTMLOListElement,
  React.ComponentPropsWithoutRef<'ol'>
>(({ className, ...props }, ref) => (
  <ol
    ref={ref}
    className={cn('m-0 flex min-w-0 list-none items-center gap-1 overflow-hidden p-0', className)}
    {...props}
  />
));
BreadcrumbList.displayName = 'BreadcrumbList';

const BreadcrumbItem = React.forwardRef<
  HTMLLIElement,
  React.ComponentPropsWithoutRef<'li'>
>(({ className, ...props }, ref) => (
  <li
    ref={ref}
    className={cn('m-0 flex min-w-0 shrink-0 list-none items-center gap-1 p-0', className)}
    {...props}
  />
));
BreadcrumbItem.displayName = 'BreadcrumbItem';

const breadcrumbButtonVariants = cva(
  'no-motion-lift inline-flex h-7 max-w-40 cursor-pointer select-none appearance-none items-center justify-center truncate rounded-sm border border-transparent bg-transparent px-2 text-xs leading-none text-[var(--color-text-secondary)] transition-colors hover:bg-white/[0.10] hover:text-[var(--color-text-primary)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50',
  {
    variants: {
      size: {
        sm: 'h-7 max-w-32 px-2 text-xs',
        default: 'h-8 max-w-40 px-2.5 text-xs',
      },
    },
    defaultVariants: {
      size: 'default',
    },
  },
);

export interface BreadcrumbButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof breadcrumbButtonVariants> {}

const BreadcrumbButton = React.forwardRef<HTMLButtonElement, BreadcrumbButtonProps>(
  ({ className, size, ...props }, ref) => (
    <button
      ref={ref}
      type="button"
      className={cn(breadcrumbButtonVariants({ size }), className)}
      {...props}
    />
  ),
);
BreadcrumbButton.displayName = 'BreadcrumbButton';

export interface BreadcrumbLinkProps extends React.AnchorHTMLAttributes<HTMLAnchorElement> {
  asChild?: boolean;
}

const BreadcrumbLink = React.forwardRef<HTMLAnchorElement, BreadcrumbLinkProps>(
  ({ asChild = false, className, ...props }, ref) => {
    const Comp = asChild ? Slot : 'a';
    return (
      <Comp
        ref={ref}
        className={cn(breadcrumbButtonVariants({ size: 'default' }), className)}
        {...props}
      />
    );
  },
);
BreadcrumbLink.displayName = 'BreadcrumbLink';

const BreadcrumbPage = React.forwardRef<
  HTMLSpanElement,
  React.ComponentPropsWithoutRef<'span'>
>(({ className, ...props }, ref) => (
  <span
    ref={ref}
    aria-current="page"
    className={cn('block max-w-40 truncate px-2 text-xs text-[var(--color-text-primary)]', className)}
    {...props}
  />
));
BreadcrumbPage.displayName = 'BreadcrumbPage';

const BreadcrumbSeparator = ({
  children,
  className,
  ...props
}: React.ComponentProps<'li'>) => (
  <li
    role="presentation"
    aria-hidden="true"
    className={cn('m-0 flex shrink-0 list-none items-center p-0 text-[var(--color-text-tertiary)] [&>svg]:size-3.5', className)}
    {...props}
  >
    {children ?? <ChevronRight />}
  </li>
);
BreadcrumbSeparator.displayName = 'BreadcrumbSeparator';

export {
  Breadcrumb,
  BreadcrumbList,
  BreadcrumbItem,
  BreadcrumbButton,
  BreadcrumbLink,
  BreadcrumbPage,
  BreadcrumbSeparator,
  breadcrumbButtonVariants,
};
