import * as React from 'react';
import { Button, type ButtonProps } from './button';
import { cn } from '../lib/utils';

export interface IconButtonProps extends Omit<ButtonProps, 'size'> {
  size?: 'sm' | 'default' | 'lg';
  'aria-label': string;
}

const iconButtonSize: Record<NonNullable<IconButtonProps['size']>, ButtonProps['size']> = {
  sm: 'iconSm',
  default: 'icon',
  lg: 'iconLg',
};

const IconButton = React.forwardRef<HTMLButtonElement, IconButtonProps>(
  ({ className, size = 'default', variant = 'ghost', children, ...props }, ref) => (
    <Button
      ref={ref}
      size={iconButtonSize[size]}
      variant={variant}
      className={cn('[&_svg]:size-4', className)}
      {...props}
    >
      {children}
    </Button>
  ),
);
IconButton.displayName = 'IconButton';

export { IconButton };
