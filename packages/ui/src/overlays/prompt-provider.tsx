import * as React from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../components/dialog';
import { Button } from '../components/button';
import { Input } from '../components/input';
import { Label } from '../components/label';
import { Textarea } from '../components/textarea';
import { setPromptDispatcher, type PromptOptions } from '../lib/prompt';

interface PromptRequest {
  id: number;
  options: PromptOptions;
  resolve: (value: string | null) => void;
}

let nextPromptId = 1;

export function PromptProvider({ children }: { children: React.ReactNode }) {
  const [queue, setQueue] = React.useState<PromptRequest[]>([]);
  const queueRef = React.useRef<PromptRequest[]>([]);
  const active = queue[0] ?? null;
  const [value, setValue] = React.useState('');

  // Live validation of the current input against active.options.validate.
  // `error` is the inline message text (null when the input is legal). Submit
  // is disabled while error !== null (Enter is also a no-op via the guard in
  // `submit`). The validator is opt-in per prompt — legacy prompts without a
  // `validate` callback continue to accept any input.
  const error = React.useMemo<string | null>(() => {
    if (!active?.options.validate) return null;
    try {
      return active.options.validate(value);
    } catch (e) {
      // A throwing validator is a caller bug; surface it inline instead of
      // crashing the dialog. The prompt still resolves normally via Cancel.
      return `validate() threw: ${(e as Error)?.message ?? 'unknown error'}`;
    }
  }, [active, value]);

  React.useEffect(() => {
    queueRef.current = queue;
  }, [queue]);

  React.useEffect(() => {
    const cleanupDispatcher = setPromptDispatcher((options) =>
      new Promise<string | null>((resolve) => {
        setQueue((current) => [...current, { id: nextPromptId++, options, resolve }]);
      }),
    );

    return () => {
      cleanupDispatcher();
      for (const request of queueRef.current) request.resolve(null);
      queueRef.current = [];
    };
  }, []);

  React.useEffect(() => {
    setValue(active?.options.defaultValue ?? '');
  }, [active?.id, active?.options.defaultValue]);

  const finish = React.useCallback((result: string | null) => {
    setQueue((current) => {
      const [head, ...rest] = current;
      head?.resolve(result);
      return rest;
    });
  }, []);

  const submit = React.useCallback(() => {
    // Guard: while the validator reports an error, submit (button OR Enter) is
    // a no-op so an illegal value never reaches the caller.
    if (error !== null) return;
    finish(value);
  }, [finish, value, error]);

  return (
    <>
      {children}
      <Dialog open={active !== null} onOpenChange={(open) => { if (!open) finish(null); }}>
        <DialogContent>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              submit();
            }}
          >
            <DialogHeader>
              <DialogTitle>{active?.options.title}</DialogTitle>
              {active?.options.description !== undefined && (
                <DialogDescription>{active.options.description}</DialogDescription>
              )}
            </DialogHeader>
            <div className="my-4 grid gap-2">
              {active?.options.label !== undefined && <Label htmlFor="editor-ui-prompt-input">{active.options.label}</Label>}
              {active?.options.multiline ? (
                <Textarea
                  id="editor-ui-prompt-input"
                  autoFocus
                  value={value}
                  placeholder={active.options.placeholder}
                  onChange={(event) => setValue(event.target.value)}
                  aria-invalid={error !== null || undefined}
                  aria-describedby={error !== null ? 'editor-ui-prompt-error' : undefined}
                />
              ) : (
                <Input
                  id="editor-ui-prompt-input"
                  autoFocus
                  value={value}
                  placeholder={active?.options.placeholder}
                  onChange={(event) => setValue(event.target.value)}
                  aria-invalid={error !== null || undefined}
                  aria-describedby={error !== null ? 'editor-ui-prompt-error' : undefined}
                />
              )}
              {error !== null && (
                <p
                  id="editor-ui-prompt-error"
                  role="alert"
                  className="text-sm text-destructive"
                >
                  {error}
                </p>
              )}
            </div>
            <DialogFooter>
              <Button type="button" variant="subtle" onClick={() => finish(null)}>
                {active?.options.cancelText ?? 'Cancel'}
              </Button>
              <Button type="submit" disabled={error !== null}>
                {active?.options.confirmText ?? 'OK'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
