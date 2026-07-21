import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../lib/utils';

const switchVariants = cva(
  'no-motion-lift peer inline-flex shrink-0 cursor-pointer appearance-none items-center rounded-full border border-input bg-[var(--color-background-base)] shadow-sm transition-colors hover:border-[var(--color-border-strong)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:border-primary data-[state=checked]:bg-primary data-[state=unchecked]:bg-[var(--color-background-base)]',
  {
    variants: {
      size: {
        default: 'h-5 w-9 p-0.5',
        sm: 'h-4 w-7 p-0.5',
        lg: 'h-6 w-11 p-0.5',
      },
    },
    defaultVariants: {
      size: 'default',
    },
  },
);

const switchThumbVariants = cva(
  'pointer-events-none block rounded-full bg-foreground shadow-lg ring-0 transition-transform data-[state=checked]:bg-primary-foreground data-[state=unchecked]:translate-x-0',
  {
    variants: {
      size: {
        default: 'h-3.5 w-3.5 data-[state=checked]:translate-x-4',
        sm: 'h-2.5 w-2.5 data-[state=checked]:translate-x-3',
        lg: 'h-[18px] w-[18px] data-[state=checked]:translate-x-5',
      },
    },
    defaultVariants: {
      size: 'default',
    },
  },
);

export interface SwitchProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'value' | 'onChange'>,
    VariantProps<typeof switchVariants> {
  checked?: boolean;
  defaultChecked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
}

const Switch = React.forwardRef<HTMLButtonElement, SwitchProps>(
  ({ className, checked, defaultChecked = false, onCheckedChange, disabled, onClick, size, ...props }, ref) => {
    const [uncontrolled, setUncontrolled] = React.useState(defaultChecked);
    const isChecked = checked ?? uncontrolled;
    return (
      <button
        ref={ref}
        type="button"
        role="switch"
        aria-checked={isChecked}
        disabled={disabled}
        data-state={isChecked ? 'checked' : 'unchecked'}
        className={cn(switchVariants({ size }), className)}
        onClick={(event) => {
          onClick?.(event);
          if (event.defaultPrevented || disabled) return;
          const next = !isChecked;
          if (checked === undefined) setUncontrolled(next);
          onCheckedChange?.(next);
        }}
        {...props}
      >
        <span
          data-state={isChecked ? 'checked' : 'unchecked'}
          className={cn(switchThumbVariants({ size }))}
        />
      </button>
    );
  },
);
Switch.displayName = 'Switch';

export { Switch };
