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
import {
  setDecisionDispatcher,
  type Decision,
  type DecisionOptions,
} from '../lib/decision';
import { cn } from '../lib/utils';

interface DecisionRequest {
  id: number;
  options: DecisionOptions;
  resolve: (value: Decision) => void;
}

let nextDecisionId = 1;

export function DecisionProvider({ children }: { children: React.ReactNode }) {
  const [queue, setQueue] = React.useState<DecisionRequest[]>([]);
  const queueRef = React.useRef<DecisionRequest[]>([]);
  const active = queue[0] ?? null;

  React.useEffect(() => {
    queueRef.current = queue;
  }, [queue]);

  React.useEffect(() => {
    const cleanupDispatcher = setDecisionDispatcher((options) =>
      new Promise<Decision>((resolve) => {
        setQueue((current) => [...current, { id: nextDecisionId++, options, resolve }]);
      }),
    );

    return () => {
      cleanupDispatcher();
      for (const request of queueRef.current) request.resolve('cancel');
      queueRef.current = [];
    };
  }, []);

  const finish = React.useCallback((value: Decision) => {
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
            <AlertDialogCancel onClick={() => finish('cancel')}>
              {active?.options.cancelText ?? 'Cancel'}
            </AlertDialogCancel>
            <AlertDialogAction
              className={cn(
                active?.options.secondaryDestructive
                && buttonVariants({ variant: 'destructive' }),
              )}
              onClick={() => finish('secondary')}
            >
              {active?.options.secondaryText}
            </AlertDialogAction>
            <AlertDialogAction
              className={cn(
                active?.options.primaryDestructive
                && buttonVariants({ variant: 'destructive' }),
              )}
              onClick={() => finish('primary')}
            >
              {active?.options.primaryText}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
