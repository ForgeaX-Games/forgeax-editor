/**
 * Monotonic cancellation lease for the in-process editor boot.
 *
 * A Studio game switch can unmount one viewport while its async boot is still
 * waiting on physics, WebGPU, or the scoped catalog. Only the latest lease may
 * install global editor operations and teardown handlers.
 */
export interface BootLease {
  begin(): number;
  invalidate(): void;
  isCurrent(id: number): boolean;
}

export function createBootLease(): BootLease {
  let latest = 0;
  return {
    begin: () => {
      latest += 1;
      return latest;
    },
    invalidate: () => {
      latest += 1;
    },
    isCurrent: (id) => id === latest,
  };
}
