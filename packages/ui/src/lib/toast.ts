export type ToastType = 'message' | 'success' | 'error' | 'info' | 'warning' | 'loading';

export interface ToastOptions {
  description?: string;
  duration?: number;
  id?: string;
}

export interface ToastRecord {
  id: string;
  type: ToastType;
  title: string;
  description?: string;
}

type Listener = (toasts: ToastRecord[]) => void;

const DEFAULT_DURATION = 4000;
const listeners = new Set<Listener>();
const timers = new Map<string, ReturnType<typeof globalThis.setTimeout>>();
let records: ToastRecord[] = [];
let nextId = 1;

function emit(): void {
  const snapshot = records;
  for (const listener of listeners) listener(snapshot);
}

function scheduleDismiss(id: string, duration: number | undefined): void {
  const existing = timers.get(id);
  if (existing !== undefined) globalThis.clearTimeout(existing);
  timers.delete(id);
  if (duration === Infinity) return;
  const timer = globalThis.setTimeout(() => {
    timers.delete(id);
    dismissToast(id);
  }, duration ?? DEFAULT_DURATION);
  timers.set(id, timer);
}

function pushToast(type: ToastType, title: string, options: ToastOptions = {}): string {
  const id = options.id ?? `toast-${nextId++}`;
  const next: ToastRecord = { id, type, title, description: options.description };
  records = [next, ...records.filter((item) => item.id !== id)].slice(0, 5);
  emit();
  scheduleDismiss(id, options.duration);
  return id;
}

export function subscribeToasts(listener: Listener): () => void {
  listeners.add(listener);
  listener(records);
  return () => {
    listeners.delete(listener);
  };
}

export function dismissToast(id?: string): void {
  if (id === undefined) {
    for (const timer of timers.values()) globalThis.clearTimeout(timer);
    timers.clear();
  } else {
    const timer = timers.get(id);
    if (timer !== undefined) globalThis.clearTimeout(timer);
    timers.delete(id);
  }
  records = id === undefined ? [] : records.filter((item) => item.id !== id);
  emit();
}

export const toast = Object.assign(
  (title: string, options?: ToastOptions) => pushToast('message', title, options),
  {
    message: (title: string, options?: ToastOptions) => pushToast('message', title, options),
    success: (title: string, options?: ToastOptions) => pushToast('success', title, options),
    error: (title: string, options?: ToastOptions) => pushToast('error', title, options),
    info: (title: string, options?: ToastOptions) => pushToast('info', title, options),
    warning: (title: string, options?: ToastOptions) => pushToast('warning', title, options),
    loading: (title: string, options?: ToastOptions) => pushToast('loading', title, { ...options, duration: options?.duration ?? Infinity }),
    dismiss: dismissToast,
  },
);
