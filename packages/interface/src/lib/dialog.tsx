/**
 * Imperative async replacement for the browser's blocking `confirm()` /
 * `alert()`, rendered with the shadcn AlertDialog so it matches the design
 * system and is non-blocking.
 *
 *   if (!(await confirmDialog({ body: '确认删除?', danger: true }))) return;
 *   await alertDialog({ body: '保存失败' });
 *   const decision = await unsavedChangesDialog({ body: '…' });
 *
 * A single <DialogHost /> (mounted in App) subscribes to a module-level queue.
 * This is plain UI plumbing — it carries no tool/surface semantics, so it does
 * not touch the dual-modality path.
 */
import { useEffect, useState, type ReactNode } from 'react'
import { useTranslation } from '@/i18n'
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

export type UnsavedChangesDecision = 'save' | 'discard' | 'cancel'

export interface UnsavedChangesOptions {
  title?: string
  body?: ReactNode
  saveText?: string
  discardText?: string
  cancelText?: string
}

interface ConfirmAlertRequest {
  id: number
  kind: 'confirm' | 'alert'
  options: ConfirmOptions & AlertOptions
  resolve: (value: boolean) => void
}

interface UnsavedRequest {
  id: number
  kind: 'unsaved'
  options: UnsavedChangesOptions
  resolve: (value: UnsavedChangesDecision) => void
}

type DialogRequest = ConfirmAlertRequest | UnsavedRequest

let queue: DialogRequest[] = []
let seq = 0
const listeners = new Set<(reqs: DialogRequest[]) => void>()

function emit(): void {
  const snapshot = queue.slice()
  listeners.forEach((l) => l(snapshot))
}

function takeRequest(id: number): DialogRequest | undefined {
  const req = queue.find((r) => r.id === id)
  if (!req) return undefined
  queue = queue.filter((r) => r.id !== id)
  emit()
  return req
}

function resolveConfirmAlert(id: number, value: boolean): void {
  const req = takeRequest(id)
  if (!req || req.kind === 'unsaved') return
  req.resolve(value)
}

function resolveUnsaved(id: number, value: UnsavedChangesDecision): void {
  const req = takeRequest(id)
  if (!req || req.kind !== 'unsaved') return
  req.resolve(value)
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

export function unsavedChangesDialog(options: UnsavedChangesOptions = {}): Promise<UnsavedChangesDecision> {
  return new Promise<UnsavedChangesDecision>((resolve) => {
    queue.push({ id: ++seq, kind: 'unsaved', options, resolve })
    emit()
  })
}

export function DialogHost(): React.ReactElement | null {
  const { t } = useTranslation()
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
  const isUnsaved = head.kind === 'unsaved'

  return (
    <AlertDialog
      open
      onOpenChange={(open) => {
        if (!open) {
          if (isUnsaved) resolveUnsaved(head.id, 'cancel')
          else resolveConfirmAlert(head.id, false)
        }
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          {/* Radix requires an AlertDialogTitle inside AlertDialogContent for
              screen-reader a11y (else it console.errors). Most confirm/alert
              calls pass only a body, so when there's no visible title render an
              sr-only fallback title — satisfies a11y with no visual change. */}
          {head.options.title ? (
            <AlertDialogTitle>{head.options.title}</AlertDialogTitle>
          ) : (
            <AlertDialogTitle className="sr-only">
              {isUnsaved
                ? t('dialog.unsavedTitle')
                : isConfirm
                  ? t('dialog.confirmActionTitle')
                  : t('dialog.alertTitle')}
            </AlertDialogTitle>
          )}
          {head.options.body && (
            // Body is the primary message here (most confirm/alert calls pass
            // no title), so use full foreground instead of the muted default —
            // muted-foreground (60% opacity) reads as illegible grey-on-dark.
            <AlertDialogDescription
              asChild
              className="whitespace-pre-line text-foreground"
            >
              <div>{head.options.body}</div>
            </AlertDialogDescription>
          )}
        </AlertDialogHeader>
        <AlertDialogFooter>
          {isUnsaved ? (
            <>
              <AlertDialogCancel onClick={() => resolveUnsaved(head.id, 'cancel')}>
                {head.options.cancelText ?? t('common.cancel')}
              </AlertDialogCancel>
              <AlertDialogAction
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                onClick={() => resolveUnsaved(head.id, 'discard')}
              >
                {head.options.discardText ?? t('dialog.discardChanges')}
              </AlertDialogAction>
              <AlertDialogAction autoFocus onClick={() => resolveUnsaved(head.id, 'save')}>
                {head.options.saveText ?? t('common.save')}
              </AlertDialogAction>
            </>
          ) : (
            <>
              {isConfirm && (
                <AlertDialogCancel onClick={() => resolveConfirmAlert(head.id, false)}>
                  {head.options.cancelText ?? t('common.cancel')}
                </AlertDialogCancel>
              )}
              <AlertDialogAction
                autoFocus
                className={
                  isConfirm && head.options.danger
                    ? 'bg-destructive text-destructive-foreground hover:bg-destructive/90'
                    : undefined
                }
                onClick={() => resolveConfirmAlert(head.id, true)}
              >
                {isConfirm
                  ? head.options.confirmText ?? t('common.confirm')
                  : head.options.okText ?? t('common.ok')}
              </AlertDialogAction>
            </>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
