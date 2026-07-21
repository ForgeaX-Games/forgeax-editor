import * as React from 'react';
import { X } from 'lucide-react';
import { dismissToast, subscribeToasts, type ToastRecord } from '../lib/toast';
import { cn } from '../lib/utils';
import { IconButton } from './icon-button';

export interface ToasterProps {
  className?: string;
}

function Toaster({ className }: ToasterProps) {
  const [toasts, setToasts] = React.useState<ToastRecord[]>([]);

  React.useEffect(() => subscribeToasts(setToasts), []);

  return (
    <div
      className={cn('pointer-events-none fixed bottom-4 right-4 z-[var(--z-toplevel)] flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2', className)}
      aria-live="polite"
      aria-relevant="additions text"
    >
      {toasts.map((item) => (
        <div
          key={item.id}
          className={cn(
            'pointer-events-auto rounded-md border border-border bg-popover p-3 text-sm text-popover-foreground shadow-xl',
            item.type === 'error' && 'border-destructive/50',
            item.type === 'success' && 'border-primary/40',
          )}
          role={item.type === 'error' ? 'alert' : 'status'}
        >
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <div className="font-medium">{item.title}</div>
              {item.description !== undefined && (
                <div className="mt-1 text-xs text-muted-foreground">{item.description}</div>
              )}
            </div>
            <IconButton
              type="button"
              size="sm"
              variant="chrome"
              aria-label="Dismiss notification"
              onClick={() => dismissToast(item.id)}
            >
              <X className="h-3.5 w-3.5" aria-hidden="true" />
            </IconButton>
          </div>
        </div>
      ))}
    </div>
  );
}

export { Toaster };
