/**
 * Imperative async replacement for the browser's blocking `confirm()` /
 * `alert()`, rendered with the shadcn AlertDialog so it matches the design
 * system and is non-blocking.
 *
 *   if (!(await confirmDialog({ body: '确认删除?', danger: true }))) return;
 *   await alertDialog({ body: '保存失败' });
 *
 * A single <DialogHost /> (mounted in App) subscribes to a module-level queue.
 * This is plain UI plumbing — it carries no tool/surface semantics, so it does
 * not touch the dual-modality path.
 */
import { useEffect, useState, type ReactNode } from 'react'
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogAction,
  AlertDialogCancel,
} from '@/components/ui/alert-dialog'

export interface ConfirmOptions {
  title?: string
  body?: ReactNode
  confirmText?: string
  cancelText?: string
  /** Style the confirm button as destructive. */
  danger?: boolean
}

export interface AlertOptions {
  title?: string
  body?: ReactNode
  okText?: string
}

interface DialogRequest {
  id: number
  kind: 'confirm' | 'alert'
  options: ConfirmOptions & AlertOptions
  resolve: (value: boolean) => void
}

let queue: DialogRequest[] = []
let seq = 0
const listeners = new Set<(reqs: DialogRequest[]) => void>()

function emit(): void {
  const snapshot = queue.slice()
  listeners.forEach((l) => l(snapshot))
}

function resolveRequest(id: number, value: boolean): void {
  const req = queue.find((r) => r.id === id)
  if (!req) return
  queue = queue.filter((r) => r.id !== id)
  req.resolve(value)
  emit()
}

export function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    queue.push({ id: ++seq, kind: 'confirm', options, resolve })
    emit()
  })
}

export function alertDialog(options: AlertOptions = {}): Promise<void> {
  return new Promise<void>((resolve) => {
    queue.push({ id: ++seq, kind: 'alert', options, resolve: () => resolve() })
    emit()
  })
}

export function DialogHost(): React.ReactElement | null {
  const [reqs, setReqs] = useState<DialogRequest[]>(queue)

  useEffect(() => {
    const listener = (next: DialogRequest[]) => setReqs(next)
    listeners.add(listener)
    listener(queue.slice())
    return () => {
      listeners.delete(listener)
    }
  }, [])

  const head = reqs[0]
  if (!head) return null

  const isConfirm = head.kind === 'confirm'

  return (
    <AlertDialog
      open
      onOpenChange={(open) => {
        // Dismiss == false for confirm, resolve for alert.
        if (!open) resolveRequest(head.id, false)
      }}
    >
      <AlertDialogContent>
        {(head.options.title || head.options.body) && (
          <AlertDialogHeader>
            {head.options.title && (
              <AlertDialogTitle>{head.options.title}</AlertDialogTitle>
            )}
            {head.options.body && (
              <AlertDialogDescription asChild className="whitespace-pre-line">
                <div>{head.options.body}</div>
              </AlertDialogDescription>
            )}
          </AlertDialogHeader>
        )}
        <AlertDialogFooter>
          {isConfirm && (
            <AlertDialogCancel onClick={() => resolveRequest(head.id, false)}>
              {head.options.cancelText ?? '取消'}
            </AlertDialogCancel>
          )}
          <AlertDialogAction
            autoFocus
            className={
              isConfirm && head.options.danger
                ? 'bg-destructive text-destructive-foreground hover:bg-destructive/90'
                : undefined
            }
            onClick={() => resolveRequest(head.id, true)}
          >
            {isConfirm ? head.options.confirmText ?? '确认' : head.options.okText ?? '好'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
