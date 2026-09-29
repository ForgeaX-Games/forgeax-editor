import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@forgeax/editor-ui/popover';
import { GitBranch } from 'lucide-react';
import type { ReactNode } from 'react';

export interface VersionControlPopoverProps {
  readonly children: ReactNode;
}

/** Editor-owned status item for the version-control product surface. */
export function VersionControlPopover({ children }: VersionControlPopoverProps) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="sb-chip is-button fx-strip-pop-btn fx-version-control-chip"
          title="Version control"
          aria-label="Version control"
        >
          <GitBranch size={12} aria-hidden="true" />
          <span>Version control</span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        className="fx-strip-pop fx-version-control-popover"
        side="top"
        align="center"
        sideOffset={6}
        collisionPadding={8}
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <div className="fx-version-control-popover-header">
          <span aria-hidden="true">◆</span>
          Version control
        </div>
        {children}
      </PopoverContent>
    </Popover>
  );
}
