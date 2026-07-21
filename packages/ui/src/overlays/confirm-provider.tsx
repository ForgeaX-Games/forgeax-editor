import * as React from 'react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../components/alert-dialog';
import { buttonVariants } from '../components/button';
import { cn } from '../lib/utils';
import { setConfirmDispatcher, type ConfirmOptions } from '../lib/confirm';

interface ConfirmRequest {
  id: number;
  options: ConfirmOptions;
  resolve: (value: boolean) => void;
}

let nextConfirmId = 1;

export function ConfirmProvider({ children }: { children: React.ReactNode }) {
  const [queue, setQueue] = React.useState<ConfirmRequest[]>([]);
  const queueRef = React.useRef<ConfirmRequest[]>([]);
  const active = queue[0] ?? null;

  React.useEffect(() => {
    queueRef.current = queue;
  }, [queue]);

  React.useEffect(() => {
    const cleanupDispatcher = setConfirmDispatcher((options) =>
      new Promise<boolean>((resolve) => {
        setQueue((current) => [...current, { id: nextConfirmId++, options, resolve }]);
      }),
    );

    return () => {
      cleanupDispatcher();
      for (const request of queueRef.current) request.resolve(false);
      queueRef.current = [];
    };
  }, []);

  const finish = React.useCallback((value: boolean) => {
    setQueue((current) => {
      const [head, ...rest] = current;
      head?.resolve(value);
      return rest;
    });
  }, []);

  return (
    <>
      {children}
      <AlertDialog open={active !== null}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{active?.options.title}</AlertDialogTitle>
            {active?.options.description !== undefined && (
              <AlertDialogDescription>{active.options.description}</AlertDialogDescription>
            )}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => finish(false)}>
              {active?.options.cancelText ?? 'Cancel'}
            </AlertDialogCancel>
            <AlertDialogAction
              className={cn(active?.options.destructive && buttonVariants({ variant: 'destructive' }))}
              onClick={() => finish(true)}
            >
              {active?.options.confirmText ?? 'Continue'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
