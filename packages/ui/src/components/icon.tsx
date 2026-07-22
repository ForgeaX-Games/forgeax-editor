import * as React from 'react';
import { cn } from '../lib/utils';
import { FORGEAX_ICONS, type ForgeaxIconName } from '../icons/registry';

export type { ForgeaxIconName } from '../icons/registry';

export interface ForgeaxIconProps extends Omit<React.SVGProps<SVGSVGElement>, 'name'> {
  /** Registry glyph name. Ignored when `raw` is given. */
  name?: ForgeaxIconName;
  /** Escape hatch: inner SVG markup for a one-off glyph not in the registry. */
  raw?: string;
  /** Pixel size for both width and height. Defaults to 16 (spec default). */
  size?: number;
  /** Stroke width. Defaults to 1.7 to match the interaction spec. */
  strokeWidth?: number;
}

// ForgeaxIcon — renders a registry (or raw) 24x24 stroke glyph at 1:1 with the
// interaction spec. Colour flows via `currentColor`, so set `color` (or a token
// class) on the icon or an ancestor. The inner markup is a static, hand-authored
// constant (never user input), so dangerouslySetInnerHTML is safe here.
export const ForgeaxIcon = React.forwardRef<SVGSVGElement, ForgeaxIconProps>(
  ({ name, raw, size = 16, strokeWidth = 1.7, className, ...props }, ref) => {
    const body = raw ?? (name ? FORGEAX_ICONS[name] : '');
    return (
      <svg
        ref={ref}
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden={props['aria-label'] ? undefined : true}
        className={cn('fx-icon shrink-0', className)}
        dangerouslySetInnerHTML={{ __html: body }}
        {...props}
      />
    );
  },
);
ForgeaxIcon.displayName = 'ForgeaxIcon';
