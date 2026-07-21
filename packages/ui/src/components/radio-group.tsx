import * as React from 'react';
import { Circle } from 'lucide-react';
import { cva } from 'class-variance-authority';
import { cn } from '../lib/utils';

interface RadioGroupContextValue {
  value?: string;
  onValueChange?: (value: string) => void;
  disabled?: boolean;
}

const RadioGroupContext = React.createContext<RadioGroupContextValue | null>(null);

export interface RadioGroupProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'onChange'> {
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  disabled?: boolean;
}

const RadioGroup = React.forwardRef<HTMLDivElement, RadioGroupProps>(
  ({ className, value, defaultValue, onValueChange, disabled, ...props }, ref) => {
    const [uncontrolled, setUncontrolled] = React.useState(defaultValue);
    const current = value ?? uncontrolled;
    const context = React.useMemo<RadioGroupContextValue>(() => ({
      value: current,
      disabled,
      onValueChange: (next) => {
        if (value === undefined) setUncontrolled(next);
        onValueChange?.(next);
      },
    }), [current, disabled, onValueChange, value]);

    return (
      <RadioGroupContext.Provider value={context}>
        <div ref={ref} role="radiogroup" className={cn('grid gap-2', className)} {...props} />
      </RadioGroupContext.Provider>
    );
  },
);
RadioGroup.displayName = 'RadioGroup';

export interface RadioGroupItemProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'value'> {
  value: string;
  size?: 'sm' | 'default' | 'lg';
}

const radioGroupItemVariants = cva(
  'no-motion-lift inline-flex aspect-square cursor-pointer appearance-none items-center justify-center rounded-full border border-input bg-[var(--color-background-base)] text-primary shadow-sm transition-colors hover:border-[var(--color-border-strong)] focus:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:border-primary',
  {
    variants: {
      size: {
        default: 'h-4 w-4 [&_svg]:h-3.5 [&_svg]:w-3.5',
        sm: 'h-3.5 w-3.5 [&_svg]:h-3 [&_svg]:w-3',
        lg: 'h-5 w-5 [&_svg]:h-4 [&_svg]:w-4',
      },
    },
    defaultVariants: {
      size: 'default',
    },
  },
);

const RadioGroupItem = React.forwardRef<HTMLButtonElement, RadioGroupItemProps>(
  ({ className, value, disabled, onClick, size, ...props }, ref) => {
    const context = React.useContext(RadioGroupContext);
    const checked = context?.value === value;
    const isDisabled = disabled || context?.disabled;
    return (
      <button
        ref={ref}
        type="button"
        role="radio"
        aria-checked={checked}
        disabled={isDisabled}
        data-state={checked ? 'checked' : 'unchecked'}
        className={cn(radioGroupItemVariants({ size }), className)}
        onClick={(event) => {
          onClick?.(event);
          if (!event.defaultPrevented && !isDisabled) context?.onValueChange?.(value);
        }}
        {...props}
      >
        {checked && <Circle className="fill-primary" />}
      </button>
    );
  },
);
RadioGroupItem.displayName = 'RadioGroupItem';

export { RadioGroup, RadioGroupItem, radioGroupItemVariants };
