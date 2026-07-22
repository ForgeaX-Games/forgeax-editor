import * as React from 'react';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../lib/utils';

const TooltipProvider = TooltipPrimitive.Provider;
const Tooltip = TooltipPrimitive.Root;
const TooltipTrigger = TooltipPrimitive.Trigger;

const tooltipContentVariants = cva(
  'z-[var(--z-toplevel)] overflow-hidden rounded-[4px] border border-border bg-popover text-popover-foreground shadow-xl animate-in fade-in-0 zoom-in-95',
  {
    variants: {
      size: {
        default: 'px-3 py-1.5 text-xs',
        sm: 'px-2 py-1 text-[11px]',
        lg: 'px-3 py-2 text-xs',
      },
    },
    defaultVariants: {
      size: 'default',
    },
  },
);

const TooltipContent = React.forwardRef<
  React.ElementRef<typeof TooltipPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content> &
    VariantProps<typeof tooltipContentVariants>
>(({ className, sideOffset = 4, size, ...props }, ref) => (
  <TooltipPrimitive.Portal>
    <TooltipPrimitive.Content
      ref={ref}
      sideOffset={sideOffset}
      className={cn(tooltipContentVariants({ size }), className)}
      {...props}
    />
  </TooltipPrimitive.Portal>
));
TooltipContent.displayName = TooltipPrimitive.Content.displayName;

export interface TipProps
  extends VariantProps<typeof tooltipContentVariants> {
  /** Tooltip text. When empty/undefined the child renders bare (no tooltip) —
   *  mirrors how an empty native `title=""` shows nothing. */
  label?: React.ReactNode;
  /** The single element to anchor on. Must accept a ref + spread props
   *  (native span/button/div do), since it is the Radix `asChild` trigger. */
  children: React.ReactElement;
  side?: React.ComponentPropsWithoutRef<typeof TooltipContent>['side'];
  align?: React.ComponentPropsWithoutRef<typeof TooltipContent>['align'];
  sideOffset?: number;
  delayDuration?: number;
}

/**
 * One-layer tooltip. Radix ships tooltips as four composable primitives
 * (Provider / Root / Trigger / Portal+Content) — powerful but five lines of
 * boilerplate per hint. `Tip` collapses all of that so a call site is just
 * `<Tip label="…"><button/></Tip>`, the ergonomic replacement for the native
 * `title=` attribute across editor panels. The Provider lives inside so `Tip`
 * is fully self-contained (drop it anywhere, no ancestor required).
 */
export function Tip({
  label,
  children,
  side = 'top',
  align = 'center',
  sideOffset = 6,
  size,
  delayDuration = 350,
}: TipProps): React.ReactElement {
  if (label === undefined || label === null || label === '') return children;
  return (
    <TooltipProvider delayDuration={delayDuration} skipDelayDuration={100}>
      <Tooltip>
        <TooltipTrigger asChild>{children}</TooltipTrigger>
        <TooltipContent side={side} align={align} sideOffset={sideOffset} size={size}>
          {label}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider };
