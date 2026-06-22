// Ambient declarations for node:* modules used by dawn tests that read the
// hello-triangle compiled shader manifest at runtime. The runtime package's
// tsconfig does not enable @types/node (production target is browser); these
// minimal shims keep tsc green for the 3 shadow dawn test files only.
//
// Used by:
// - shadow-m2.dawn.test.ts
// - shadow-m3.dawn.test.ts
// - shadow-m3-calibrate-run.dawn.test.ts

declare module 'node:fs' {
  export function readFileSync(path: string, encoding: string): string;
}

declare module 'node:path' {
  export function resolve(...paths: string[]): string;
}

declare module 'node:url' {
  export function fileURLToPath(url: string | URL): string;
}
